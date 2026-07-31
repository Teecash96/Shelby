import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

export const EXPIRES_AT = '2030-01-01T00:00:00.000Z';

/** ASCII bytes for a deterministic pseudo-random fixture. */
export function asciiBytes(count: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    bytes[i] = 33 + ((i * 31 + seed * 17) % 94);
  }
  return bytes;
}

export function asyncIterableOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    // Real multipart parsing yields chunked buffers; 64 KiB is a realistic
    // streaming chunk size and avoids per-byte-pair microtask overhead.
    const CHUNK = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      yield bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
    }
  })();
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const CHUNK = 128;
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length)));
      }
      controller.close();
    },
  });
}

export function fromWeb(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  // StoragePort.get may return a plain async iterable (e.g. a Node-style
  // adapter); pass those through directly.
  if (Symbol.asyncIterator in Object(body)) {
    return body as AsyncIterable<Uint8Array>;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const { done, value } = await reader.read();
          if (done) {
            await reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value };
        },
      };
    },
  };
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fast byte equality. Vitest's `toEqual` deep-compares every element of a
 * typed array, which is pathologically slow for large fixtures, so byte
 * integrity assertions use this instead.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  if (a === b) return true;
  // Buffer.compare is a single native memcmp for same-length buffers.
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

/** Scoped scratch directory per adapter instance; wiped on suite teardown. */
export function testDataDir(name: string): { dir: string; cleanup: () => Promise<void> } {
  const root = resolve(process.env.PROOFVAULT_TEST_STORAGE_DIR ?? '.proofvault/test-data');
  const dir = resolve(root, name);
  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, cleanup: () => Promise.resolve(rmSync(dir, { recursive: true, force: true })) };
}
