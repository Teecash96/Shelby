import { createHash } from 'node:crypto';

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Streaming SHA-256 over an async iterable of byte chunks. Returns the hex
 * digest and the exact number of bytes consumed. Bytes are never buffered as
 * a whole; only the running digest state is retained.
 */
export async function streamSha256(
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: hash.digest('hex'), size };
}
