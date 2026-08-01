import { createHash, randomUUID } from 'node:crypto';
import { canonicalManifestJson } from '../domain/manifest.js';
import type { Manifest, ManifestArtifact } from '../domain/manifest.js';
import type { Receipt } from '../domain/receipt.js';
import { ProofVaultError, ValidationError } from '../domain/errors.js';
import type { CollectionIndexPort, CollectionRecord } from '../ports/collection-index-port.js';
import type { StoragePort } from '../ports/storage-port.js';
import {
  claimIdempotency,
  commitSeal,
  computeRequestDigest,
  PROVISIONAL_DIGEST,
} from './idempotency.js';
import type { RequestArtifactDigest } from './idempotency.js';

/**
 * Structural view of a multipart part. The seal service consumes the parts
 * source lazily and streams each file body in order, so the multipart
 * iterator only advances as bytes are stored (true streaming; a whole upload
 * is never buffered).
 */
export interface SealMultipartPart {
  type: 'field' | 'file';
  fieldname: string;
  value?: string;
  filename?: string;
  mimetype?: string;
  file?: AsyncIterable<Uint8Array>;
}

export interface SealRequest {
  callerId: string;
  idempotencyKey: string;
  /** Lazy multipart parts: the collection field plus one source per file. */
  parts: AsyncIterable<SealMultipartPart>;
}

export interface SealResult {
  collectionId: string;
  status: 'sealed';
  replayed: boolean;
  receipt: Receipt;
  artifacts: Array<{
    artifactId: string;
    filename: string;
    size: number;
    mediaType: string;
    sha256: string;
  }>;
}

export interface SealLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxRequestBytes: number;
  minExpirationHours: number;
  maxExpirationDays: number;
}

export const DEFAULT_SEAL_LIMITS: SealLimits = {
  maxFiles: 20,
  maxFileBytes: 26214400,
  maxRequestBytes: 104857600,
  minExpirationHours: 1,
  maxExpirationDays: 365,
};

export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{16,128}$/;

