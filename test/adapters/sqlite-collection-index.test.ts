import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  SEED_CALLER_ID,
  SEED_KEY_HASH,
  SqliteCollectionIndex,
} from '../../src/adapters/sqlite-collection-index.js';
import type { ArtifactRecord, CallerRecord, CollectionRecord } from '../../src/ports/collection-index-port.js';

let dbFile = '';
let index: SqliteCollectionIndex;
let callerSeq = 0;
let artifactSeq = 0;

/** Unique key hash per caller so callers.key_hash UNIQUE holds across tests. */
function uniqueKeyHash(): string {
  callerSeq += 1;
  return `${callerSeq.toString(16).padStart(2, '0')}${'c'.repeat(62)}`;
}

/** Unique artifactId per artifact so artifacts.artifact_id UNIQUE holds. */
function uniqueArtifactId(): string {
  artifactSeq += 1;
  return `art_${artifactSeq.toString(16).padStart(4, '0')}${'a'.repeat(12)}`;
}

function makeCaller(overrides: Partial<CallerRecord> = {}): CallerRecord {
  return {
    callerId: 'caller_test_1',
    keyHash: uniqueKeyHash(),
    label: 'test caller',
    status: 'active',
    createdAt: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

function makeCollection(overrides: Partial<CollectionRecord> = {}): CollectionRecord {
  return {
    collectionId: 'col_1234567890abcdef',
    callerId: 'caller_test_1',
    name: 'Test bundle',
    status: 'receiving',
    createdAt: '2026-07-31T00:00:00.000Z',
    expiresAt: '2026-09-30T12:00:00.000Z',
    manifestSha256: 'a'.repeat(64),
    manifestKey: 'collections/col_1234567890abcdef/manifest.json',
    idempotencyKey: 'idem-test-key-1234',
    requestDigest: 'd'.repeat(64),
    artifactCount: 1,
    receiptJson: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: uniqueArtifactId(),
    collectionId: 'col_1234567890abcdef',
    filename: 'report.pdf',
    mediaType: 'application/pdf',
    size: 1234,
    sha256: 'b'.repeat(64),
    storageKey: 'cafe1234',
    providerRef: null,
    sha256Hex: 'b'.repeat(64),
    ...overrides,
  };
}

beforeAll(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), 'pv-index-')), 'index.db');
  index = SqliteCollectionIndex.open(`file:${dbFile}`);
});

afterAll(() => {
  index.close();
});

describe('SqliteCollectionIndex schema and migrations', () => {
  it('migrates to the latest schema version', async () => {
    const version = await index.migrate();
    expect(version).toBe(LATEST_SCHEMA_VERSION);
    expect(version).toBe(1);
  });

  it('migrate is deterministic and idempotent (runs twice, same version)', async () => {
    const first = await index.migrate();
    const second = await index.migrate();
    expect(first).toBe(second);
    expect(first).toBe(LATEST_SCHEMA_VERSION);
  });

  it('re-running migration does not duplicate seed data', async () => {
    await index.migrate();
    await index.migrate();
    const caller = await index.getCaller(SEED_CALLER_ID);
    expect(caller).toBeDefined();
  });

  it('seeds the deterministic local development caller', async () => {
    const caller = await index.getCaller(SEED_CALLER_ID);
    expect(caller).toMatchObject({ callerId: SEED_CALLER_ID, status: 'active' });
    expect(caller?.keyHash).toBe(SEED_KEY_HASH);
  });

  it('rejects a database with a newer schema version', async () => {
    const future = join(mkdtempSync(join(tmpdir(), 'pv-index-future-')), 'future.db');
    // Create a valid v1 database first, then bump user_version past the
    // supported version using raw node:sqlite to simulate a future schema.
    const seeded = SqliteCollectionIndex.open(`file:${future}`);
    seeded.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(future);
    raw.exec('PRAGMA user_version = 99;');
    raw.close();

    // open() runs migrate() and throws synchronously on a newer schema.
    expect(() => SqliteCollectionIndex.open(`file:${future}`)).toThrow(/newer than supported/);
  });
});

