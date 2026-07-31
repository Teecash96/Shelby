/**
 * Collection index port (ARCHITECTURE.md module boundaries). The index stores
 * ownership, receipt digest, manifest storage key, idempotency key, expiration,
 * status, and timestamps. Database rows are an index, never the artifact source
 * of truth.
 */

export const COLLECTION_STATUSES = [
  'receiving',
  'storing_artifacts',
  'storing_manifest',
  'sealed',
  'failed',
  'verifying',
  'verified',
  'incomplete',
  'invalid',
  'expired',
] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export interface CallerRecord {
  callerId: string;
  keyHash: string;
  label: string;
  status: 'active' | 'revoked';
  createdAt: string;
}

export interface CollectionRecord {
  collectionId: string;
  callerId: string;
  name: string;
  status: CollectionStatus;
  createdAt: string;
  expiresAt: string;
  /** SHA-256 of the canonical manifest. */
  manifestSha256: string;
  /** Storage key of the canonical manifest. */
  manifestKey: string;
  /** Unique idempotency key scoped to the caller. */
  idempotencyKey: string;
  /** SHA-256 of normalized request metadata + artifact hashes. */
  requestDigest: string;
  /** Number of artifacts declared for the collection. */
  artifactCount: number;
  /** Receipt JSON for idempotent replay; null when the collection is not sealed. */
  receiptJson: string | null;
}

export interface ArtifactRecord {
  artifactId: string;
  collectionId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  storageKey: string;
  providerRef: string | null;
  sha256Hex: string;
}

export interface IdempotencyRecord {
  callerId: string;
  idempotencyKey: string;
  requestDigest: string;
  collectionId: string;
  createdAt: string;
  replayed: boolean;
}

export interface SealedCollectionSnapshot {
  collection: CollectionRecord;
  artifacts: ArtifactRecord[];
}

export interface CollectionIndexPort {
  /** Migrate the schema to the latest version and seed deterministic data. */
  migrate(): number;

  /** Look up a caller by the one-way hash of its API key. */
  getCallerByKeyHash(keyHash: string): CallerRecord | undefined;

  /** Look up a caller by id. */
  getCaller(callerId: string): CallerRecord | undefined;

  /** Create a caller (idempotent by callerId). */
  upsertCaller(caller: CallerRecord): Promise<void>;

  /** Atomically mark a caller revoked. */
  revokeCaller(callerId: string): Promise<boolean>;

  /** Begin a seal: create the collection row and its artifacts in one transaction. */
  beginSeal(input: { collection: CollectionRecord; artifacts: ArtifactRecord[] }): Promise<void>;

  /** Mark a collection sealed with its receipt and final status. */
  markSealed(collectionId: string, receiptJson: string): Promise<boolean>;

  /** Mark a collection failed (partial uploads stay quarantined). */
  markFailed(collectionId: string): Promise<void>;

  /** Get a collection and its artifacts by id. */
  getCollection(collectionId: string): SealedCollectionSnapshot | undefined;

  /** Find a sealed collection by caller + idempotency key. */
  findSealedByIdempotencyKey(
    callerId: string,
    idempotencyKey: string,
  ): SealedCollectionSnapshot | undefined;

  /** Get the idempotency record by caller + key. */
  getIdempotencyRecord(callerId: string, idempotencyKey: string): IdempotencyRecord | undefined;

  /**
   * Atomically claim an idempotency key for a caller. Returns the existing
   * record when the key was already claimed (winning caller wins); otherwise
   * inserts the claim and returns undefined.
   */
  claimIdempotencyKey(input: {
    callerId: string;
    idempotencyKey: string;
    requestDigest: string;
    collectionId: string;
  }): Promise<IdempotencyRecord | undefined>;

  /**
   * Update the request digest of an in-flight claim once the sealed request
   * digest is known (artifact hashes are only available after streaming).
   */
  setIdempotencyDigest(input: {
    callerId: string;
    idempotencyKey: string;
    requestDigest: string;
  }): Promise<void>;

  /** Delete an abandoned claim (partial-failure recovery). */
  releaseIdempotencyClaim(callerId: string, idempotencyKey: string): Promise<void>;
}
