import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server.js';
import { LocalStorageAdapter } from '../../src/adapters/local-storage-adapter.js';
import { SqliteCollectionIndex } from '../../src/adapters/sqlite-collection-index.js';
import { createLogger } from '../../src/observability/logger.js';

let app: FastifyInstance;
let index: SqliteCollectionIndex;

beforeAll(async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'pv-dashboard-'));
  index = SqliteCollectionIndex.open(`file:${join(baseDir, 'dashboard.db')}`);
  app = await buildServer({
    index,
    storage: new LocalStorageAdapter(join(baseDir, 'storage')),
    logger: createLogger('error'),
  });
});

afterAll(async () => {
  await app.close();
  index.close();
});

describe('ProofVault dashboard shell', () => {
  it('serves the production dashboard without API authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toMatch(/script-src 'nonce-[a-f0-9]+'/);
    expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(response.body).toContain('<title>ProofVault</title>');
    expect(response.body).toContain('data-dashboard');
    expect(response.body).not.toContain('__PROOFVAULT_CSP_NONCE__');
    expect(response.body).not.toContain('Review controls');
  });

  it('aliases /dashboard to the same shell', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    const dashboard = await app.inject({ method: 'GET', url: '/dashboard' });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body.replace(/nonce="[a-f0-9]+"/g, 'nonce="same"')).toBe(
      root.body.replace(/nonce="[a-f0-9]+"/g, 'nonce="same"'),
    );
  });

  it('exposes the approved flow entry routes without inventing collection data', async () => {
    for (const url of ['/seal', '/verify', '/collections', '/collections/col_example']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-dashboard');
      expect(response.body).toContain('No receipt in this tab');
    }
  });
});