describe('SqliteCollectionIndex callers', () => {
  it('finds a caller by key hash', async () => {
    const caller = await index.getCallerByKeyHash(SEED_KEY_HASH);
    expect(caller?.callerId).toBe(SEED_CALLER_ID);
  });

  it('returns undefined for an unknown key hash', async () => {
    expect(await index.getCallerByKeyHash('f'.repeat(64))).toBeUndefined();
  });

  it('upserts a caller idempotently', async () => {
    await index.upsertCaller(makeCaller());
    await index.upsertCaller(makeCaller({ label: 'renamed' }));
    const caller = await index.getCaller('caller_test_1');
    expect(caller?.label).toBe('renamed');
  });

  it('revokes a caller', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_revoke_1' }));
    const revoked = await index.revokeCaller('caller_revoke_1');
    expect(revoked).toBe(true);
    const caller = await index.getCaller('caller_revoke_1');
    expect(caller?.status).toBe('revoked');
  });

  it('revoking twice returns false the second time', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_revoke_2' }));
    await index.revokeCaller('caller_revoke_2');
    await expect(index.revokeCaller('caller_revoke_2')).resolves.toBe(false);
  });
});

describe('SqliteCollectionIndex collections and artifacts', () => {
  it('begins a seal with its artifacts in one transaction', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_seal_1' }));
    const artifact = makeArtifact();
    const collection = makeCollection({ callerId: 'caller_seal_1' });
    await index.beginSeal({ collection, artifacts: [artifact] });
    const snapshot = await index.getCollection(collection.collectionId);
    expect(snapshot?.collection.status).toBe('receiving');
    expect(snapshot?.artifacts).toHaveLength(1);
    expect(snapshot?.artifacts[0]?.artifactId).toBe(artifact.artifactId);
  });

  it('rolls back the whole transaction when an artifact insert fails', async () => {
    const collection = makeCollection({ collectionId: 'col_2222222222222222' });
    // Duplicate artifactId within one collection violates artifacts.artifact_id UNIQUE.
    const duplicateId = uniqueArtifactId();
    const first = makeArtifact({ artifactId: duplicateId });
    const second = makeArtifact({ artifactId: duplicateId });
    await expect(
      index.beginSeal({ collection, artifacts: [first, second] }),
    ).rejects.toThrow();
    expect(index.getCollection(collection.collectionId)).toBeUndefined();
  });

  it('marks a collection sealed with a receipt', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_seal_2' }));
    const collection = makeCollection({
      collectionId: 'col_3333333333333333',
      callerId: 'caller_seal_2',
    });
    await index.beginSeal({ collection, artifacts: [makeArtifact({ collectionId: 'col_3333333333333333' })] });
    const receipt = JSON.stringify({ version: '1.0', collectionId: collection.collectionId });
    const ok = await index.markSealed(collection.collectionId, receipt);
    expect(ok).toBe(true);
    const snapshot = await index.getCollection(collection.collectionId);
    expect(snapshot?.collection.status).toBe('sealed');
    expect(snapshot?.collection.receiptJson).toBe(receipt);
  });

  it('marks a collection failed', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_seal_3' }));
    const collection = makeCollection({
      collectionId: 'col_4444444444444444',
      callerId: 'caller_seal_3',
    });
    await index.beginSeal({ collection, artifacts: [] });
    await index.markFailed(collection.collectionId);
    const snapshot = await index.getCollection(collection.collectionId);
    expect(snapshot?.collection.status).toBe('failed');
  });

  it('finds a sealed collection by caller + idempotency key', async () => {
    const snapshot = await index.findSealedByIdempotencyKey('caller_seal_2', 'idem-test-key-1234');
    expect(snapshot?.collection.collectionId).toBe('col_3333333333333333');
  });

  it('does not find non-sealed collections by idempotency key', async () => {
    expect(
      await index.findSealedByIdempotencyKey('caller_seal_1', 'idem-test-key-1234'),
    ).toBeUndefined();
  });
});

