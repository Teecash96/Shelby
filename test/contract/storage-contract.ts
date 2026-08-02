import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoragePort } from '../../src/ports/storage-port.js';
import {
  asciiBytes,
  asyncIterableOf,
  bytesEqual,
  concatBytes,
  EXPIRES_AT,
  fromWeb,
  streamOf,
  testDataDir,
} from '../helpers/storage.js';

export interface AdapterHarness {
  name: string;
  makeAdapter: (dataDir: string) => StoragePort & { providerName: string };
  /**
   * Per-run key prefix. Network-backed adapters (Shelby) share one global
   * namespace, so fixed keys collide across runs; a unique prefix keeps each
   * run isolated. Filesystem adapters use the default.
   */
  keyPrefix?: string;
  /** Optional path where the adapter writes committed objects (filesystem adapters only). */
  objectPath?: (dataDir: string, key: string) => string;
  /** Optional way to corrupt or remove a committed object (filesystem adapters only). */
  corruptObject?: (dataDir: string, key: string) => Promise<void>;
  /** Set to skip the filesystem-only cases for non-filesystem adapters. */
  filesystemOnly?: boolean;
  /** Per-test timeout in ms for network-backed adapters (default vitest 5000). */
  timeoutMs?: number;
}

/**
 * Shared adapter contract suite. Every storage adapter implementation must
 * pass this suite unchanged so that the local and Shelby adapters provably
 * share one contract (COMMANDCODE_PROMPT.md minimum test matrix).
 */
