#!/usr/bin/env node
/**
 * Runtime proof (COMMANDCODE_PROMPT.md completion report section 3).
 * Generates fresh evidence under `evidence/` and redacts secrets.
 *
 * Phase gate: the local seal-to-verify vertical slice is not yet implemented
 * (Phases 4-5), so this command produces honest evidence for what IS real
 * today — the local storage adapter round trip — and explicitly marks the
 * full flow unverified. It never invents transactions or runtime results.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalStorageAdapter } from '../dist/src/adapters/local-storage-adapter.js';
import { streamSha256 } from '../dist/src/application/hashing.js';
import { loadConfig } from '../dist/src/config/env.js';
import { createLogger } from '../dist/src/observability/logger.js';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const config = loadConfig();
  const evidenceDir = resolve('evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const logger = createLogger(config.LOG_LEVEL, { operation: 'runtime:proof' });

  const runId = `run_${Date.now()}`;
  const artifacts = [];
  const adapter = new LocalStorageAdapter(config.LOCAL_STORAGE_DIR);

  // Seed two deterministic artifacts and stream them through the adapter,
  // hashing the exact bytes (the same math the seal flow will use).
  for (const [name, content] of [
    ['report.txt', 'ProofVault runtime proof: artifact one.\n'],
    ['dataset.csv', 'id,value\n1,alpha\n2,beta\n'],
  ]) {
    const bytes = new TextEncoder().encode(content);
    const key = sha256Hex(bytes);
    await adapter.put({
      key,
      body: (async function* () {
        yield bytes;
      })(),
      contentType: 'text/plain',
      expiresAt: '2030-01-01T00:00:00.000Z',
      idempotencyKey: `runtime-proof-${runId}-${name}`,
    });
    const fetched = await adapter.get(key);
    const { sha256, size } = await streamSha256(streamToAsyncIterable(fetched.body));
    artifacts.push({
      name,
      key,
      sha256,
      size,
      digestMatches: sha256 === key,
      contentType: fetched.contentType,
    });
    logger.info('artifact round trip verified', {
      artifactCount: 1,
      bytes: size,
      status: 'verified',
      adapter: adapter.providerName,
    });
  }

  const allMatch = artifacts.every((a) => a.digestMatches);
  const summary = {
    runId,
    timestamp: new Date().toISOString(),
    driver: config.STORAGE_DRIVER,
    adapter: adapter.providerName,
    scope: 'phase-2-local-adapter-round-trip',
    artifacts,
    result: allMatch ? 'verified' : 'invalid',
    unverified: [
      'Seal-to-verify vertical slice (Phases 4-5) is not implemented; no receipts were produced.',
      'Shelby adapter (Phase 6) is not implemented; no testnet evidence exists.',
    ],
  };

  const evidenceFile = join(evidenceDir, `runtime-proof-${runId}.json`);
  writeFileSync(evidenceFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`Runtime proof written to ${evidenceFile}`);
  console.log(JSON.stringify(summary, null, 2));

  if (!allMatch) {
    console.error('runtime:proof — FAILED: artifact digest mismatch.');
    process.exit(1);
  }
  console.log('runtime:proof — verified for the local adapter round trip.');
}

function streamToAsyncIterable(body) {
  const reader = body.getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const { done, value } = await reader.read();
          if (done) {
            await reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value };
        },
      };
    },
  };
}

main().catch((error) => {
  console.error('runtime:proof — FAILED:', error.message);
  process.exit(1);
});
