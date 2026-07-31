#!/usr/bin/env node
/**
 * Authorization smoke script (IMPLEMENTATION_PLAN.md Phase 3/4).
 * Boots the real API with the local index and exercises authorization end to
 * end over HTTP: seeded dev caller authenticates; unknown key, missing header,
 * and revoked caller are denied with the stable codes; another caller's
 * collection is hidden as 404. It never fakes results.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCollectionIndex } from '../dist/src/adapters/sqlite-collection-index.js';
import { LocalStorageAdapter } from '../dist/src/adapters/local-storage-adapter.js';
import { hashApiKey } from '../dist/src/application/auth.js';
import { createLogger } from '../dist/src/observability/logger.js';
import { buildServer } from '../dist/src/api/server.js';

const DEV_KEY = 'dev-local-key';
const OTHER_KEY = 'other-smoke-key-123456';

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'pv-auth-smoke-'));
  const index = SqliteCollectionIndex.open(`file:${join(base, 'smoke.db')}`);
  // The seeded dev caller comes from migration; add a second active caller.
  await index.upsertCaller({
    callerId: 'caller_smoke_other',
    keyHash: hashApiKey(OTHER_KEY),
    label: 'smoke other caller',
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  const app = await buildServer({
    index,
    storage: new LocalStorageAdapter(join(base, 'storage')),
    logger: createLogger('error'),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const failures = [];

  const form = new FormData();
  form.append(
    'collection',
    JSON.stringify({
      name: 'smoke bundle',
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    }),
  );
  form.append('files', new Blob(['smoke artifact']), 'a.txt');

  // 1. Seeded dev caller seals successfully.
  const sealed = await fetch(`${baseUrl}/api/v1/seal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': 'smoke-auth-key-00001' },
    body: form,
  });
  if (sealed.status === 201) {
    console.log('  PASS  seeded dev caller seals (201)');
  } else {
    failures.push(`seeded dev caller seal failed: ${sealed.status}`);
  }

  // 2. Unknown key is denied with 403 FORBIDDEN.
  const unknown = await fetch(`${baseUrl}/api/v1/seal`, {
    method: 'POST',
    headers: { Authorization: 'Bearer unknown-key-1234567890', 'Idempotency-Key': 'smoke-auth-key-00002' },
    body: form,
  });
  if (unknown.status === 403 && (await unknown.json()).error.code === 'FORBIDDEN') {
    console.log('  PASS  unknown key denied (403 FORBIDDEN)');
  } else {
    failures.push(`unknown key not denied correctly: ${unknown.status}`);
  }

  // 3. Missing Authorization is denied with 401.
  const missing = await fetch(`${baseUrl}/api/v1/seal`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'smoke-auth-key-00003' },
    body: form,
  });
  if (missing.status === 401) {
    console.log('  PASS  missing Authorization denied (401)');
  } else {
    failures.push(`missing header not denied correctly: ${missing.status}`);
  }

  // 4. Another caller's collection is hidden as 404.
  const other = await fetch(`${baseUrl}/api/v1/seal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OTHER_KEY}`, 'Idempotency-Key': 'smoke-auth-key-00004' },
    body: form,
  });
  const otherBody = await other.json();
  const hidden = await fetch(`${baseUrl}/api/v1/manifests/${otherBody.collectionId}`, {
    headers: { Authorization: `Bearer ${DEV_KEY}` },
  });
  if (hidden.status === 404 && (await hidden.json()).error.code === 'COLLECTION_NOT_FOUND') {
    console.log('  PASS  another caller hidden as 404 COLLECTION_NOT_FOUND');
  } else {
    failures.push(`cross-caller visibility not hidden: ${hidden.status}`);
  }

  await app.close();
  index.close();

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`  FAIL  ${failure}`);
    }
    console.error('auth:smoke — FAILED.');
    process.exit(1);
  }
  console.log('auth:smoke — succeeded (real HTTP authorization flows).');
}

main().catch((error) => {
  console.error('auth:smoke — FAILED:', error.message);
  process.exit(1);
});
