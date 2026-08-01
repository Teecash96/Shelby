import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { LocalStorageAdapter } from '../../src/adapters/local-storage-adapter.js';
import { SqliteCollectionIndex } from '../../src/adapters/sqlite-collection-index.js';
import { hashApiKey } from '../../src/application/auth.js';
import { createLogger } from '../../src/observability/logger.js';
import { ProofVaultClient, ApiError } from '../../src/cli/client.js';
import type { FastifyInstance } from 'fastify';

const DEV_KEY = 'dev-local-key';
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let app: FastifyInstance;
let index: SqliteCollectionIndex;
let client: ProofVaultClient;
let baseDir: string;

const artifactBytes = new TextEncoder().encode('real cli artifact bytes\n');

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'pv-cli-'));
  mkdirSync(join(baseDir, 'storage'), { recursive: true });
  index = SqliteCollectionIndex.open(`file:${join(baseDir, 'cli.db')}`, { seedDevCaller: true });
  await index.upsertCaller({
    callerId: 'caller_dev_local',
    keyHash: hashApiKey(DEV_KEY),
    label: 'cli',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  const storage = new LocalStorageAdapter(join(baseDir, 'storage'));
  app = await buildServer({ index, storage, logger: createLogger('error') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  client = new ProofVaultClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: DEV_KEY,
  });
});

afterAll(async () => {
  await app.close();
  index.close();
});

function writeFixture(name: string, content: Uint8Array): string {
  const path = join(baseDir, name);
  writeFileSync(path, content);
  return path;
}

function collectionJson(name = 'cli collection'): string {
  return JSON.stringify({
    name,
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    metadata: { source: 'cli-test' },
  });
}

describe('ProofVaultClient seal', () => {
  it('seals one artifact with a schema-valid receipt and exact hash', async () => {
    const filePath = writeFixture('one.txt', artifactBytes);
    const { status, body } = await client.seal(collectionJson(), [{ path: filePath }], 'cli-test-seal-000001');
    expect(status).toBe(201);
    expect(body.collectionId).toMatch(/^col_/);
    expect(body.receipt.version).toBe('1.0');
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.sha256).toBe(sha256Hex(artifactBytes));
    expect(body.artifacts[0]!.size).toBe(artifactBytes.byteLength);
  });

  it('seals multiple artifacts in one request', async () => {
    const a = writeFixture('multi-a.txt', new TextEncoder().encode('aaa'));
    const b = writeFixture('multi-b.txt', new TextEncoder().encode('bbbbbb'));
    const { body } = await client.seal(collectionJson('multi'), [{ path: a }, { path: b }], 'cli-test-seal-000002');
    expect(body.artifacts).toHaveLength(2);
  });

  it('replays the same idempotency key with the original receipt', async () => {
    const filePath = writeFixture('replay.txt', artifactBytes);
    // Fixed expiry so both requests produce the identical request digest.
    const fixedJson = JSON.stringify({
      name: 'cli replay',
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      metadata: { source: 'cli-test' },
    });
    const first = await client.seal(fixedJson, [{ path: filePath }], 'cli-test-seal-000003');
    const second = await client.seal(fixedJson, [{ path: filePath }], 'cli-test-seal-000003');
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.collectionId).toBe(first.body.collectionId);
    expect(second.body.receipt.manifestSha256).toBe(first.body.receipt.manifestSha256);
  });

  it('throws ApiError 409 for the same key with different files', async () => {
    const filePath = writeFixture('conflict.txt', artifactBytes);
    await client.seal(collectionJson(), [{ path: filePath }], 'cli-test-seal-000004');
    const other = writeFixture('conflict-other.txt', new TextEncoder().encode('different'));
    await expect(
      client.seal(collectionJson(), [{ path: other }], 'cli-test-seal-000004'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('throws ApiError 401 without a valid key', async () => {
    const bad = new ProofVaultClient({ baseUrl: clientBaseUrl(), apiKey: 'nope' });
    const filePath = writeFixture('unauth.txt', artifactBytes);
    await expect(bad.seal(collectionJson(), [{ path: filePath }], 'cli-test-seal-000005')).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('ProofVaultClient verify and recover', () => {
  it('verifies a sealed collection', async () => {
    const filePath = writeFixture('verify.txt', artifactBytes);
    const { body: sealed } = await client.seal(collectionJson(), [{ path: filePath }], 'cli-test-verify-0001');
    const { body } = await client.verify(sealed.receipt);
    expect(body.result).toBe('verified');
    expect(body.summary).toEqual({ total: 1, verified: 1, missing: 0, invalid: 0 });
  });

  it('recovers an artifact to disk with the exact bytes', async () => {
    const filePath = writeFixture('recover.txt', artifactBytes);
    const { body: sealed } = await client.seal(collectionJson(), [{ path: filePath }], 'cli-test-recover-0001');
    const artifact = sealed.artifacts[0]!;
    const outPath = join(baseDir, 'recovered.bin');
    await client.recoverArtifact(sealed.collectionId, artifact.artifactId, outPath);
    const recovered = readFileSync(outPath);
    expect(Buffer.compare(recovered, Buffer.from(artifactBytes))).toBe(0);
  });

  it('recovers a ZIP evidence package', async () => {
    const filePath = writeFixture('package.txt', artifactBytes);
    const { body: sealed } = await client.seal(collectionJson(), [{ path: filePath }], 'cli-test-package-0001');
    const outPath = join(baseDir, 'evidence.zip');
    await client.recoverPackage(sealed.collectionId, outPath);
    const bytes = readFileSync(outPath);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('throws ApiError 404 for an unknown collection', async () => {
    await expect(client.recoverPackage('col_0000000000000000', join(baseDir, 'x.zip'))).rejects.toMatchObject({
      code: 'COLLECTION_NOT_FOUND',
      status: 404,
    });
  });
});

function clientBaseUrl(): string {
  const addr = app.server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
}
