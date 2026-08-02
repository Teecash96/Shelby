import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteCollectionIndex } from '../../src/adapters/sqlite-collection-index.js';
import {
  assertCollectionOwner,
  authenticateCaller,
  hashApiKey,
  safeEqual,
} from '../../src/application/auth.js';
import { ProofVaultError } from '../../src/domain/errors.js';
import type { CallerRecord, CollectionRecord } from '../../src/ports/collection-index-port.js';

const ALICE_KEY = 'alice-local-dev-key-123456';
const BOB_KEY = 'bob-local-dev-key-12345678';
const REVOKED_KEY = 'revoked-dev-key-123456789';

let index: SqliteCollectionIndex;

function callerFor(id: string, keyHash: string, status: CallerRecord['status']): CallerRecord {
  return {
    callerId: id,
    keyHash,
    label: `${id} caller`,
    status,
    createdAt: '2026-07-31T00:00:00.000Z',
  };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pv-auth-'));
  index = SqliteCollectionIndex.open(`file:${join(dir, 'auth.db')}`);
  await index.upsertCaller(callerFor('caller_alice', hashApiKey(ALICE_KEY), 'active'));
  await index.upsertCaller(callerFor('caller_bob', hashApiKey(BOB_KEY), 'active'));
  await index.upsertCaller(callerFor('caller_revoked', hashApiKey(REVOKED_KEY), 'revoked'));
});

afterAll(() => index.close());

describe('authenticateCaller', () => {
  it('denies a missing Authorization header', async () => {
    await expect(authenticateCaller(index, undefined)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('denies an empty Authorization header', async () => {
    await expect(authenticateCaller(index, '')).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('denies a non-Bearer scheme', async () => {
    await expect(authenticateCaller(index, `Basic ${ALICE_KEY}`)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('denies an unknown key with FORBIDDEN', async () => {
    await expect(authenticateCaller(index, 'Bearer unknown-key-1234567890')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('denies a revoked key with FORBIDDEN (indistinguishable from unknown)', async () => {
    await expect(authenticateCaller(index, `Bearer ${REVOKED_KEY}`)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Same error code and message shape as the unknown-key denial.
    const unknown = await authenticateCaller(index, 'Bearer unknown-key-1234567890').then(
      () => undefined,
      (e: ProofVaultError) => e,
    );
    const revoked = await authenticateCaller(index, `Bearer ${REVOKED_KEY}`).then(
      () => undefined,
      (e: ProofVaultError) => e,
    );
    expect(unknown?.code).toBe(revoked?.code);
    expect(unknown?.message).toBe(revoked?.message);
  });

  it('authenticates an active key and returns the caller', async () => {
    const caller = await authenticateCaller(index, `Bearer ${ALICE_KEY}`);
    expect(caller.callerId).toBe('caller_alice');
  });

  it('accepts a key with surrounding whitespace after Bearer', async () => {
    const caller = await authenticateCaller(index, `Bearer  ${ALICE_KEY}  `);
    expect(caller.callerId).toBe('caller_alice');
  });
});

describe('safeEqual (constant-time comparison)', () => {
  it('compares equal strings', () => {
    expect(safeEqual('col_abc', 'col_abc')).toBe(true);
  });

  it('compares different strings', () => {
    expect(safeEqual('col_abc', 'col_abd')).toBe(false);
  });

  it('handles different lengths', () => {
    expect(safeEqual('a', 'ab')).toBe(false);
  });

  it('is deterministic across many comparisons', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(safeEqual(`caller_${i}`, `caller_${i}`)).toBe(true);
      expect(safeEqual(`caller_${i}`, `caller_${i + 1}`)).toBe(false);
    }
  });
});

describe('assertCollectionOwner', () => {
  const alice = { callerId: 'caller_alice' } as CallerRecord;

  it('passes when the caller owns the collection', () => {
    expect(() =>
      assertCollectionOwner('caller_alice', alice, 'col_1234567890abcdef'),
    ).not.toThrow();
  });

  it('raises COLLECTION_NOT_FOUND (not FORBIDDEN) for another callers object', () => {
    try {
      assertCollectionOwner('caller_bob', alice, 'col_1234567890abcdef');
      expect.unreachable('should have thrown');
    } catch (error) {
      const e = error as ProofVaultError;
      expect(e.code).toBe('COLLECTION_NOT_FOUND');
    }
  });

  it('uses the same COLLECTION_NOT_FOUND shape as a missing collection', () => {
    const missing = new ProofVaultError('COLLECTION_NOT_FOUND', `No such collection: col_missing`);
    let wrongOwnerError: ProofVaultError | undefined;
    try {
      assertCollectionOwner('caller_bob', alice, 'col_1234567890abcdef');
    } catch (error) {
      wrongOwnerError = error as ProofVaultError;
    }
    expect(wrongOwnerError?.code).toBe(missing.code);
    // Same code, same request-facing message shape.
    expect(wrongOwnerError?.message).toContain('col_1234567890abcdef');
  });

  it('guessed collection IDs do not disclose existence', async () => {
    // An absent collection and another caller's collection must both present
    // as COLLECTION_NOT_FOUND at the ownership boundary.
    const absent = await index.getCollection('col_0000000000000000');
    expect(absent).toBeUndefined();
    expect(() => assertCollectionOwner('caller_bob', alice, 'col_0000000000000000')).toThrow(
      ProofVaultError,
    );
  });
});

describe('end-to-end authorization flows (index-backed)', () => {
  it('a caller can only read its own sealed collection', async () => {
    // Seal a collection for alice.
    const collection: CollectionRecord = {
      collectionId: 'col_aaaaaaaaaaaaaaaa',
      callerId: 'caller_alice',
      name: 'Alice bundle',
      status: 'receiving',
      createdAt: '2026-07-31T00:00:00.000Z',
      expiresAt: '2026-09-30T12:00:00.000Z',
      manifestSha256: 'a'.repeat(64),
      manifestKey: 'collections/col_aaaaaaaaaaaaaaaa/manifest.json',
      idempotencyKey: 'idem-alice-own-0001',
      requestDigest: 'b'.repeat(64),
      artifactCount: 1,
      receiptJson: null,
    };
    await index.beginSeal({
      collection,
      artifacts: [
        {
          artifactId: 'art_aaaaaaaaaaaaaaaa',
          collectionId: 'col_aaaaaaaaaaaaaaaa',
          filename: 'a.txt',
          mediaType: 'text/plain',
          size: 3,
          sha256: 'c'.repeat(64),
          storageKey: 'cafef00d',
          providerRef: null,
          sha256Hex: 'c'.repeat(64),
        },
      ],
    });
    await index.markSealed('col_aaaaaaaaaaaaaaaa', JSON.stringify({ receipt: true }));

    // Alice sees it.
    const aliceView = await index.getCollection('col_aaaaaaaaaaaaaaaa');
    expect(aliceView?.collection.callerId).toBe('caller_alice');

    // Bob authenticates but must be denied with the same error as absent.
    const bob = await authenticateCaller(index, `Bearer ${BOB_KEY}`);
    expect(() =>
      assertCollectionOwner(aliceView!.collection.callerId, bob, 'col_aaaaaaaaaaaaaaaa'),
    ).toThrow(ProofVaultError);
  });
});
