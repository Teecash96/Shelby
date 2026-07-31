import { createHash } from 'node:crypto';

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Streaming SHA-256 over a byte source. Returns the hex digest and the exact
 * number of bytes consumed. Bytes are never buffered as a whole; only the
 * running digest state is retained.
 */
export async function streamSha256(
  chunks: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of toAsyncIterable(chunks)) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Normalize a web ReadableStream or async iterable into an async iterable. */
export function toAsyncIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in Object(source)) {
    return source as AsyncIterable<Uint8Array>;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
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
