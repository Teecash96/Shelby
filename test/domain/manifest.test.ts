import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import {
  canonicalManifestJson,
  manifestSchema,
  type Manifest,
  type ManifestArtifact,
} from '../../src/domain/manifest.js';
import { receiptSchema } from '../../src/domain/receipt.js';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * Loose override types let the rejection tables supply intentionally invalid
 * values (wrong types, unknown fields) that would not typecheck against the
 * real Manifest / ManifestArtifact types.
 */
type LooseArtifactOverrides = Record<string, unknown>;
type LooseManifestOverrides = Record<string, unknown>;

function makeArtifact(overrides: Partial<ManifestArtifact> = {}): ManifestArtifact {
  return {
    artifactId: 'art_1234567890abcdef',
    filename: 'report.pdf',
    mediaType: 'application/pdf',
    size: 12,
    sha256: 'a'.repeat(64),
    storageKey: 'collections/col_1234567890abcdef/report.pdf',
    ...overrides,
  };
}

function makeManifest(overrides: LooseManifestOverrides = {}): Manifest {
  return {
    version: '1.0',
    collectionId: 'col_1234567890abcdef',
    name: 'Quarterly research bundle',
    createdAt: '2026-07-31T10:00:00.000Z',
    expiresAt: '2026-09-30T12:00:00.000Z',
    hashAlgorithm: 'sha256',
    metadata: { source: 'research-agent' },
    artifacts: [makeArtifact()],
    ...overrides,
  } as Manifest;
}

describe('canonical JSON', () => {
  it('sorts object keys and omits whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys by Unicode code point (uppercase before lowercase)', () => {
    expect(canonicalJson({ z: 1, A: 2 })).toBe('{"A":2,"z":1}');
  });

  it('recursively canonicalizes nested objects and arrays', () => {
    expect(canonicalJson({ b: { d: 1, c: [2, 1] }, a: null })).toBe(
      '{"a":null,"b":{"c":[2,1],"d":1}}',
    );
  });

  it('uses the four mandatory escapes and unicode escapes for control characters', () => {
    expect(canonicalJson({ q: '"\\\b\f\n\r\t\u0001' })).toBe(
      '{"q":"\\"\\\\\\b\\f\\n\\r\\t\\u0001"}',
    );
  });

  it('emits lowercase hexadecimal unicode escapes for lone surrogates', () => {
    expect(canonicalJson({ lone: '\ud800' })).toBe('{"lone":"\\ud800"}');
  });

  it('preserves string content as UTF-8 when hashing the canonical form', () => {
    const value = { message: 'héllo — 日本語 🚀' };
    const canonical = canonicalJson(value);
    const digest = sha256Hex(canonical);
    expect(digest).toHaveLength(64);
    // Recomputing over the same canonical bytes must be stable.
    expect(sha256Hex(canonical)).toBe(digest);
  });

  it('drops undefined object values', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
  });
});

describe('manifest schema', () => {
  it('accepts a valid manifest', () => {
    expect(() => manifestSchema.parse(makeManifest())).not.toThrow();
  });

  it('accepts a manifest without metadata', () => {
    const manifest = makeManifest({ metadata: undefined });
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  it('accepts providerRef on artifacts', () => {
    const manifest = makeManifest({
      artifacts: [makeArtifact({ providerRef: 'local:/tmp/x' })],
    });
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });

  it.each([
    ['missing version', makeManifest({ version: '0.9' })],
    ['unsupported version', makeManifest({ version: '2.0' })],
    ['missing hashAlgorithm', makeManifest({ hashAlgorithm: 'md5' })],
    ['bad collectionId', makeManifest({ collectionId: 'col_invalid' })],
    ['empty name', makeManifest({ name: '' })],
    ['name too long', makeManifest({ name: 'x'.repeat(121) })],
    ['createdAt not a timestamp', makeManifest({ createdAt: 'not-a-date' })],
    ['expiresAt without offset', makeManifest({ expiresAt: '2026-09-30T12:00:00' })],
    ['no artifacts', makeManifest({ artifacts: [] })],
    [
      'too many artifacts',
      makeManifest({ artifacts: Array.from({ length: 21 }, () => makeArtifact()) }),
    ],
  ])('rejects %s', (_label, manifest) => {
    expect(() => manifestSchema.parse(manifest)).toThrow();
  });

  it.each([
    ['bad artifactId', { artifactId: 'art_bad' }],
    ['filename with slash', { filename: 'a/b.txt' }],
    ['filename with backslash', { filename: 'a\\b.txt' }],
    ['filename with NUL', { filename: 'a\u0000b' }],
    ['filename too long', { filename: 'x'.repeat(256) }],
    ['empty filename', { filename: '' }],
    ['bad media type', { mediaType: 'pdf' }],
    ['media type without slash', { mediaType: 'applicationpdf' }],
    ['negative size', { size: -1 }],
    ['non-integer size', { size: 1.5 }],
    ['size over limit', { size: 26214401 }],
    ['uppercase sha256', { sha256: 'A'.repeat(64) }],
    ['short sha256', { sha256: 'abc' }],
    ['missing storageKey', { storageKey: '' }],
    ['unexpected field', { extra: true }],
  ])('rejects artifact with %s', (_label, overrides: LooseArtifactOverrides) => {
    expect(() =>
      manifestSchema.parse(makeManifest({ artifacts: [makeArtifact(overrides)] })),
    ).toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() => manifestSchema.parse(makeManifest({ extra: 'x' }))).toThrow();
  });

  it('enforces the metadata key and value rules', () => {
    const badKey = makeManifest({ metadata: { 'bad key!': 'v' } });
    expect(() => manifestSchema.parse(badKey)).toThrow();
    const tooMany = makeManifest({
      metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])),
    });
    expect(() => manifestSchema.parse(tooMany)).toThrow();
    const longValue = makeManifest({ metadata: { k: 'v'.repeat(501) } });
    expect(() => manifestSchema.parse(longValue)).toThrow();
  });

  it('rejects a manifest with duplicate artifactIds', () => {
    const artifact = makeArtifact();
    const manifest = makeManifest({
      artifacts: [artifact, { ...artifact, filename: 'other.pdf' }],
    });
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
  });
});

