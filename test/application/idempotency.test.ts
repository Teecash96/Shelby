import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteCollectionIndex } from '../../src/adapters/sqlite-collection-index.js';
import {
  abortSeal,
  claimIdempotency,
  commitSeal,
  computeRequestDigest,
  validateIdempotencyKey,
} from '../../src/application/idempotency.js';
import type { ArtifactRecord, CollectionRecord } from '../../src/ports/collection-index-port.js';

let index: SqliteCollectionIndex;
const callerId = 'caller_idem_svc';
const idempotencyKey = 'idem-service-key-001';
let artifactSeq = 0;

/** Unique artifactId per collection so artifacts.artifact_id UNIQUE holds. */
function artifactFor(collectionId: string, seq: number = ++artifactSeq): ArtifactRecord {
  const artifactId = `art_${seq.toString(16).padStart(4, '0')}${'a'.repeat(12)}`;
  return {
    artifactId,
    collectionId,
    filename: 'a.txt',
    mediaType: 'text/plain',
    size: 4,
    sha256: 'b'.repeat(64),
    storageKey: 'deadbeef',
    providerRef: null,
    sha256Hex: 'b'.repeat(64),
  };
}

function collectionFor(collectionId: string): CollectionRecord {
  return {
    collectionId,
    callerId,
    name: 'Service test',
    status: 'receiving',
    createdAt: '2026-07-31T00:00:00.000Z',
    expiresAt: '2026-09-30T12:00:00.000Z',
    manifestSha256: 'a'.repeat(64),
    manifestKey: `collections/${collectionId}/manifest.json`,
    idempotencyKey,
    requestDigest: computeRequestDigest({
      name: 'Service test',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: { source: 'svc' },
      artifactSha256s: ['b'.repeat(64)],
    }),
    artifactCount: 1,
    receiptJson: null,
  };
}

const receipt = (collectionId: string) =>
  JSON.stringify({ version: '1.0', collectionId, manifestSha256: 'a'.repeat(64) });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pv-idem-svc-'));
  index = SqliteCollectionIndex.open(`file:${join(dir, 'idem.db')}`);
  await index.upsertCaller({
    callerId,
    keyHash: 'c'.repeat(64),
    label: 'service caller',
    status: 'active',
    createdAt: '2026-07-31T00:00:00.000Z',
  });
});

afterAll(() => index.close());

describe('validateIdempotencyKey', () => {
  it.each([
    ['too short', 'short'],
    ['too long', 'x'.repeat(129)],
    ['contains control char', `key${'\u0001'}key`],
    ['contains non-ASCII', 'këy-123456789012'],
  ])('rejects %s', (_label, key) => {
    expect(() => validateIdempotencyKey(key)).toThrow(/16-128 printable ASCII/);
  });

  it('accepts a valid 16-128 printable ASCII key', () => {
    expect(() => validateIdempotencyKey('valid-key-123456')).not.toThrow();
    expect(() => validateIdempotencyKey('x'.repeat(128))).not.toThrow();
  });
});

describe('computeRequestDigest', () => {
  it('is deterministic for the same normalized input', () => {
    const a = computeRequestDigest({
      name: 'X',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: { b: '2', a: '1' },
      artifactSha256s: ['z'.repeat(64), 'a'.repeat(64)],
    });
    const b = computeRequestDigest({
      name: 'X',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: { a: '1', b: '2' },
      artifactSha256s: ['a'.repeat(64), 'z'.repeat(64)],
    });
    expect(a).toBe(b);
  });

  it('differs when the artifact hashes differ', () => {
    const a = computeRequestDigest({
      name: 'X',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: {},
      artifactSha256s: ['a'.repeat(64)],
    });
    const b = computeRequestDigest({
      name: 'X',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: {},
      artifactSha256s: ['b'.repeat(64)],
    });
    expect(a).not.toBe(b);
  });

  it('differs when metadata values differ', () => {
    const a = computeRequestDigest({
      name: 'X',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: { runId: 'run_1' },
      artifactSha256s: ['a'.repeat(64)],
    });
    const b = computeRequestDigest({
      name: 'X',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: { runId: 'run_2' },
      artifactSha256s: ['a'.repeat(64)],
    });
    expect(a).not.toBe(b);
  });
});

