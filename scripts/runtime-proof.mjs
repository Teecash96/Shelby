#!/usr/bin/env node
/**
 * Runtime proof (COMMANDCODE_PROMPT.md completion report section 3).
 * Generates fresh evidence under `evidence/` and redacts secrets.
 *
 * Proves the local seal-to-verify vertical slice end to end over HTTP:
 * authenticated multipart seal -> receipt -> verify -> artifact download
 * with recalculated SHA-256 match. Shelby testnet evidence is not produced
 * here: the adapter is implemented behind StoragePort but requires real
 * testnet credentials, which are absent from this environment.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteCollectionIndex } from '../dist/src/adapters/sqlite-collection-index.js';
import { LocalStorageAdapter } from '../dist/src/adapters/local-storage-adapter.js';
import { loadConfig } from '../dist/src/config/env.js';
import { createLogger } from '../dist/src/observability/logger.js';
import { buildServer } from '../dist/src/api/server.js';

const DEV_KEY = 'dev-local-key';

async function main() {
  const config = loadConfig();
  if (config.STORAGE_DRIVER !== 'local') {
    throw new Error('runtime:proof requires STORAGE_DRIVER=local.');
  }
  const evidenceDir = resolve('evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const logger = createLogger(config.LOG_LEVEL, { operation: 'runtime:proof' });
  const runId = `run_${Date.now()}`;

  // Isolated runtime: temp storage + temp index, so proof never pollutes dev data.
  const base = mkdtempSync(join(tmpdir(), 'pv-proof-'));
  const index = SqliteCollectionIndex.open(`file:${join(base, 'proof.db')}`);
  const app = await buildServer({
    index,
    storage: new LocalStorageAdapter(join(base, 'storage')),
    logger,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const artifactFiles = [
    { filename: 'report.txt', content: 'ProofVault runtime proof: artifact one.\n' },
    { filename: 'dataset.csv', content: 'id,value\n1,alpha\n2,beta\n' },
  ];
  const form = new FormData();
  form.append(
    'collection',
    JSON.stringify({
      name: 'Runtime proof bundle',
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      metadata: { source: 'runtime-proof', runId },
    }),
  );
  for (const file of artifactFiles) {
    form.append('files', new Blob([file.content]), file.filename);
  }

  const sealRes = await fetch(`${baseUrl}/api/v1/seal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DEV_KEY}`, 'Idempotency-Key': `runtime-proof-${runId}` },
    body: form,
  });
  const sealBody = await sealRes.json();

  const verifyRes = await fetch(`${baseUrl}/api/v1/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DEV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt: sealBody.receipt }),
  });
  const verifyBody = await verifyRes.json();

  // Download one artifact and recompute its digest over the exact bytes.
  const artifact = sealBody.artifacts[0];
  const downloadRes = await fetch(
    `${baseUrl}/api/v1/artifacts/${sealBody.collectionId}/${artifact.artifactId}`,
    { headers: { Authorization: `Bearer ${DEV_KEY}` } },
  );
  const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
  const { createHash } = await import('node:crypto');
  const downloadedSha256 = createHash('sha256').update(downloadedBytes).digest('hex');

  const summary = {
    runId,
    timestamp: new Date().toISOString(),
    driver: config.STORAGE_DRIVER,
    adapter: 'local',
    scope: 'phase-4-5-local-seal-verify-vertical-slice',
    seal: {
      status: sealRes.status,
      collectionId: sealBody.collectionId,
      replayed: sealBody.replayed,
      artifactCount: sealBody.artifacts.length,
      receiptManifestSha256: sealBody.receipt.manifestSha256,
    },
    verify: {
      status: verifyRes.status,
      result: verifyBody.result,
      summary: verifyBody.summary,
    },
    download: {
      status: downloadRes.status,
      artifactId: artifact.artifactId,
      expectedSha256: artifact.sha256,
      actualSha256: downloadedSha256,
      digestMatches: downloadedSha256 === artifact.sha256,
    },
    unverified: [
      'Shelby testnet evidence is missing: the ShelbyStorageAdapter is implemented behind StoragePort, but no real testnet upload/retrieval was run because no testnet credentials were provided in the environment. The adapter fails closed without them and the contract suite is skipped rather than mocked.',
    ],
  };

  const evidenceFile = join(evidenceDir, `runtime-proof-${runId}.json`);
  writeFileSync(evidenceFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`Runtime proof written to ${evidenceFile}`);
  console.log(JSON.stringify(summary, null, 2));

  await app.close();
  index.close();

  const ok =
    sealRes.status === 201 &&
    verifyRes.status === 200 &&
    verifyBody.result === 'verified' &&
    summary.download.digestMatches;
  if (!ok) {
    console.error('runtime:proof — FAILED: seal/verify/download did not all pass.');
    process.exit(1);
  }
  console.log('runtime:proof — verified: sealed, verified, and downloaded with matching digest.');
}

main().catch((error) => {
  console.error('runtime:proof — FAILED:', error.message);
  process.exit(1);
});
