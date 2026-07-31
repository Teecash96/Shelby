import { createHash } from 'node:crypto';
import { ProofVaultError } from '../domain/errors.js';
import type { CollectionIndexPort, IdempotencyRecord } from '../ports/collection-index-port.js';

/**
 * Idempotency service (SECURITY.md replay/idempotency/concurrency).
 *
 * - The idempotency key is scoped to the authenticated caller.
 * - A request digest is computed over normalized metadata + artifact hashes.
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
 * artifact's sha256 (sorted). This is what idempotent replay compares, not
 * the raw multipart bytes.
 */
export function computeRequestDigest(input: {
  name: string;
  expiresAt: string;
  metadata: Record<string, string>;
  artifactSha256s: string[];
}): string {
  const canonical = JSON.stringify({
    name: input.name,
    expiresAt: input.expiresAt,
    metadata: Object.fromEntries(
      Object.entries(input.metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    artifactSha256s: [...input.artifactSha256s].sort(),
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
}

/**
 * Claim the idempotency key for a caller. One winner proceeds; an exact replay
 * returns the original sealed result; a same-key/different-digest replay is a
 * conflict.
 */
export async function claimIdempotency(input: {
  index: CollectionIndexPort;
  callerId: string;
  idempotencyKey: string;
  requestDigest: string;
  collectionId: string;
}): Promise<IdempotencyOutcome> {
  const { index, callerId, idempotencyKey, requestDigest, collectionId } = input;
  const existing = await index.getIdempotencyRecord(callerId, idempotencyKey);
  if (existing !== undefined) {
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
      // Same digest (or a provisional claim still streaming) but no sealed
      // collection: the earlier seal never completed. Reuse the claim's
      // collection id so reconciliation can finish it.
      return { proceed: true, claim: existing };
    }
    if (incomingIsProvisional) {
      // The incoming digest is provisional (seal service is mid-stream) and the
      // stored digest differs: the stored digest is real, so this is a replay
      // candidate whose digest the seal service confirms after streaming.
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
      // Stored digest is real but not sealed yet; let the stream proceed so the
      // post-stream check can compare the real digests.
      return { proceed: true, claim: existing };
    }
    return { proceed: false, conflict: true };
  }

  const claim = await index.claimIdempotencyKey({
    callerId,
    idempotencyKey,
    requestDigest,
    collectionId,
  });
  if (
    claim === undefined ||
    (claim.requestDigest !== requestDigest && !isProvisionalDigest(claim.requestDigest))
  ) {
    // Lost a concurrent claim to a different digest.
    return { proceed: false, conflict: true };
  }
  return { proceed: true, claim };
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
  await input.index.releaseIdempotencyClaim(input.callerId, input.idempotencyKey);
}
