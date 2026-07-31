import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ArtifactRecord,
  CallerRecord,
  CollectionIndexPort,
  CollectionRecord,
  IdempotencyRecord,
  SealedCollectionSnapshot,
} from '../ports/collection-index-port.js';

/**
 * Versioned SQLite collection index (IMPLEMENTATION_PLAN.md Phase 3).
 *
 * - Schema version is tracked with `PRAGMA user_version`; migrations apply in
 *   order and are wrapped so a failed migration cannot leave a partial schema.
 * - Deterministic local seed data: a dev caller whose API key is
 *   `dev-local-key` (the one-way hash is stored; the plaintext lives only in
 *   the environment config, never in the database or the repository).
 * - WAL mode for concurrent readers; foreign keys enforced.
 * - Idempotency claims use a unique constraint on (caller_id, idempotency_key)
 *   so concurrent claims have exactly one winner.
 */
export const LATEST_SCHEMA_VERSION = 1;

export const SEED_CALLER_ID = 'caller_dev_local';
/** One-way SHA-256 hash of the plaintext `dev-local-key`. */
export const SEED_KEY_HASH = '3700285e3c8496a57e45eb1ccd43f2424852788576961320fbb31f86f17edb61';

interface CallerRow {
  caller_id: string;
  key_hash: string;
  label: string;
  status: 'active' | 'revoked';
  created_at: string;
}

interface CollectionRow {
  collection_id: string;
  caller_id: string;
  name: string;
  status: string;
  created_at: string;
  expires_at: string;
  manifest_sha256: string;
  manifest_key: string;
  idempotency_key: string;
  request_digest: string;
  artifact_count: number;
  receipt_json: string | null;
}

interface ArtifactRow {
  artifact_id: string;
  collection_id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  storage_key: string;
  provider_ref: string | null;
}

interface IdempotencyRow {
  caller_id: string;
  idempotency_key: string;
  request_digest: string;
  collection_id: string;
  created_at: string;
  replayed: number;
}

export class SqliteCollectionIndex implements CollectionIndexPort {
  private readonly db: DatabaseSync;

  private constructor(databaseUrl: string) {
    const file = databaseUrl.replace(/^file:/, '');
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
  }

  /** Open the database, run pending migrations, seed deterministic data. */
  static open(databaseUrl: string): SqliteCollectionIndex {
    const index = new SqliteCollectionIndex(databaseUrl);
    index.migrate();
    return index;
  }

  close(): void {
    this.db.close();
  }

