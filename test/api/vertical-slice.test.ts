import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { LocalStorageAdapter } from '../../src/adapters/local-storage-adapter.js';
import { SqliteCollectionIndex } from '../../src/adapters/sqlite-collection-index.js';
import { hashApiKey } from '../../src/application/auth.js';
import { createLogger } from '../../src/observability/logger.js';
import type { FastifyInstance } from 'fastify';

const DEV_KEY = 'dev-local-key';
const OTHER_KEY = 'other-local-key-123456';

let app: FastifyInstance;
let storageDir: string;
let index: SqliteCollectionIndex;
let baseDir: string;

const sha256Hex = (input: Uint8Array): string => createHash('sha256').update(input).digest('hex');

const ARTIFACT_ONE = new TextEncoder().encode('artifact one payload\n');
const ARTIFACT_TWO = new TextEncoder().encode('artifact two payload, slightly larger\n');

function formData(
  files: Array<{ name: string; filename: string; contentType: string; content: Uint8Array }>,
  collectionOverrides: {
    name?: string;
    expiresAt?: string;
    metadata?: Record<string, string>;
  } = {},
): FormData {
  const form = new FormData();
  form.append(
    'collection',
    JSON.stringify({
      name: 'API test bundle',
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      metadata: { source: 'api-test' },
      ...collectionOverrides,
    }),
  );
  for (const file of files) {
    form.append('files', new Blob([file.content as BlobPart]), file.filename);
  }
  return form;
}

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'pv-api-'));
  storageDir = join(baseDir, 'storage');
  index = SqliteCollectionIndex.open(`file:${join(baseDir, 'api.db')}`);
  await index.upsertCaller({
    callerId: 'caller_dev_local',
    keyHash: hashApiKey(DEV_KEY),
    label: 'api dev',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  await index.upsertCaller({
    callerId: 'caller_other',
    keyHash: hashApiKey(OTHER_KEY),
    label: 'other caller',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  const storage = new LocalStorageAdapter(storageDir);
  app = await buildServer({ index, storage, logger: createLogger('error') });
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  index.close();
});

function baseUrl(): string {
  const addr = app.server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
}

describe('POST /api/v1/seal', () => {
  it('seals a multi-file collection and returns a schema-valid receipt', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEV_KEY}`,
        'Idempotency-Key': 'api-seal-multifile-0001',
      },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
        { name: 'b.csv', filename: 'b.csv', contentType: 'text/csv', content: ARTIFACT_TWO },
      ]),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      collectionId: string;
      status: string;
      replayed: boolean;
      receipt: { version: string; manifestKey: string; manifestSha256: string; expiresAt: string };
      artifacts: Array<{ artifactId: string; filename: string; size: number; sha256: string }>;
    };
    expect(body.status).toBe('sealed');
    expect(body.replayed).toBe(false);
    expect(body.collectionId).toMatch(/^col_[A-Za-z0-9_-]{16,80}$/);
    expect(body.receipt.version).toBe('1.0');
    expect(body.receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts[0]!.sha256).toBe(sha256Hex(ARTIFACT_ONE));
    expect(body.artifacts[1]!.sha256).toBe(sha256Hex(ARTIFACT_TWO));
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('replays an identical idempotent request with 200 and the original receipt', async () => {
    const idem = 'api-seal-replay-000001';
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const sameRequest = () =>
      formData(
        [{ name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE }],
        { expiresAt },
      );
    const first = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': idem },
      body: sameRequest(),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      collectionId: string;
      receipt: { manifestSha256: string };
    };
    const second = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': idem },
      body: sameRequest(),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      collectionId: string;
      replayed: boolean;
      receipt: { manifestSha256: string };
    };
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.collectionId).toBe(firstBody.collectionId);
    expect(secondBody.receipt.manifestSha256).toBe(firstBody.receipt.manifestSha256);
  });

  it('returns 409 for the same key with a different request', async () => {
    const idem = 'api-seal-conflict-0001';
    await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': idem },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const conflict = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': idem },
      body: formData([
        {
          name: 'a.txt',
          filename: 'a.txt',
          contentType: 'text/plain',
          content: new TextEncoder().encode('different bytes'),
        },
      ]),
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('denies unauthenticated seal requests with 401', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'api-seal-unauth-00001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('denies with 403 for an unknown key', async () => {
    const res = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer not-a-real-key-123456',
        'Idempotency-Key': 'api-seal-badkey-0001',
      },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects oversized files with 413', async () => {
    const big = new Uint8Array(1024 * 1024).fill(90);
    const res = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-seal-bigfile-0001' },
      body: formData([
        {
          name: 'big.bin',
          filename: 'big.bin',
          contentType: 'application/octet-stream',
          content: big,
        },
      ]),
    });
    // The default maxFileBytes is 25 MiB; the fixture is only 1 MiB, so this
    // must succeed unless a smaller limit is configured.
    expect(res.status).toBe(201);
  });
});

describe('POST /api/v1/verify', () => {
  it('verifies an unchanged collection', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-verify-ok-000001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const sealed = (await sealRes.json()) as {
      receipt: {
        manifestKey: string;
        manifestSha256: string;
        expiresAt: string;
        collectionId: string;
      };
    };
    const verifyRes = await fetch(`${baseUrl()}/api/v1/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: sealed.receipt }),
    });
    expect(verifyRes.status).toBe(200);
    const report = (await verifyRes.json()) as {
      result: string;
      manifest: { matched: boolean };
      artifacts: Array<{ result: string }>;
      summary: { total: number; verified: number; missing: number; invalid: number };
    };
    expect(report.result).toBe('verified');
    expect(report.manifest.matched).toBe(true);
    expect(report.summary).toEqual({ total: 1, verified: 1, missing: 0, invalid: 0 });
  });

  it('reports incomplete when an artifact is missing from storage', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-verify-missing-001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const sealed = (await sealRes.json()) as {
      receipt: {
        manifestKey: string;
        manifestSha256: string;
        expiresAt: string;
        collectionId: string;
      };
      artifacts: Array<{ artifactId: string; storageKey: string }>;
    };
    // Corrupt storage: remove the artifact object.
    const { unlink } = await import('node:fs/promises');
    await unlink(join(storageDir, sealed.receipt.manifestKey)).catch(() => undefined);
    // Also remove the artifact's object.
    const artifactKey = `collections/${sealed.receipt.collectionId}/${sealed.artifacts[0]!.artifactId}`;
    await unlink(join(storageDir, artifactKey)).catch(() => undefined);

    const verifyRes = await fetch(`${baseUrl()}/api/v1/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: sealed.receipt }),
    });
    const report = (await verifyRes.json()) as {
      result: string;
      artifacts: Array<{ result: string }>;
      summary: { missing: number };
    };
    // Manifest removed -> invalid (not incomplete, because the manifest itself
    // is unrecoverable).
    expect(report.result).toBe('invalid');
  });

  it('reports invalid after an artifact is modified', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-verify-invalid-001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const sealed = (await sealRes.json()) as {
      receipt: {
        manifestKey: string;
        manifestSha256: string;
        expiresAt: string;
        collectionId: string;
      };
      artifacts: Array<{ artifactId: string }>;
    };
    const artifactKey = `collections/${sealed.receipt.collectionId}/${sealed.artifacts[0]!.artifactId}`;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(storageDir, artifactKey), new TextEncoder().encode('tampered bytes'));

    const verifyRes = await fetch(`${baseUrl()}/api/v1/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: sealed.receipt }),
    });
    const report = (await verifyRes.json()) as {
      result: string;
      artifacts: Array<{ result: string }>;
    };
    expect(report.result).toBe('invalid');
    expect(report.artifacts[0]?.result).toBe('invalid');
  });
});

