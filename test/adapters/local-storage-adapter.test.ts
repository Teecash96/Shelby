import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from '../../src/adapters/local-storage-adapter.js';
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

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('LocalStorageAdapter determinism', () => {
  const { dir } = testDataDir('local-determinism');
  const adapter = new LocalStorageAdapter(dir);

  it('content-addressed keys: identical bytes under a digest key are stored once', async () => {
    const fixture = asciiBytes(1000, 2);
    const key = sha256Hex(fixture);
    await adapter.put({
      key,
      body: streamOf(fixture),
      contentType: 'application/octet-stream',
      expiresAt: EXPIRES_AT,
      idempotencyKey: 'idem-ca-1',
    });
    // Same bytes, same key: the second put is a no-op by key identity.
    await adapter.put({
      key,
      body: streamOf(fixture),
      contentType: 'application/octet-stream',
      expiresAt: EXPIRES_AT,
      idempotencyKey: 'idem-ca-2',
    });
    const entries = await readdir(dir);
    const objectEntries = entries.filter((e) => !e.endsWith('.upload') && !e.endsWith('.meta.json'));
    expect(objectEntries).toEqual([key]);
  });

  it('the same input bytes always produce the same digest key', () => {
    const fixture = asciiBytes(1000, 2);
    expect(sha256Hex(fixture)).toBe('9f8aeaee57ccc805f3570f36c1c22160f7862d8a9f50faa70c7ae44e6564ce9b');
  });
});

describe('LocalStorageAdapter interrupted writes', () => {
  async function tempDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'pv-interrupted-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it('a failed upload leaves no committed object and no lingering temp', async () => {
    const { dir, cleanup } = await tempDataDir();
    try {
      const adapter = new LocalStorageAdapter(dir);

      const failingBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('some bytes'));
          controller.error(new Error('simulated upstream failure'));
        },
      });
      await expect(
        adapter.put({
          key: 'interrupted.bin',
          body: failingBody,
          contentType: 'application/octet-stream',
          expiresAt: EXPIRES_AT,
          idempotencyKey: 'idem-interrupted',
        }),
      ).rejects.toThrow('simulated upstream failure');

      // A failed upload must never surface as a sealed object.
      await expect(adapter.get('interrupted.bin')).rejects.toThrow(/not found|still being uploaded/i);
      await expect(adapter.exists('interrupted.bin')).resolves.toBe(false);
      const entries = await readdir(dir);
      expect(entries).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('a retry after a failed upload succeeds without touching another upload temp', async () => {
    const { dir, cleanup } = await tempDataDir();
    try {
      const adapter = new LocalStorageAdapter(dir);

      // Simulate a crashed upload: a stale temp file with partial bytes and no
      // committed object. A retry owns a fresh temp path and commits atomically.
      const staleTemp = join(dir, 'retry.bin.stale.upload');
      await writeFile(staleTemp, new TextEncoder().encode('partial-crash-bytes'));

      const fixture = asciiBytes(512, 3);
      await adapter.put({
        key: 'retry.bin',
        body: asyncIterableOf(fixture),
        contentType: 'application/octet-stream',
        expiresAt: EXPIRES_AT,
        idempotencyKey: 'idem-retry-2',
      });
      const fetched = concatBytes(await collect(fromWeb((await adapter.get('retry.bin')).body)));
      expect(bytesEqual(fetched, fixture)).toBe(true);
      const entries = await readdir(dir);
      expect(entries).toContain('retry.bin.stale.upload');
    } finally {
      await cleanup();
    }
  });
});

describe('LocalStorageAdapter traversal and symlink defense', () => {
  // These tests create symlinks pointing outside the adapter root, so they
  // use dedicated mkdtemp directories instead of the shared test root.
  async function symlinkTestDir(): Promise<{ dir: string; outsideDir: string }> {
    const base = await mkdtemp(join(tmpdir(), 'pv-symlink-'));
    return { dir: join(base, 'root'), outsideDir: join(base, 'outside') };
  }

  it('a symlink inside the data dir cannot make get() read outside the root', async () => {
    const { dir, outsideDir } = await symlinkTestDir();
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const adapter = new LocalStorageAdapter(dir);

    // A committed object the symlink would point away from.
    await adapter.put({
      key: 'legit.bin',
      body: streamOf(asciiBytes(32, 1)),
      contentType: 'application/octet-stream',
      expiresAt: EXPIRES_AT,
      idempotencyKey: 'idem-legit',
    });

    // Attacker replaces the object with a symlink pointing outside the root.
    const outside = join(outsideDir, 'outside-target.bin');
    await writeFile(outside, new TextEncoder().encode('secret outside bytes'));
    await rm(join(dir, 'legit.bin'), { force: true });
    await symlink(outside, join(dir, 'legit.bin'));

    await expect(adapter.get('legit.bin')).rejects.toThrow(/escapes the data directory|not found/i);
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('exists() does not follow a symlink planted at a missing key', async () => {
    const { dir, outsideDir } = await symlinkTestDir();
    await mkdir(dir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const adapter = new LocalStorageAdapter(dir);

    const outside = join(outsideDir, 'outside-exists.bin');
    await writeFile(outside, new TextEncoder().encode('x'));
    await symlink(outside, join(dir, 'phantom.bin'));
    await expect(adapter.exists('phantom.bin')).resolves.toBe(false);
    await rm(join(dir, '..'), { recursive: true, force: true });
  });
});

describe('LocalStorageAdapter content type handling', () => {
  it('stores and returns a content type claim without trusting it as proof', async () => {
    const { dir } = testDataDir('local-content-type');
    const adapter = new LocalStorageAdapter(dir);
    await adapter.put({
      key: 'doc.txt',
      body: streamOf(new TextEncoder().encode('hello')),
      contentType: 'text/plain; charset=utf-8',
      expiresAt: EXPIRES_AT,
      idempotencyKey: 'idem-ct',
    });
    const fetched = await adapter.get('doc.txt');
    expect(fetched.contentType).toBe('text/plain; charset=utf-8');
    // The on-disk object is opaque bytes; content type is metadata.
    const onDisk = await readFile(join(dir, 'doc.txt'));
    expect(new TextDecoder().decode(onDisk)).toBe('hello');
  });
});

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const collected: Uint8Array[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return collected;
}