  migrate(): number {
    const current = this.userVersion();
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `database schema version ${current} is newer than supported version ${LATEST_SCHEMA_VERSION}; refusing to run`,
      );
    }
    if (current < 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`
          CREATE TABLE callers (
            caller_id   TEXT PRIMARY KEY,
            key_hash    TEXT NOT NULL UNIQUE,
            label       TEXT NOT NULL,
            status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
            created_at  TEXT NOT NULL
          );

          CREATE TABLE collections (
            collection_id    TEXT PRIMARY KEY,
            caller_id        TEXT NOT NULL REFERENCES callers(caller_id),
            name             TEXT NOT NULL,
            status           TEXT NOT NULL,
            created_at       TEXT NOT NULL,
            expires_at       TEXT NOT NULL,
            manifest_sha256  TEXT NOT NULL,
            manifest_key     TEXT NOT NULL,
            idempotency_key  TEXT NOT NULL,
            request_digest   TEXT NOT NULL,
            artifact_count   INTEGER NOT NULL CHECK (artifact_count BETWEEN 1 AND 20),
            receipt_json     TEXT,
            UNIQUE (caller_id, idempotency_key)
          );

          CREATE INDEX idx_collections_caller ON collections(caller_id);

          CREATE TABLE artifacts (
            artifact_id   TEXT PRIMARY KEY,
            collection_id TEXT NOT NULL REFERENCES collections(collection_id),
            filename      TEXT NOT NULL,
            media_type    TEXT NOT NULL,
            size          INTEGER NOT NULL,
            sha256        TEXT NOT NULL,
            storage_key   TEXT NOT NULL,
            provider_ref  TEXT
          );

          CREATE INDEX idx_artifacts_collection ON artifacts(collection_id);

          CREATE TABLE idempotency (
            caller_id       TEXT NOT NULL REFERENCES callers(caller_id),
            idempotency_key TEXT NOT NULL,
            request_digest  TEXT NOT NULL,
            collection_id   TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            replayed        INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (caller_id, idempotency_key)
          );
        `);
        this.db.exec('PRAGMA user_version = 1;');
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.seed();
    return LATEST_SCHEMA_VERSION;
  }

  /** Deterministic local seed data; safe to run on every migrate. */
  private seed(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO callers (caller_id, key_hash, label, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .run(SEED_CALLER_ID, SEED_KEY_HASH, 'local development caller', new Date().toISOString());
  }

  getCallerByKeyHash(keyHash: string): CallerRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT caller_id, key_hash, label, status, created_at FROM callers WHERE key_hash = ?',
      )
      .get(keyHash) as CallerRow | undefined;
    return row === undefined ? undefined : toCaller(row);
  }

  getCaller(callerId: string): CallerRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT caller_id, key_hash, label, status, created_at FROM callers WHERE caller_id = ?',
      )
      .get(callerId) as CallerRow | undefined;
    return row === undefined ? undefined : toCaller(row);
  }

  async upsertCaller(caller: CallerRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO callers (caller_id, key_hash, label, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(caller_id) DO UPDATE SET
           key_hash = excluded.key_hash,
           label = excluded.label,
           status = excluded.status`,
      )
      .run(caller.callerId, caller.keyHash, caller.label, caller.status, caller.createdAt);
  }

  async revokeCaller(callerId: string): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE callers SET status = 'revoked' WHERE caller_id = ? AND status = 'active'")
      .run(callerId);
    return result.changes > 0;
  }

  async beginSeal(input: {
    collection: CollectionRecord;
    artifacts: ArtifactRecord[];
  }): Promise<void> {
    this.db.exec('BEGIN');
    try {
      const { collection, artifacts } = input;
      this.db
        .prepare(
          `INSERT INTO collections
             (collection_id, caller_id, name, status, created_at, expires_at,
              manifest_sha256, manifest_key, idempotency_key, request_digest,
              artifact_count, receipt_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          collection.collectionId,
          collection.callerId,
          collection.name,
          collection.status,
          collection.createdAt,
          collection.expiresAt,
          collection.manifestSha256,
          collection.manifestKey,
          collection.idempotencyKey,
          collection.requestDigest,
          collection.artifactCount,
        );
      const insertArtifact = this.db.prepare(
        `INSERT INTO artifacts
           (artifact_id, collection_id, filename, media_type, size, sha256, storage_key, provider_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const artifact of artifacts) {
        insertArtifact.run(
          artifact.artifactId,
          artifact.collectionId,
          artifact.filename,
          artifact.mediaType,
          artifact.size,
          artifact.sha256,
          artifact.storageKey,
          artifact.providerRef,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async markSealed(collectionId: string, receiptJson: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE collections
         SET status = 'sealed', receipt_json = ?
         WHERE collection_id = ? AND status IN ('receiving','storing_artifacts','storing_manifest')`,
      )
      .run(receiptJson, collectionId);
    return result.changes > 0;
  }

  async markFailed(collectionId: string): Promise<void> {
    this.db
      .prepare("UPDATE collections SET status = 'failed' WHERE collection_id = ?")
      .run(collectionId);
  }

  getCollection(collectionId: string): SealedCollectionSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM collections WHERE collection_id = ?')
      .get(collectionId) as CollectionRow | undefined;
    if (row === undefined) return undefined;
    const artifacts = this.db
      .prepare('SELECT * FROM artifacts WHERE collection_id = ?')
      .all(collectionId) as unknown as ArtifactRow[];
    return { collection: toCollection(row), artifacts: artifacts.map(toArtifact) };
  }

  findSealedByIdempotencyKey(
    callerId: string,
    idempotencyKey: string,
  ): SealedCollectionSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM collections
         WHERE caller_id = ? AND idempotency_key = ? AND status = 'sealed'`,
      )
      .get(callerId, idempotencyKey) as CollectionRow | undefined;
    if (row === undefined) return undefined;
    const artifacts = this.db
      .prepare('SELECT * FROM artifacts WHERE collection_id = ?')
      .all(row.collection_id) as unknown as ArtifactRow[];
    return { collection: toCollection(row), artifacts: artifacts.map(toArtifact) };
  }

  getIdempotencyRecord(callerId: string, idempotencyKey: string): IdempotencyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT caller_id, idempotency_key, request_digest, collection_id, created_at, replayed
         FROM idempotency WHERE caller_id = ? AND idempotency_key = ?`,
      )
      .get(callerId, idempotencyKey) as IdempotencyRow | undefined;
    return row === undefined ? undefined : toIdempotencyRecord(row);
  }

  async claimIdempotencyKey(input: {
    callerId: string;
    idempotencyKey: string;
    requestDigest: string;
    collectionId: string;
  }): Promise<IdempotencyRecord | undefined> {
    const existing = this.getIdempotencyRecord(input.callerId, input.idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency
           (caller_id, idempotency_key, request_digest, collection_id, created_at, replayed)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.callerId,
        input.idempotencyKey,
        input.requestDigest,
        input.collectionId,
        new Date().toISOString(),
      );
    return this.getIdempotencyRecord(input.callerId, input.idempotencyKey);
  }

  async releaseIdempotencyClaim(callerId: string, idempotencyKey: string): Promise<void> {
    this.db
      .prepare('DELETE FROM idempotency WHERE caller_id = ? AND idempotency_key = ?')
      .run(callerId, idempotencyKey);
  }

  async setIdempotencyDigest(input: {
    callerId: string;
    idempotencyKey: string;
    requestDigest: string;
  }): Promise<void> {
    this.db
      .prepare(
        'UPDATE idempotency SET request_digest = ? WHERE caller_id = ? AND idempotency_key = ?',
      )
      .run(input.requestDigest, input.callerId, input.idempotencyKey);
  }

  private userVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }
}

function toCaller(row: CallerRow): CallerRecord {
  return {
    callerId: row.caller_id,
    keyHash: row.key_hash,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toCollection(row: CollectionRow): CollectionRecord {
  return {
    collectionId: row.collection_id,
    callerId: row.caller_id,
    name: row.name,
    status: row.status as CollectionRecord['status'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    manifestSha256: row.manifest_sha256,
    manifestKey: row.manifest_key,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    artifactCount: row.artifact_count,
    receiptJson: row.receipt_json,
  };
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    collectionId: row.collection_id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    storageKey: row.storage_key,
    providerRef: row.provider_ref,
    sha256Hex: row.sha256,
  };
}

function toIdempotencyRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    callerId: row.caller_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    collectionId: row.collection_id,
    createdAt: row.created_at,
    replayed: row.replayed !== 0,
  };
}
