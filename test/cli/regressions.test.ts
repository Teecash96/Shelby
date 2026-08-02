import { describe, expect, it } from 'vitest';
import { concatStreams, sanitizeFilename, sanitizeMediaType, ApiError } from '../../src/cli/client.js';
import { exitCodeFor, EXIT_DOMAIN, EXIT_TRANSPORT } from '../../src/cli/output.js';
import { isLoopbackUrl, resolveApiKey } from '../../src/cli/index.js';

describe('concatStreams backpressure', () => {
  it('enqueues one chunk per pull and never drains a source in a single pull', async () => {
    // Web Stream sources may prefetch one chunk ahead of the consumer, so the
    // exact pull count is not fixed; what matters is that a source is not
    // drained in one pull (bounded queue) and each read yields one chunk.
    let pullCount = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount > 100) controller.close();
        else controller.enqueue(new Uint8Array([pullCount]));
      },
    });
    const concat = concatStreams([source]);
    const reader = concat.getReader();

    // Read exactly 3 chunks: the source must not have been drained (a
    // drain-all-in-one-pull implementation would have pulled far more).
    const chunks: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      chunks.push(value![0]!);
    }
    expect(chunks).toEqual([1, 2, 3]);
    // Prefetch allows pullCount up to ~reads+1; a broken drain loop would be
    // much larger (near 100). Bound it well below the source's total.
    expect(pullCount).toBeLessThanOrEqual(5);

    await reader.cancel();
  });

  it('concatenates multiple sources in order', async () => {
    const a = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('ab'));
        c.close();
      },
    });
    const b = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('cd'));
        c.close();
      },
    });
    const concat = concatStreams([a, b]);
    const reader = concat.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toBe('abcd');
  });
});

describe('multipart header sanitization', () => {
  it('rejects filenames with quotes or control characters', () => {
    expect(() => sanitizeFilename('a"b.txt')).toThrow(/quotes|control characters/i);
    expect(() => sanitizeFilename('a\r\nb.txt')).toThrow(/control characters/i);
  });

  it('rejects filenames with path separators', () => {
    expect(() => sanitizeFilename('../etc/passwd')).toThrow(/path separators/i);
    expect(() => sanitizeFilename('a\\b.txt')).toThrow(/path separators/i);
  });

  it('rejects empty or overlong filenames', () => {
    expect(() => sanitizeFilename('')).toThrow(/1-255/);
    expect(() => sanitizeFilename('x'.repeat(256))).toThrow(/1-255/);
  });

  it('accepts a safe filename', () => {
    expect(sanitizeFilename('report v2.pdf')).toBe('report v2.pdf');
  });

  it('rejects media types with control characters', () => {
    expect(() => sanitizeMediaType('text/plain\r\nX-Inject: 1')).toThrow(/control characters/i);
  });

  it('rejects non type/subtype media types', () => {
    expect(() => sanitizeMediaType('not-a-media-type')).toThrow(/type\/subtype/i);
    expect(() => sanitizeMediaType('text//plain')).toThrow(/type\/subtype/i);
  });

  it('accepts a safe media type', () => {
    expect(sanitizeMediaType('application/pdf')).toBe('application/pdf');
    expect(sanitizeMediaType('text/plain')).toBe('text/plain');
  });

  it('rejects parameterized media types (manifest schema allows type/subtype only)', () => {
    expect(() => sanitizeMediaType('text/plain; charset=utf-8')).toThrow(/type\/subtype/i);
  });
});

describe('CLI exit codes', () => {
  it('maps a 4xx API domain failure to exit 1', () => {
    const err = new ApiError(404, { code: 'COLLECTION_NOT_FOUND', message: 'nope' });
    expect(exitCodeFor(err)).toBe(EXIT_DOMAIN);
    const conflict = new ApiError(409, { code: 'IDEMPOTENCY_CONFLICT', message: 'c' });
    expect(exitCodeFor(conflict)).toBe(EXIT_DOMAIN);
  });

  it('maps a 5xx API failure to exit 2', () => {
    const err = new ApiError(503, { code: 'STORAGE_UNAVAILABLE', message: 'down' });
    expect(exitCodeFor(err)).toBe(EXIT_TRANSPORT);
  });

  it('maps a network/transport error to exit 2', () => {
    expect(exitCodeFor(new Error('fetch failed'))).toBe(EXIT_TRANSPORT);
    expect(exitCodeFor(new TypeError('network down'))).toBe(EXIT_TRANSPORT);
  });
});

describe('CLI API-key resolution off-loopback', () => {
  it('recognizes loopback hosts', () => {
    expect(isLoopbackUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackUrl('http://example.com')).toBe(false);
    expect(isLoopbackUrl('https://proofvault.example.com')).toBe(false);
  });

  it('uses the dev key on loopback when no env key is set', () => {
    expect(resolveApiKey(undefined, 'http://127.0.0.1:3000')).toBe('dev-local-key');
  });

  it('requires an explicit API key off-loopback', () => {
    expect(() => resolveApiKey(undefined, 'http://example.com')).toThrow(
      /PROOFVAULT_API_KEY is required/,
    );
    expect(() => resolveApiKey('', 'http://example.com')).toThrow(
      /PROOFVAULT_API_KEY is required/,
    );
  });

  it('uses the explicit env key for any host', () => {
    expect(resolveApiKey('custom-key', 'http://example.com')).toBe('custom-key');
    expect(resolveApiKey('custom-key', 'http://127.0.0.1:3000')).toBe('custom-key');
  });
});
