import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultErasureCodingProvider } from '@shelby-protocol/sdk/node';
import { stageOnce } from '../../src/adapters/shelby-storage-adapter.js';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Deterministic pseudo-random fixture bytes. */
function fixtureBytes(count: number, seed = 3): Uint8Array {
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    bytes[i] = 33 + ((i * 31 + seed * 17) % 94);
  }
  return bytes;
}

/** A one-shot async-iterable: any second iteration throws. */
function oneShotIterableOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  let consumed = false;
  return {
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error('one-shot stream was read more than once');
      }
      consumed = true;
      return (async function* () {
        const CHUNK = 4096;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          yield bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
        }
      })();
    },
  };
}

describe('ShelbyStorageAdapter stageOnce (one-shot input)', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  it('consumes the body exactly once and stages identical bytes to the temp file', async () => {
    const fixture = fixtureBytes(2 * 1024 * 1024 + 123, 7);
    const provider = await createDefaultErasureCodingProvider();
    const tempDir = await mkdtemp(join(tmpdir(), 'pv-stage-'));
    tempDirs.push(tempDir);
    const tempFile = join(tempDir, 'payload.blob');

    const { commitments, size } = await stageOnce(oneShotIterableOf(fixture), tempFile, provider);

    // Exact byte count from the single pass.
    expect(size).toBe(fixture.byteLength);

    // The staged file holds the exact same bytes (streamed from the one-shot
    // input, not a re-read).
    const stagedBytes = await readFileBytes(tempFile);
    expect(stagedBytes.byteLength).toBe(fixture.byteLength);
    expect(sha256Hex(stagedBytes)).toBe(sha256Hex(fixture));

    // Commitments were generated from those exact bytes.
    expect(commitments.blob_merkle_root).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('rejects when the one-shot stream fails on its first read', async () => {
    const provider = await createDefaultErasureCodingProvider();
    const tempDir = await mkdtemp(join(tmpdir(), 'pv-stage-fail-'));
    tempDirs.push(tempDir);
    const tempFile = join(tempDir, 'payload.blob');

    // A body that fails immediately. stageOnce must reject and the caller's
    // temp-dir cleanup must be able to remove the staging directory.
    const failing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            throw new Error('upstream failed');
          },
        };
      },
    };

    await expect(stageOnce(failing, tempFile, provider)).rejects.toThrow('upstream failed');
    // The caller-owned staging directory is still removable.
    await rm(tempDir, { recursive: true, force: true });
  });
});

async function readFileBytes(path: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