describe('SqliteCollectionIndex idempotency claims', () => {
  it('claims a key once and returns the same record on replay', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_idem_1' }));
    const first = await index.claimIdempotencyKey({
      callerId: 'caller_idem_1',
      idempotencyKey: 'idem-key-claim-0001',
      requestDigest: 'd1'.repeat(32),
      collectionId: 'col_5555555555555555',
    });
    expect(first?.requestDigest).toBe('d1'.repeat(32));
    const second = await index.claimIdempotencyKey({
      callerId: 'caller_idem_1',
      idempotencyKey: 'idem-key-claim-0001',
      requestDigest: 'd2'.repeat(32),
      collectionId: 'col_6666666666666666',
    });
    expect(second?.collectionId).toBe('col_5555555555555555');
    expect(second?.requestDigest).toBe('d1'.repeat(32));
  });

  it('keys are scoped per caller', async () => {
    await index.upsertCaller(makeCaller({ callerId: 'caller_idem_2' }));
    await index.claimIdempotencyKey({
      callerId: 'caller_idem_1',
      idempotencyKey: 'idem-key-scoped-0001',
      requestDigest: 'e'.repeat(64),
      collectionId: 'col_7777777777777777',
    });
    const other = await index.claimIdempotencyKey({
      callerId: 'caller_idem_2',
      idempotencyKey: 'idem-key-scoped-0001',
      requestDigest: 'e'.repeat(64),
      collectionId: 'col_8888888888888888',
    });
    expect(other?.collectionId).toBe('col_8888888888888888');
  });

  it('releases a claim so a key can be reused', async () => {
    await index.claimIdempotencyKey({
      callerId: 'caller_idem_1',
      idempotencyKey: 'idem-key-release-001',
      requestDigest: 'f'.repeat(64),
      collectionId: 'col_9999999999999999',
    });
    await index.releaseIdempotencyClaim('caller_idem_1', 'idem-key-release-001');
    const claim = await index.claimIdempotencyKey({
      callerId: 'caller_idem_1',
      idempotencyKey: 'idem-key-release-001',
      requestDigest: 'f'.repeat(64),
      collectionId: 'col_aaaaaaaaaaaaaaaa',
    });
    expect(claim?.collectionId).toBe('col_aaaaaaaaaaaaaaaa');
  });

  it('concurrent claims across connections have exactly one winner', async () => {
    // node:sqlite is synchronous per connection; two connections racing the
    // same key still hit the UNIQUE(caller_id, idempotency_key) constraint,
    // so exactly one INSERT OR IGNORE wins.
    const caller = makeCaller({ callerId: 'caller_idem_conc' });
    await index.upsertCaller(caller);
    const key = 'idem-key-concurrent-001';
    const digest = 'aa'.repeat(32);
    const winners: string[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (async () => {
          const conn = SqliteCollectionIndex.open(`file:${dbFile}`);
          try {
            const claim = await conn.claimIdempotencyKey({
              callerId: 'caller_idem_conc',
              idempotencyKey: key,
              requestDigest: `${digest.slice(0, 62)}${i.toString(16).padStart(2, '0')}`,
              collectionId: `col_${i.toString(16).padStart(16, '0')}`,
            });
            // The winner is the first claim; every other caller sees the
            // winner's record back (INSERT OR IGNORE semantics).
            if (claim?.collectionId === `col_${i.toString(16).padStart(16, '0')}`) {
              winners.push(claim.collectionId);
            }
          } finally {
            conn.close();
          }
        })(),
      ),
    );
    expect(winners).toHaveLength(1);
    const record = await index.getIdempotencyRecord('caller_idem_conc', key);
    expect(record?.collectionId).toBe(winners[0]);
  });
});