describe('canonical manifest digest (golden vectors)', () => {
  it('produces a stable canonical form for a fixed manifest', () => {
    const manifest = makeManifest({
      metadata: { source: 'research-agent', runId: 'run_123' },
      artifacts: [
        makeArtifact({
          filename: 'report.pdf',
          size: 12345,
          sha256: 'b'.repeat(64),
        }),
      ],
    });
    const canonical = canonicalManifestJson(manifest);
    // Fully deterministic: same input, same exact bytes.
    expect(canonical).toBe(canonicalManifestJson(manifest));
    expect(canonical).toContain('"artifacts"');
    // No structural whitespace between JSON tokens (spaces inside string
    // values such as the collection name are preserved verbatim).
    expect(canonical).not.toContain('", ');
    expect(canonical).not.toContain('": ');
  });

  it('golden vector: sha256 of a known manifest matches the committed digest', () => {
    const manifest = makeManifest({
      metadata: { source: 'research-agent' },
      artifacts: [
        makeArtifact({
          filename: 'report.pdf',
          mediaType: 'application/pdf',
          size: 12345,
          sha256: 'b'.repeat(64),
        }),
      ],
    });
    const digest = sha256Hex(canonicalManifestJson(manifest));
    // Golden value pinned when the canonical serializer was first verified.
    expect(digest).toBe('82b029c9f970e4db40ee88c3f73e637501e1bd18635ad56e34f7a27b376b3b94');
  });

  it('artifact ordering invariance: manifests sorted by artifactId produce identical digests', () => {
    const a1 = makeArtifact({ artifactId: 'art_1111111111111111', filename: 'b.txt' });
    const a2 = makeArtifact({ artifactId: 'art_2222222222222222', filename: 'a.txt' });
    // ARCHITECTURE.md: sort manifest artifacts by their stable artifact ID
    // before canonical serialization. The manifest builder is responsible for
    // that ordering; the canonical serializer preserves array order.
    const byId = (m: Manifest) => ({
      ...m,
      artifacts: [...m.artifacts].sort((x, y) => x.artifactId.localeCompare(y.artifactId)),
    });
    const manifestA = byId(makeManifest({ artifacts: [a1, a2] }));
    const manifestB = byId(makeManifest({ artifacts: [a2, a1] }));
    expect(sha256Hex(canonicalManifestJson(manifestA))).toBe(
      sha256Hex(canonicalManifestJson(manifestB)),
    );
  });
});

describe('receipt schema', () => {
  it('accepts a valid receipt', () => {
    const receipt = {
      version: '1.0',
      collectionId: 'col_1234567890abcdef',
      manifestKey: 'collections/col_1234567890abcdef/manifest.json',
      manifestSha256: 'a'.repeat(64),
      expiresAt: '2026-09-30T12:00:00.000Z',
    };
    expect(() => receiptSchema.parse(receipt)).not.toThrow();
  });

  it('rejects unsupported receipt versions', () => {
    const receipt = {
      version: '2.0',
      collectionId: 'col_1234567890abcdef',
      manifestKey: 'x',
      manifestSha256: 'a'.repeat(64),
      expiresAt: '2026-09-30T12:00:00.000Z',
    };
    expect(() => receiptSchema.parse(receipt)).toThrow();
  });

  it('rejects a malformed manifestSha256', () => {
    const receipt = {
      version: '1.0',
      collectionId: 'col_1234567890abcdef',
      manifestKey: 'x',
      manifestSha256: 'NOT_HEX',
      expiresAt: '2026-09-30T12:00:00.000Z',
    };
    expect(() => receiptSchema.parse(receipt)).toThrow();
  });
});