export function runStorageContractSuite(harness: AdapterHarness): void {
  describe(
    `storage contract suite: ${harness.name}`,
    harness.timeoutMs === undefined ? {} : { timeout: harness.timeoutMs },
    () => {
      const { dir } = testDataDir(
        `adapter-${harness.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      );
      const adapter = harness.makeAdapter(dir);
      // Unique per-run prefix for network-backed adapters.
      const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const key = (name: string): string =>
        harness.keyPrefix === undefined ? name : `${harness.keyPrefix}/${runId}/${name}`;

      it('round-trips an empty object', async () => {
        const result = await adapter.put({
          key: key('empty'),
          body: streamOf(new Uint8Array(0)),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-empty',
        });
        expect(result.size).toBe(0);
        const fetched = await adapter.get(key('empty'));
        const bytes = concatBytes(await collect(fromWeb(fetched.body)));
        expect(bytes.byteLength).toBe(0);
      });

      it('round-trips a small binary object', async () => {
        const fixture = asciiBytes(4096, 3);
        await adapter.put({
          key: key('small.bin'),
          body: streamOf(fixture),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-small',
        });
        const fetched = await adapter.get(key('small.bin'));
        expect(fetched.contentType).toBe('application/octet-stream');
        expect(fetched.size).toBe(fixture.byteLength);
        const bytes = concatBytes(await collect(fromWeb(fetched.body)));
        expect(bytesEqual(bytes, fixture)).toBe(true);
      });

      it('round-trips a large binary object', async () => {
        const fixture = asciiBytes(2 * 1024 * 1024 + 123, 11);
        await adapter.put({
          key: key('large.bin'),
          body: asyncIterableOf(fixture),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-large',
        });
        const fetched = await adapter.get(key('large.bin'));
        const bytes = concatBytes(await collect(fromWeb(fetched.body)));
        expect(bytes.byteLength).toBe(fixture.byteLength);
        expect(bytesEqual(bytes, fixture)).toBe(true);
      });

      it('accepts bytes in varying chunk sizes', async () => {
        const fixture = asciiBytes(5000, 5);
        await adapter.put({
          key: key('chunked.bin'),
          body: streamOf(fixture),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-chunked',
        });
        const fetched = await adapter.get(key('chunked.bin'));
        const bytes = concatBytes(await collect(fromWeb(fetched.body)));
        expect(bytesEqual(bytes, fixture)).toBe(true);
      });

      it('exposes a size for every stored object', async () => {
        const fixture = asciiBytes(100, 9);
        await adapter.put({
          key: key('sized.bin'),
          body: asyncIterableOf(fixture),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-sized',
        });
        const fetched = await adapter.get(key('sized.bin'));
        expect(fetched.size).toBe(100);
      });

      it('reports existence and non-existence', async () => {
        await adapter.put({
          key: key('exists.bin'),
          body: streamOf(asciiBytes(10)),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-exists',
        });
        await expect(adapter.exists(key('exists.bin'))).resolves.toBe(true);
        await expect(adapter.exists(key('missing.bin'))).resolves.toBe(false);
      });

      it('get on a missing key fails', async () => {
        await expect(adapter.get(key('does-not-exist'))).rejects.toThrow(/not found/i);
      });

      it('rejects keys with path separators', async () => {
        await expect(
          adapter.put({
            key: '../escape',
            body: streamOf(asciiBytes(4)),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-traversal',
          }),
        ).rejects.toThrow();
        await expect(adapter.get('../escape')).rejects.toThrow();
        await expect(adapter.exists('../escape')).rejects.toThrow();
      });

      it('rejects keys with absolute paths and control characters', async () => {
        await expect(
          adapter.put({
            key: '/etc/passwd',
            body: streamOf(asciiBytes(2)),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-abs',
          }),
        ).rejects.toThrow();
        await expect(
          adapter.put({
            key: 'bad\u0000key',
            body: streamOf(asciiBytes(2)),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-nul',
          }),
        ).rejects.toThrow();
      });

      it('same-key puts never silently mix byte streams (first write wins, later writes ignored)', async () => {
        const firstBytes = asciiBytes(16, 1);
        await adapter.put({
          key: key('a.bin'),
          body: streamOf(firstBytes),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-a',
        });
        // Content-addressed keys: the caller derives the key from the exact
        // bytes, so a second put with a different payload under the same key is
        // a caller contract violation. The adapter must not produce a torn or
        // mixed object.
        await adapter.put({
          key: key('a.bin'),
          body: streamOf(asciiBytes(16, 2)),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-a',
        });
        const after = concatBytes(await collect(fromWeb((await adapter.get(key('a.bin'))).body)));
        expect(bytesEqual(after, firstBytes)).toBe(true);
      });

      it('reports a provider reference without secrets', async () => {
        const result = await adapter.put({
          key: key('prov.bin'),
          body: streamOf(asciiBytes(8)),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-prov',
        });
        expect(result.providerRef).toBeTypeOf('string');
        expect(result.providerRef).not.toMatch(/(key|secret|token|password|private)/i);
      });

      if (!harness.filesystemOnly) {
        it('a failed source stream leaves no readable object', async () => {
          const failingBody = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial bytes'));
              controller.error(new Error('upstream failed'));
            },
          });
          await expect(
            adapter.put({
              key: key('broken.bin'),
              body: failingBody,
              contentType: 'application/octet-stream',
              expiresAt: EXPIRES_AT,
              idempotencyKey: 'idem-broken',
            }),
          ).rejects.toThrow('upstream failed');
          await expect(adapter.get(key('broken.bin'))).rejects.toThrow(/not found/i);
          await expect(adapter.exists(key('broken.bin'))).resolves.toBe(false);
        });
      }

      it('duplicate idempotency key is accepted (idempotency is the caller boundary)', async () => {
        const fixture = asciiBytes(32, 4);
        await adapter.put({
          key: key('dup.bin'),
          body: streamOf(fixture),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-dup',
        });
        // The StoragePort contract is idempotent for identical keys (the seal
        // service owns request-level idempotency conflict detection).
        await expect(
          adapter.put({
            key: key('dup.bin'),
            body: streamOf(fixture),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-dup',
          }),
        ).resolves.toBeDefined();
      });

      it('concurrent puts of distinct keys both succeed', async () => {
        const a = adapter.put({
          key: key('conc-a.bin'),
          body: asyncIterableOf(asciiBytes(50000, 1)),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-conc-a',
        });
        const b = adapter.put({
          key: key('conc-b.bin'),
          body: asyncIterableOf(asciiBytes(50000, 2)),
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-conc-b',
        });
        await Promise.all([a, b]);
        await expect(adapter.exists(key('conc-a.bin'))).resolves.toBe(true);
        await expect(adapter.exists(key('conc-b.bin'))).resolves.toBe(true);
      });

      it('concurrent puts of the same key produce exactly one committed object', async () => {
        const fixture = asciiBytes(40000, 6);
        const results = await Promise.allSettled([
          adapter.put({
            key: key('same.bin'),
            body: asyncIterableOf(fixture),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-same-1',
          }),
          adapter.put({
            key: key('same.bin'),
            body: asyncIterableOf(fixture),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-same-2',
          }),
        ]);
        const succeeded = results.filter((r) => r.status === 'fulfilled').length;
        expect(succeeded).toBeGreaterThanOrEqual(1);
        const fetched = await adapter.get(key('same.bin'));
        expect(fetched.size).toBe(fixture.byteLength);
        const bytes = concatBytes(await collect(fromWeb(fetched.body)));
        expect(bytesEqual(bytes, fixture)).toBe(true);
      });

      if (harness.corruptObject) {
        it('get reports an error after the object is removed', async () => {
          await adapter.put({
            key: key('remove-me.bin'),
            body: streamOf(asciiBytes(64)),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-remove',
          });
          const corrupt = harness.corruptObject;
          if (corrupt !== undefined) {
            await corrupt(dir, 'remove-me.bin');
          }
          await expect(adapter.get(key('remove-me.bin'))).rejects.toThrow(/not found/i);
          await expect(adapter.exists(key('remove-me.bin'))).resolves.toBe(false);
        });
      }

      if (harness.objectPath) {
        it('commits objects as complete files on disk', async () => {
          const fixture = asciiBytes(2048, 8);
          await adapter.put({
            key: key('ondisk.bin'),
            body: streamOf(fixture),
            contentType: 'application/octet-stream',
            expiresAt: EXPIRES_AT,
            idempotencyKey: 'idem-ondisk',
          });
          const entries = await readdir(join(dir));
          expect(entries).toContain('ondisk.bin');
          expect(entries.filter((e) => e.endsWith('.upload'))).toHaveLength(0);
          expect(entries.filter((e) => e.endsWith('.partial'))).toHaveLength(0);
        });
      }
    },
  );
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const collected: Uint8Array[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return collected;
}
