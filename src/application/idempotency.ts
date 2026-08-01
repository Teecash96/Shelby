import { createHash } from 'node:crypto';
import { ProofVaultError } from '../domain/errors.js';
import type { CollectionIndexPort, IdempotencyRecord } from '../ports/collection-index-port.js';

/**
 * Idempotency service (SECURITY.md replay/idempotency/concurrency).
 *
 * - The idempotency key is scoped to the authenticated caller.
 * - A request digest is computed over normalized metadata + artifact descriptors.
 * - Same key + same digest returns the original result (replay).
 * - Same key + different digest returns 409 IDEMPOTENCY_CONFLICT.
 * - A unique (caller_id, idempotency_key) constraint gives concurrent claims
 *   exactly one winner.
 * - Failed seals release the claim so the caller can retry.
 */

/** Idempotency-Key header: 16-128 printable ASCII characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{16,128}$/;

/**
 * Provisional digest stored on an in-flight idempotency claim before artifact
 * hashes are known. Replaced with the real request digest immediately after
 * streaming. A replay that observes this value mid-flight is treated as a
 * stale claim (reconcile), never as a conflict.
 */
export const PROVISIONAL_DIGEST = 'provisional-digest-pending';

export function validateIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ProofVaultError(
      'VALIDATION_ERROR',
      'Idempotency-Key must be 16-128 printable ASCII characters.',
    );
  }
}

/**
 * Deterministic digest of a seal request: normalized metadata JSON + each
 * artifact's descriptor (sorted). This is what idempotent replay compares, not
 * the raw multipart bytes. File names and media types are included so an
 * otherwise byte-identical request cannot replay a response for different
 * user-visible metadata.
 */
