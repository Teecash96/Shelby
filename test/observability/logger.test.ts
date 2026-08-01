import { describe, expect, it } from 'vitest';
import { redact } from '../../src/observability/logger.js';

/** redact returns unknown; these helpers narrow it for assertions. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

describe('redact (log redaction)', () => {
  it('redacts authorization headers and API keys at the top level', () => {
    const out = asRecord(
      redact({ Authorization: 'Bearer secret-key', 'x-api-key': 'k', safe: 'ok' }),
    );
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out.safe).toBe('ok');
  });

  it('redacts secrets nested inside errors', () => {
    const out = asRecord(
      redact({
        error: {
          cause: { SHELBY_ACCOUNT_PRIVATE_KEY: '0xdeadbeef', message: 'network failed' },
          config: { headers: { Authorization: 'Bearer tok' } },
        },
      }),
    );
    expect(asRecord(out.error).cause).toEqual({
      SHELBY_ACCOUNT_PRIVATE_KEY: '[REDACTED]',
      message: 'network failed',
    });
    expect(asRecord(asRecord(asRecord(out.error).config).headers).Authorization).toBe('[REDACTED]');
  });

  it('redacts full receipt objects by field name', () => {
    const out = asRecord(
      redact({
        receipt: { manifestSha256: 'abc', token: 'jwt' },
        metadata: { apiKey: 'secret-123' },
      }),
    );
    expect(asRecord(out.receipt).token).toBe('[REDACTED]');
    expect(asRecord(out.metadata).apiKey).toBe('[REDACTED]');
  });

  it('redacts inside arrays of records', () => {
    const out = asArray(redact([{ password: 'p' }, { token: 't' }]));
    expect(out[0]).toEqual({ password: '[REDACTED]' });
    expect(out[1]).toEqual({ token: '[REDACTED]' });
  });

  it('truncates long string values', () => {
    const long = 'x'.repeat(5000);
    const out = asRecord(redact({ data: long }));
    expect(out.data).toHaveLength(2000 + '...[truncated]'.length);
  });

  it('does not over-redact innocuous keys', () => {
    const out = asRecord(redact({ collectionId: 'col_1', adapter: 'local', tokenCount: 3 }));
    expect(out.collectionId).toBe('col_1');
    expect(out.adapter).toBe('local');
    expect(out.tokenCount).toBe(3);
  });
});