function mergeSealLimits(overrides: Partial<SealLimits> | undefined): SealLimits {
  const limits = { ...DEFAULT_SEAL_LIMITS };
  if (overrides === undefined) return limits;
  for (const key of Object.keys(DEFAULT_SEAL_LIMITS) as Array<keyof SealLimits>) {
    const value = overrides[key];
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}

/** Media-type allowlist by top-level type (SECURITY.md: content-type is a claim). */
const MEDIA_TYPE_ALLOWLIST = [
  'application',
  'audio',
  'font',
  'image',
  'message',
  'model',
  'multipart',
  'text',
  'video',
];

interface SealDeps {
  index: CollectionIndexPort;
  storage: StoragePort;
  limits?: Partial<SealLimits>;
  now?: () => Date;
}

interface PendingSeal {
  name: string;
  expiresAt: string;
  metadata: Record<string, string>;
  artifacts: ManifestArtifact[];
  artifactDigests: RequestArtifactDigest[];
  totalBytes: number;
}

/**
 * Seal a collection (PRODUCT_SPEC flow 1). Consumes multipart parts lazily,
 * streaming every file through the storage adapter while hashing exact bytes,
 * then canonicalizes, hashes, and stores the manifest, and commits the sealed
 * index state.
 */
export async function sealCollection(request: SealRequest, deps: SealDeps): Promise<SealResult> {
  const limits = mergeSealLimits(deps.limits);
  validateIdempotencyKey(request.idempotencyKey);

  const collectionId = `col_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  // Provisional claim. The real request digest is only known after artifact
  // hashes are computed; it is stored on the claim right after streaming.
  const claim = await claimIdempotency({
    index: deps.index,
    callerId: request.callerId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: PROVISIONAL_DIGEST,
    collectionId,
  });

  if (claim.conflict === true) {
    throw new ProofVaultError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency-Key was already used with a different request.',
    );
  }
  // Note: claim.replay is intentionally NOT acted on here. The incoming
  // request digest is provisional until artifacts are hashed, so replay vs
  // conflict is decided by the post-stream digest comparison below.
  // The winner of the atomic claim is the request whose collectionId matches
  // the stored claim row; only it may beginSeal (avoids the UNIQUE race).
  const winningCollectionId =
    claim.claim?.winningCollectionId ?? claim.winningCollectionId ?? claim.claim?.collectionId;
  const iWonClaim = winningCollectionId === collectionId;

  const pending: PendingSeal = {
    name: '',
    expiresAt: '',
    metadata: {},
    artifacts: [],
    artifactDigests: [],
    totalBytes: 0,
  };
  const seenFilenames = new Set<string>();

  try {
    for await (const part of request.parts) {
      if (part.type === 'field' && part.fieldname === 'collection') {
        const parsed = parseCollectionField(part.value);
        pending.name = parsed.name;
        pending.expiresAt = parsed.expiresAt;
        pending.metadata = parsed.metadata;
        validateExpiration(pending.expiresAt, limits);
        continue;
      }
      if (part.type === 'file') {
        if (pending.artifacts.length >= limits.maxFiles) {
          throw new ProofVaultError(
            'VALIDATION_ERROR',
            `No more than ${limits.maxFiles} files per collection.`,
          );
        }
        if (part.filename === undefined || part.file === undefined) {
          throw new ValidationError('Invalid file part.', [
            { path: 'files', reason: 'missing filename or body' },
          ]);
        }
        const filename = validateFilename(part.filename, seenFilenames);
        const mediaType = part.mimetype ?? 'application/octet-stream';
        const topLevel = mediaType.split('/')[0];
        if (topLevel === undefined || !MEDIA_TYPE_ALLOWLIST.includes(topLevel)) {
          throw new ProofVaultError(
            'UNSUPPORTED_MEDIA_TYPE',
            `Unsupported media type: ${mediaType}`,
          );
        }
        const artifactId = `art_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const storageKey = `collections/${collectionId}/${artifactId}`;
        const { sha256, size } = await streamArtifact(deps.storage, {
          key: storageKey,
          body: part.file,
          limits,
          expiresAt: pending.expiresAt,
          idempotencyKey: request.idempotencyKey,
          currentTotal: pending.totalBytes,
        });
        pending.totalBytes += size;
        pending.artifactDigests.push({ filename, mediaType, size, sha256 });
        pending.artifacts.push({
          artifactId,
          filename,
          mediaType,
          size,
          sha256,
          storageKey,
        });
      }
    }

    validateComplete(pending, limits);

    const manifest: Manifest = {
      version: '1.0',
      collectionId,
      name: pending.name,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      expiresAt: pending.expiresAt,
      hashAlgorithm: 'sha256',
      metadata: pending.metadata,
      artifacts: pending.artifacts.slice().sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    };
    const manifestCanonical = canonicalManifestJson(manifest);
    const manifestSha256 = createHash('sha256').update(manifestCanonical, 'utf8').digest('hex');

    const manifestBytes = new TextEncoder().encode(manifestCanonical);
    await deps.storage.put({
      key: `collections/${collectionId}/manifest.json`,
      body: (async function* () {
        yield manifestBytes;
      })(),
      contentType: 'application/json',
      expiresAt: pending.expiresAt,
      idempotencyKey: request.idempotencyKey,
    });

    const requestDigest = computeRequestDigest({
      name: pending.name,
      expiresAt: pending.expiresAt,
      metadata: pending.metadata,
      artifacts: pending.artifactDigests,
    });

    // A sealed collection may have appeared while streaming (a concurrent seal
    // with the same key). Compare digests: identical -> replay, different -> 409.
    const sealedDuringStream = await deps.index.findSealedByIdempotencyKey(
      request.callerId,
      request.idempotencyKey,
    );
    if (sealedDuringStream !== undefined) {
      if (sealedDuringStream.collection.requestDigest === requestDigest) {
        return replayResult(sealedDuringStream);
      }
      throw new ProofVaultError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different request.',
      );
    }

    // Only the atomic claim winner may persist the collection. A loser that
    // reached this point raced the winner's commit; wait briefly for the winner
    // to seal (replay) or report a conflict. Without this gate, two same-key
    // requests both reach beginSeal and the UNIQUE(caller_id, idempotency_key)
    // constraint turns into a 500.
    if (!iWonClaim) {
      const winnerSealed = await waitForWinnerSeal(deps, request, requestDigest);
      if (winnerSealed !== undefined) return winnerSealed;
      throw new ProofVaultError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different request.',
      );
    }

    await deps.index.setIdempotencyDigest({
      callerId: request.callerId,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
    });

    const collection: CollectionRecord = {
      collectionId,
      callerId: request.callerId,
      name: pending.name,
      status: 'receiving',
      createdAt: manifest.createdAt,
      expiresAt: pending.expiresAt,
      manifestSha256,
      manifestKey: `collections/${collectionId}/manifest.json`,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      artifactCount: pending.artifacts.length,
      receiptJson: null,
    };

    const receipt: Receipt = {
      version: '1.0',
      collectionId,
      manifestKey: `collections/${collectionId}/manifest.json`,
      manifestSha256,
      expiresAt: pending.expiresAt,
    };

    await deps.index.beginSeal({
      collection,
      artifacts: pending.artifacts.map((a) => ({
        artifactId: a.artifactId,
        collectionId,
        filename: a.filename,
        mediaType: a.mediaType,
        size: a.size,
        sha256: a.sha256,
        storageKey: a.storageKey,
        providerRef: null,
        sha256Hex: a.sha256,
      })),
    });
    await commitSeal({ index: deps.index, collectionId, receiptJson: JSON.stringify(receipt) });

    return {
      collectionId,
      status: 'sealed',
      replayed: false,
      receipt,
      artifacts: pending.artifacts.map((a) => ({
        artifactId: a.artifactId,
        filename: a.filename,
        size: a.size,
        mediaType: a.mediaType,
        sha256: a.sha256,
      })),
    };
  } catch (error) {
    // Any failure after claiming the key leaves the collection unsealed. Mark
    // it failed and release only this request's claim; a concurrent loser must
    // never be able to delete the winner's claim.
    await deps.index.markFailed(collectionId).catch(() => undefined);
    await deps.index
      .releaseIdempotencyClaim(request.callerId, request.idempotencyKey, collectionId)
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Bounded wait for the atomic claim winner to seal the collection. Returns a
 * replay result when the winner sealed with the same digest, or undefined when
 * the wait expires (the caller should report a conflict).
 */
async function waitForWinnerSeal(
  deps: SealDeps,
  request: SealRequest,
  requestDigest: string,
): Promise<SealResult | undefined> {
  const deadline = Date.now() + 5000;
  const pollIntervalMs = 25;
  while (Date.now() < deadline) {
    const sealed = await deps.index.findSealedByIdempotencyKey(
      request.callerId,
      request.idempotencyKey,
    );
    if (sealed !== undefined && sealed.collection.receiptJson !== null) {
      if (sealed.collection.requestDigest === requestDigest) {
        return replayResult(sealed);
      }
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return undefined;
}

function replayResult(snapshot: {
  collection: { collectionId: string; receiptJson: string | null };
  artifacts: Array<{
    artifactId: string;
    filename: string;
    size: number;
    mediaType: string;
    sha256: string;
  }>;
}): SealResult {
  if (snapshot.collection.receiptJson === null) {
    throw new ProofVaultError('INTERNAL_ERROR', 'Sealed collection has no receipt.');
  }
  return {
    collectionId: snapshot.collection.collectionId,
    status: 'sealed',
    replayed: true,
    receipt: JSON.parse(snapshot.collection.receiptJson) as Receipt,
    artifacts: snapshot.artifacts.map((a) => ({
      artifactId: a.artifactId,
      filename: a.filename,
      size: a.size,
      mediaType: a.mediaType,
      sha256: a.sha256,
    })),
  };
}

function validateComplete(pending: PendingSeal, limits: SealLimits): void {
  if (pending.name === '' || pending.expiresAt === '') {
    throw new ValidationError('collection field is required.', [
      { path: 'collection', reason: 'required JSON string' },
    ]);
  }
  if (pending.name.length > 120) {
    throw new ValidationError('Collection name must be 1-120 characters.', [
      { path: 'name', reason: '1-120 characters' },
    ]);
  }
  if (pending.artifacts.length < 1) {
    throw new ValidationError('At least one file is required.', [
      { path: 'files', reason: 'At least one file is required.' },
    ]);
  }
  if (pending.totalBytes > limits.maxRequestBytes) {
    throw new ProofVaultError('REQUEST_TOO_LARGE', 'Request exceeds the total byte limit.');
  }
}

function parseCollectionField(value: string | undefined): {
  name: string;
  expiresAt: string;
  metadata: Record<string, string>;
} {
  if (value === undefined) {
    throw new ValidationError('collection field is required.', [
      { path: 'collection', reason: 'required JSON string' },
    ]);
  }
  let parsed: { name?: unknown; expiresAt?: unknown; metadata?: unknown };
  try {
    parsed = JSON.parse(value) as typeof parsed;
  } catch {
    throw new ValidationError('collection must be valid JSON.', [
      { path: 'collection', reason: 'invalid JSON' },
    ]);
  }
  if (typeof parsed.name !== 'string' || typeof parsed.expiresAt !== 'string') {
    throw new ValidationError('collection requires name and expiresAt.', [
      { path: 'collection', reason: 'name and expiresAt are required' },
    ]);
  }
  if (parsed.name.length < 1 || parsed.name.length > 120) {
    throw new ValidationError('Collection name must be 1-120 characters.', [
      { path: 'name', reason: '1-120 characters' },
    ]);
  }
  const metadata: Record<string, string> = {};
  if (parsed.metadata !== undefined) {
    if (
      typeof parsed.metadata !== 'object' ||
      parsed.metadata === null ||
      Array.isArray(parsed.metadata)
    ) {
      throw new ValidationError('metadata must be an object.', [
        { path: 'metadata', reason: 'object expected' },
      ]);
    }
    const entries = Object.entries(parsed.metadata as Record<string, unknown>);
    if (entries.length > 20) {
      throw new ValidationError('metadata must have at most 20 entries.', [
        { path: 'metadata', reason: 'no more than 20 keys' },
      ]);
    }
    for (const [key, item] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
        throw new ValidationError('metadata keys must match ^[A-Za-z0-9_.-]{1,64}$.', [
          { path: `metadata.${key}`, reason: 'invalid key' },
        ]);
      }
      if (typeof item !== 'string' || item.length > 500) {
        throw new ValidationError('metadata values must be strings of at most 500 characters.', [
          { path: `metadata.${key}`, reason: 'string of at most 500 characters expected' },
        ]);
      }
      metadata[key] = item;
    }
  }
  return { name: parsed.name, expiresAt: parsed.expiresAt, metadata };
}

function validateFilename(filename: string, seen: Set<string>): string {
  if (filename.length === 0 || filename.length > 255) {
    throw new ValidationError('Invalid filename.', [
      { path: 'files', reason: 'filename must be 1-255 characters' },
    ]);
  }
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\u0000')) {
    throw new ValidationError('Invalid filename.', [
      { path: 'files', reason: 'path separators are not allowed' },
    ]);
  }
  const normalized = filename.normalize('NFC').toLowerCase();
  if (seen.has(normalized)) {
    throw new ValidationError('Duplicate filename.', [
      { path: 'files', reason: `duplicate filename: ${filename}` },
    ]);
  }
  seen.add(normalized);
  return filename;
}

/** Stream one artifact into storage while hashing and enforcing live limits. */
async function streamArtifact(
  storage: StoragePort,
  input: {
    key: string;
    body: AsyncIterable<Uint8Array>;
    limits: SealLimits;
    expiresAt: string;
    idempotencyKey: string;
    currentTotal: number;
  },
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const limited = (async function* () {
    for await (const chunk of input.body) {
      size += chunk.byteLength;
      if (size > input.limits.maxFileBytes) {
        throw new ProofVaultError(
          'FILE_TOO_LARGE',
          `File exceeds the ${input.limits.maxFileBytes}-byte limit.`,
        );
      }
      if (input.currentTotal + size > input.limits.maxRequestBytes) {
        throw new ProofVaultError('REQUEST_TOO_LARGE', 'Request exceeds the total byte limit.');
      }
      hash.update(chunk);
      yield chunk;
    }
  })();
  await storage.put({
    key: input.key,
    body: limited,
    contentType: 'application/octet-stream',
    expiresAt: input.expiresAt,
    idempotencyKey: input.idempotencyKey,
  });
  return { sha256: hash.digest('hex'), size };
}

function validateExpiration(expiresAt: string, limits: SealLimits): void {
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) {
    throw new ValidationError('expiresAt must be an RFC 3339 UTC timestamp.', [
      { path: 'expiresAt', reason: 'invalid timestamp' },
    ]);
  }
  const now = Date.now();
  if (parsed - now < limits.minExpirationHours * 3600_000) {
    throw new ValidationError('expiresAt is too soon.', [
      { path: 'expiresAt', reason: `must be at least ${limits.minExpirationHours}h in the future` },
    ]);
  }
  if (parsed - now > limits.maxExpirationDays * 86_400_000) {
    throw new ValidationError('expiresAt is too far.', [
      { path: 'expiresAt', reason: `must be within ${limits.maxExpirationDays} days` },
    ]);
  }
}

export function validateIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ProofVaultError(
      'VALIDATION_ERROR',
      'Idempotency-Key must be 16-128 printable ASCII characters.',
    );
  }
}