export interface RequestArtifactDigest {
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export function computeRequestDigest(input: {
  name: string;
  expiresAt: string;
  metadata: Record<string, string>;
  artifacts?: RequestArtifactDigest[];
  /** Legacy compatibility for callers that only have hashes. */
  artifactSha256s?: string[];
}): string {
  const artifacts =
    input.artifacts ??
    (input.artifactSha256s ?? []).map((sha256) => ({
      filename: '',
      mediaType: '',
      size: 0,
      sha256,
    }));
  const canonicalArtifacts = artifacts
    .map((artifact) => ({
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
    }))
    .sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const canonical = JSON.stringify({
    name: input.name,
    expiresAt: input.expiresAt,
    metadata: Object.fromEntries(
      Object.entries(input.metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    artifacts: canonicalArtifacts,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface IdempotencyOutcome {
  /** Existing sealed collection for an exact replay. */
  replay?: { collectionId: string; receiptJson: string };
  /** True when this call won the claim and may proceed. */
  proceed: boolean;
  /** The claimed record (present when this call won). */
  claim?: IdempotencyRecord;
  /** Non-null when the caller must stop with a conflict. */
  conflict?: boolean;
  /**
   * True when another caller owns the claim and this caller must stream its
   * request anyway (provisional-digest flow); the caller's post-stream digest
   * comparison decides replay vs conflict. Never combined with proceed.
   * `winningCollectionId` is the collectionId stored on the claim row: the
   * single caller whose id matches it may beginSeal; everyone else must not.
   */
  pending?: boolean;
  winningCollectionId?: string;
}

/**
 * Claim the idempotency key for a caller. Exactly one caller wins the atomic
 * claim and proceeds; every other contender either replays the winner's sealed
 * result (same digest) or receives a conflict. Concurrent same-digest
 * contenders wait for the winner to seal so exactly one `proceed: true` is
 * ever returned for a key.
 */
export async function claimIdempotency(input: {
  index: CollectionIndexPort;
  callerId: string;
  idempotencyKey: string;
  requestDigest: string;
  collectionId: string;
  /** Bounded wait for a concurrent claim to resolve (default 5s). */
  waitMs?: number;
  pollIntervalMs?: number;
}): Promise<IdempotencyOutcome> {
  const {
    index,
    callerId,
    idempotencyKey,
    requestDigest,
    collectionId,
    waitMs = 5000,
    pollIntervalMs = 25,
  } = input;

  const existing = await index.getIdempotencyRecord(callerId, idempotencyKey);
  if (existing !== undefined) {
    const outcome = await resolveExistingClaim(
      index,
      callerId,
      idempotencyKey,
      requestDigest,
      existing,
    );
    if (outcome !== undefined) return outcome;
    // Existing claim is not sealed and not a conflict.
    if (isProvisionalDigest(requestDigest)) {
      // Provisional flow (seal service): stream anyway; the post-stream
      // digest comparison decides replay vs conflict. The stored claim row's
      // collectionId is the single winner allowed to beginSeal.
      return { proceed: false, pending: true, winningCollectionId: existing.collectionId };
    }
    return waitForResolution(
      index,
      callerId,
      idempotencyKey,
      requestDigest,
      waitMs,
      pollIntervalMs,
    );
  }

  const claim = await index.claimIdempotencyKey({
    callerId,
    idempotencyKey,
    requestDigest,
    collectionId,
  });
  if (claim === undefined) {
    return { proceed: false, conflict: true };
  }

  // The atomic insert decides the single winner: whoever's collectionId is
  // stored on the claim row.
  const won = claim.winningCollectionId === collectionId;
  if (won) {
    if (claim.requestDigest !== requestDigest && !isProvisionalDigest(claim.requestDigest)) {
      // This caller won the insert but the stored digest belongs to a
      // different (earlier) claim: treat as a conflict.
      return { proceed: false, conflict: true };
    }
    return { proceed: true, claim };
  }

  // Lost the atomic claim to a concurrent contender. Never proceed.
  const digestsDiffer =
    claim.requestDigest !== requestDigest &&
    !isProvisionalDigest(claim.requestDigest) &&
    !isProvisionalDigest(requestDigest);
  if (digestsDiffer) {
    return { proceed: false, conflict: true };
  }
  if (isProvisionalDigest(requestDigest)) {
    // Provisional flow: stream anyway; post-stream comparison decides. The
    // stored claim row's collectionId is the single winner allowed to
    // beginSeal.
    return { proceed: false, pending: true, winningCollectionId: claim.collectionId };
  }
  return waitForResolution(index, callerId, idempotencyKey, requestDigest, waitMs, pollIntervalMs);
}

/**
 * Evaluate an existing claim. Returns an outcome when the state is decisive;
 * undefined when the caller should wait for the claim to resolve.
 */
async function resolveExistingClaim(
  index: CollectionIndexPort,
  callerId: string,
  idempotencyKey: string,
  requestDigest: string,
  existing: IdempotencyRecord,
): Promise<IdempotencyOutcome | undefined> {
  const incomingIsProvisional = isProvisionalDigest(requestDigest);
  const sameDigest =
    existing.requestDigest === requestDigest || isProvisionalDigest(existing.requestDigest);
  if (sameDigest) {
    const sealed = await index.findSealedByIdempotencyKey(callerId, idempotencyKey);
    if (sealed !== undefined && sealed.collection.receiptJson !== null) {
      return {
        proceed: false,
        replay: {
          collectionId: sealed.collection.collectionId,
          receiptJson: sealed.collection.receiptJson,
        },
      };
    }
    // Claimed but not sealed: wait for the winner to finish.
    return undefined;
  }
  if (incomingIsProvisional) {
    // The incoming digest is provisional (seal service is mid-stream) and the
    // stored digest is real. Not a conflict: the caller must wait so the
    // post-stream digest comparison decides replay vs conflict.
    return undefined;
  }
  return { proceed: false, conflict: true };
}

/**
 * Wait for a concurrent claim to resolve into a sealed replay. Returns a
 * conflict when the wait expires or the resolved digest differs.
 */
async function waitForResolution(
  index: CollectionIndexPort,
  callerId: string,
  idempotencyKey: string,
  requestDigest: string,
  waitMs: number,
  pollIntervalMs: number,
): Promise<IdempotencyOutcome> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const sealed = await index.findSealedByIdempotencyKey(callerId, idempotencyKey);
    if (sealed !== undefined && sealed.collection.receiptJson !== null) {
      if (sealed.collection.requestDigest === requestDigest) {
        return {
          proceed: false,
          replay: {
            collectionId: sealed.collection.collectionId,
            receiptJson: sealed.collection.receiptJson,
          },
        };
      }
      return { proceed: false, conflict: true };
    }
    const record = await index.getIdempotencyRecord(callerId, idempotencyKey);
    if (record === undefined) {
      // Claim released (failed seal): the key is free; re-claim.
      return reClaim(index, callerId, idempotencyKey, requestDigest);
    }
    if (record.requestDigest !== requestDigest && !isProvisionalDigest(record.requestDigest)) {
      return { proceed: false, conflict: true };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { proceed: false, conflict: true };
}

/** Re-claim after a release; this caller now races for the free key. */
async function reClaim(
  index: CollectionIndexPort,
  callerId: string,
  idempotencyKey: string,
  requestDigest: string,
): Promise<IdempotencyOutcome> {
  const collectionId = `col_reclaim_${Date.now().toString(36)}`;
  const claim = await index.claimIdempotencyKey({
    callerId,
    idempotencyKey,
    requestDigest,
    collectionId,
  });
  if (claim === undefined) return { proceed: false, conflict: true };
  const won = claim.winningCollectionId === collectionId;
  if (won) return { proceed: true, claim };
  return waitForResolution(index, callerId, idempotencyKey, requestDigest, 5000, 25);
}

function isProvisionalDigest(digest: string): boolean {
  return digest === PROVISIONAL_DIGEST;
}

/**
 * Complete a successful seal: persist the receipt and mark the collection
 * sealed. Returns the sealed snapshot for the response.
 */
export async function commitSeal(input: {
  index: CollectionIndexPort;
  collectionId: string;
  receiptJson: string;
}): Promise<void> {
  const ok = await input.index.markSealed(input.collectionId, input.receiptJson);
  if (!ok) {
    throw new ProofVaultError(
      'INTERNAL_ERROR',
      'Seal completion failed: collection not in a sealable state.',
    );
  }
}

/** Release the claim after a failed seal so the caller may retry. */
export async function abortSeal(input: {
  index: CollectionIndexPort;
  callerId: string;
  idempotencyKey: string;
  collectionId: string;
}): Promise<void> {
  await input.index.markFailed(input.collectionId);
  await input.index.releaseIdempotencyClaim(
    input.callerId,
    input.idempotencyKey,
    input.collectionId,
  );
}
