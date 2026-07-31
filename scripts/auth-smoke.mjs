#!/usr/bin/env node
/**
 * Authorization smoke script (IMPLEMENTATION_PLAN.md Phase 3).
 * Exercises the real authorization path against the local collection index:
 * - the seeded development caller authenticates;
 * - an unknown key is denied with FORBIDDEN;
 * - a revoked caller is denied with the indistinguishable FORBIDDEN shape.
 * The HTTP API transport (Phase 4) is not implemented yet, so this proves the
 * auth service and index end to end without a server. It never fakes results.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCollectionIndex } from '../dist/src/adapters/sqlite-collection-index.js';
import { authenticateCaller, hashApiKey } from '../dist/src/application/auth.js';

const DEV_KEY = 'dev-local-key';

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'pv-auth-smoke-')), 'smoke.db');
  const index = SqliteCollectionIndex.open(`file:${dbFile}`);
  const failures = [];

  // 1. Seeded caller authenticates with the documented dev key.
  try {
    const caller = await authenticateCaller(index, `Bearer ${DEV_KEY}`);
    console.log(`  PASS  seeded dev caller authenticates (${caller.callerId})`);
  } catch (error) {
    failures.push(`seeded dev caller failed: ${error.message}`);
  }

  // 2. Unknown key is denied with FORBIDDEN.
  try {
    await authenticateCaller(index, 'Bearer unknown-key-1234567890');
    failures.push('unknown key was NOT denied');
  } catch (error) {
    if (error.code === 'FORBIDDEN') {
      console.log('  PASS  unknown key denied (FORBIDDEN)');
    } else {
      failures.push(`unknown key denied with wrong code: ${error.code}`);
    }
  }

  // 3. Missing Authorization header is denied with AUTHENTICATION_REQUIRED.
  try {
    await authenticateCaller(index, undefined);
    failures.push('missing header was NOT denied');
  } catch (error) {
    if (error.code === 'AUTHENTICATION_REQUIRED') {
      console.log('  PASS  missing Authorization denied (AUTHENTICATION_REQUIRED)');
    } else {
      failures.push(`missing header denied with wrong code: ${error.code}`);
    }
  }

  // 4. Revoked caller is denied indistinguishably from an unknown key.
  await index.upsertCaller({
    callerId: 'caller_smoke_revoked',
    keyHash: hashApiKey('revoked-smoke-key-123456'),
    label: 'smoke revoked',
    status: 'revoked',
    createdAt: new Date().toISOString(),
  });
  try {
    await authenticateCaller(index, 'Bearer revoked-smoke-key-123456');
    failures.push('revoked key was NOT denied');
  } catch (error) {
    if (error.code === 'FORBIDDEN') {
      console.log('  PASS  revoked key denied (FORBIDDEN, indistinguishable)');
    } else {
      failures.push(`revoked key denied with wrong code: ${error.code}`);
    }
  }

  index.close();

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`  FAIL  ${failure}`);
    }
    console.error('auth:smoke — FAILED.');
    process.exit(1);
  }
  console.log('auth:smoke — succeeded (local index authorization flows).');
}

main().catch((error) => {
  console.error('auth:smoke — FAILED:', error.message);
  process.exit(1);
});
