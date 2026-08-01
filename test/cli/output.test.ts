import { describe, expect, it } from 'vitest';
import { emitSuccess, emitFailure, failureFrom, EXIT_OK, EXIT_DOMAIN } from '../../src/cli/output.js';

/** Capture stdout/stderr writes. */
function capture(fn: () => number): { code: number; out: string; err: string } {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('CLI output', () => {
  it('emits JSON on stdout with --json and exit 0', () => {
    const { code, out } = capture(() =>
      emitSuccess({ ok: true, data: { receipt: { version: '1.0' } } }, true, (d) => String(d.receipt.version)),
    );
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(out) as { ok: boolean; data: { receipt: { version: string } } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.receipt.version).toBe('1.0');
  });

  it('emits human text without --json', () => {
    const { code, out } = capture(() =>
      emitSuccess({ ok: true, data: { receipt: { version: '1.0' } } }, false, (d) => `version ${d.receipt.version}`),
    );
    expect(code).toBe(EXIT_OK);
    expect(out).toBe('version 1.0\n');
  });

  it('emits a JSON failure shape and exit 1', () => {
    const { code, err } = capture(() =>
      emitFailure({ ok: false, error: { code: 'COLLECTION_NOT_FOUND', message: 'nope' } }, true),
    );
    expect(code).toBe(EXIT_DOMAIN);
    const parsed = JSON.parse(err) as { ok: false; error: { code: string; message: string } };
    expect(parsed.error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('builds a failure from an ApiError-like object preserving code/requestId', () => {
    const failure = failureFrom({ name: 'ApiError', code: 'IDEMPOTENCY_CONFLICT', message: 'conflict', requestId: 'req_1' });
    expect(failure).toEqual({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT', message: 'conflict', requestId: 'req_1' },
    });
  });

  it('builds a generic INTERNAL_ERROR failure from a plain error', () => {
    const failure = failureFrom(new Error('boom'));
    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe('INTERNAL_ERROR');
    expect(failure.error.message).toBe('boom');
  });
});
