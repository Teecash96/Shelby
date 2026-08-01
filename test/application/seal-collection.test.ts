import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteCollectionIndex } from '../../src/adapters/sqlite-collection-index.js';
import { sealCollection } from '../../src/application/seal-collection.js';
import type { StoragePort } from '../../src/ports/storage-port.js';

describe('sealCollection failure recovery', () => {
  it('releases its own claim when manifest persistence fails after streaming', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pv-seal-failure-'));
    const index = SqliteCollectionIndex.open(`file:${join(root, 'index.db')}`);
    const callerId = 'caller_seal_failure';
    const idempotencyKey = 'seal-manifest-failure-001';
    await index.upsertCaller({
      callerId,
      keyHash: 'f'.repeat(64),
      label: 'failure test',
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const storage: StoragePort = {
      providerName: 'test',
      async put(input) {
        if (input.key.endsWith('/manifest.json')) {
          throw new Error('manifest store unavailable');
        }
        for await (const _chunk of input.body as AsyncIterable<Uint8Array>) {
          // Drain the artifact stream just as a real adapter would.
        }
        return { key: input.key, size: 1, providerRef: 'test' };
      },
      async get() {
        throw new Error('not used');
      },
      async exists() {
        return false;
      },
    };

    const expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    const parts = (async function* () {
      yield {
        type: 'field' as const,
        fieldname: 'collection',
        value: JSON.stringify({ name: 'failure', expiresAt }),
      };
      yield {
        type: 'file' as const,
        fieldname: 'files',
        filename: 'a.txt',
        mimetype: 'text/plain',
        file: (async function* () {
          yield new Uint8Array([1]);
        })(),
      };
    })();

    try {
      await expect(
        sealCollection({ callerId, idempotencyKey, parts }, { index, storage }),
      ).rejects.toThrow('manifest store unavailable');
      expect(index.getIdempotencyRecord(callerId, idempotencyKey)).toBeUndefined();
      expect(index.getCollection('missing')).toBeUndefined();
    } finally {
      index.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