describe('claimIdempotency', () => {
  it('first caller wins the claim and may proceed', async () => {
    const outcome = await claimIdempotency({
      index,
      callerId,
      idempotencyKey: 'idem-claim-win-0001',
      requestDigest: 'd'.repeat(64),
      collectionId: 'col_1111111111111111',
    });
    expect(outcome.proceed).toBe(true);
    expect(outcome.conflict).toBeUndefined();
    expect(outcome.claim?.collectionId).toBe('col_1111111111111111');
  });

  it('same key + same digest replays the original sealed result', async () => {
    const key = 'idem-replay-000001';
    const digest = computeRequestDigest({
      name: 'Replay',
      expiresAt: '2026-09-30T12:00:00.000Z',
      metadata: {},
      artifactSha256s: ['a'.repeat(64)],
    });
    const collection = collectionFor('col_2222222222222222');
    collection.idempotencyKey = key;
    collection.requestDigest = digest;
    await index.beginSeal({ collection, artifacts: [artifactFor('col_2222222222222222')] });
    await index.claimIdempotencyKey({
      callerId,
      idempotencyKey: key,
      requestDigest: digest,
      collectionId: 'col_2222222222222222',
    });
    await commitSeal({
      index,
      collectionId: 'col_2222222222222222',
      receiptJson: receipt('col_2222222222222222'),
    });

    const replay = await claimIdempotency({
      index,
      callerId,
      idempotencyKey: key,
      requestDigest: digest,
      collectionId: 'col_3333333333333333',
    });
    expect(replay.proceed).toBe(false);
    expect(replay.replay?.collectionId).toBe('col_2222222222222222');
    expect(replay.replay?.receiptJson).toBe(receipt('col_2222222222222222'));
    // No duplicate collection was created.
    expect(index.getCollection('col_3333333333333333')).toBeUndefined();
  });

  it('same key + different digest returns a conflict', async () => {
    const key = 'idem-conflict-0001';
    await claimIdempotency({
      index,
      callerId,
      idempotencyKey: key,
      requestDigest: 'e1'.repeat(32),
      collectionId: 'col_4444444444444444',
    });
    const outcome = await claimIdempotency({
      index,
      callerId,
      idempotencyKey: key,
      requestDigest: 'e2'.repeat(32),
      collectionId: 'col_5555555555555555',
    });
    expect(outcome.proceed).toBe(false);
    expect(outcome.conflict).toBe(true);
  });

  it('concurrent claims for the same key have exactly one winner', async () => {
    const key = 'idem-concurrent-001';
    const digestA = 'f1'.repeat(32);
    const digestB = 'f2'.repeat(32);
    const [a, b] = await Promise.all([
      claimIdempotency({
        index,
        callerId,
        idempotencyKey: key,
        requestDigest: digestA,
        collectionId: 'col_6666666666666666',
      }),
      claimIdempotency({
        index,
        callerId,
        idempotencyKey: key,
        requestDigest: digestB,
        collectionId: 'col_7777777777777777',
      }),
    ]);
    const winners = [a, b].filter((o) => o.proceed);
    const losers = [a, b].filter((o) => o.conflict === true);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('same-digest concurrent claims: exactly one caller proceeds, the other replays after sealing', async () => {
    const key = 'idem-same-digest-conc-001';
    const digest = 'ab'.repeat(32);
    const winnerCollection = 'col_abcdabcdabcdabcd';
    const loserCollection = 'col_dcbadcbadcbadcba';

    // Winner claims first (deterministic): the atomic insert stores its
    // collectionId and it proceeds without waiting.
    const winnerOutcome = await claimIdempotency({
      index,
      callerId,
      idempotencyKey: key,
      requestDigest: digest,
      collectionId: winnerCollection,
      waitMs: 2000,
    });
    expect(winnerOutcome.proceed).toBe(true);
    expect(winnerOutcome.claim?.winningCollectionId).toBe(winnerCollection);

    // Loser races in with the SAME digest while the winner is mid-seal: it
    // must NOT proceed; it waits for the winner to seal.
    const loserPromise = claimIdempotency({
      index,
      callerId,
      idempotencyKey: key,
      requestDigest: digest,
      collectionId: loserCollection,
      waitMs: 2000,
    });

    // Seal the winner's collection so the loser's wait resolves into a replay.
    const collection = collectionFor(winnerCollection);
    collection.idempotencyKey = key;
    collection.requestDigest = digest;
    await index.beginSeal({
      collection,
      artifacts: [artifactFor(winnerCollection)],
    });
    await commitSeal({
      index,
      collectionId: winnerCollection,
      receiptJson: receipt(winnerCollection),
    });

    // The loser must now replay the winner's result — never a second proceed.
    const loserOutcome = await loserPromise;
    expect(loserOutcome.proceed).toBe(false);
    expect(loserOutcome.conflict).toBeUndefined();
    expect(loserOutcome.replay?.collectionId).toBe(winnerCollection);
    expect(loserOutcome.replay?.receiptJson).toBe(receipt(winnerCollection));

    // Exactly one collection exists for the key.
    const sealed = index.findSealedByIdempotencyKey(callerId, key);
    expect(sealed?.collection.collectionId).toBe(winnerCollection);
  });

  it('abortSeal releases the claim and marks the collection failed', async () => {
    const key = 'idem-abort-00001';
    const digest = 'g'.repeat(64);
    const collection = collectionFor('col_8888888888888888');
    collection.idempotencyKey = key;
    collection.requestDigest = digest;
    await index.beginSeal({ collection, artifacts: [artifactFor('col_8888888888888888')] });
    await index.claimIdempotencyKey({
      callerId,
      idempotencyKey: key,
      requestDigest: digest,
      collectionId: 'col_8888888888888888',
    });

    await abortSeal({ index, callerId, idempotencyKey: key, collectionId: 'col_8888888888888888' });

    expect(index.getCollection('col_8888888888888888')).toMatchObject({
      collection: { status: 'failed' },
    });
    expect(index.getIdempotencyRecord(callerId, key)).toBeUndefined();

    // The key can now be reused for a fresh seal.
    const retry = await claimIdempotency({
      index,
      callerId,
      idempotencyKey: key,
      requestDigest: digest,
      collectionId: 'col_9999999999999999',
    });
    expect(retry.proceed).toBe(true);
  });
});