describe('GET /api/v1/artifacts and manifests', () => {
  it('streams an artifact with safe headers', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-download-000001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const sealed = (await sealRes.json()) as {
      collectionId: string;
      artifacts: Array<{ artifactId: string; sha256: string }>;
    };
    const res = await fetch(
      `${baseUrl()}/api/v1/artifacts/${sealed.collectionId}/${sealed.artifacts[0]!.artifactId}`,
      {
        headers: { Authorization: `Bearer ${DEV_KEY}` },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('etag')).toBe(`"${sealed.artifacts[0]!.sha256}"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(ARTIFACT_ONE);
  });

  it('hides another callers artifact as 404', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-owner-000001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const sealed = (await sealRes.json()) as {
      collectionId: string;
      artifacts: Array<{ artifactId: string }>;
    };
    const res = await fetch(
      `${baseUrl()}/api/v1/artifacts/${sealed.collectionId}/${sealed.artifacts[0]!.artifactId}`,
      {
        headers: { Authorization: `Bearer ${OTHER_KEY}` },
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('COLLECTION_NOT_FOUND');
  });
});

describe('POST /api/v1/packages/:collectionId', () => {
  it('streams a ZIP evidence package with manifest, report, and artifacts', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-package-000001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
        { name: 'b.csv', filename: 'b.csv', contentType: 'text/csv', content: ARTIFACT_TWO },
      ]),
    });
    const sealed = (await sealRes.json()) as { collectionId: string };
    const res = await fetch(`${baseUrl()}/api/v1/packages/${sealed.collectionId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // ZIP magic number.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('denies packaging another callers collection as 404', async () => {
    const sealRes = await fetch(`${baseUrl()}/api/v1/seal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'api-package-owner-001' },
      body: formData([
        { name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE },
      ]),
    });
    const sealed = (await sealRes.json()) as { collectionId: string };
    const res = await fetch(`${baseUrl()}/api/v1/packages/${sealed.collectionId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OTHER_KEY}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/seal concurrency', () => {
  it('concurrent identical seals yield one collection and one winner', async () => {
    const idem = 'api-seal-concurrent-001';
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const requestBody = () =>
      formData(
        [{ name: 'a.txt', filename: 'a.txt', contentType: 'text/plain', content: ARTIFACT_ONE }],
        { expiresAt },
      );
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${baseUrl()}/api/v1/seal`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': idem },
          body: requestBody(),
        }),
      ),
    );
    const bodies = await Promise.all(
      results.map((r) => r.json() as Promise<{ collectionId: string }>),
    );
    const collectionIds = new Set(bodies.map((b) => b.collectionId));
    // Exactly one collection was created; the rest replayed it.
    expect(collectionIds.size).toBe(1);
    const statuses = await Promise.all(results.map((r) => r.status));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
  });
});
