#!/usr/bin/env node
/**
 * Idempotent repository bootstrap (IMPLEMENTATION_PLAN.md Phase 0/3).
 * - Validates the environment and fails closed on an invalid STORAGE_DRIVER.
 * - Creates the local data directories.
 * - Reports the effective (non-secret) configuration.
 * Safe to run repeatedly; identical state on every run.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DRIVERS = ['local', 'shelby'];

function main() {
  const driver = process.env.STORAGE_DRIVER ?? 'local';
  if (!DRIVERS.includes(driver)) {
    console.error(`STORAGE_DRIVER must be one of: ${DRIVERS.join(', ')} (got '${driver}')`);
    process.exit(1);
  }

  const localDir = resolve(process.env.LOCAL_STORAGE_DIR ?? '.proofvault/storage');
  const dbUrl = process.env.DATABASE_URL ?? 'file:.proofvault/proofvault.db';

  // Directories are created idempotently.
  if (driver === 'local') {
    mkdirSync(localDir, { recursive: true });
    console.log(`Local storage directory ready: ${localDir}`);
  }

  const summary = {
    driver,
    node: process.version,
    localDir: driver === 'local' ? localDir : undefined,
    database: driver === 'local' ? dbUrl : undefined,
    // Upload policy bounds (non-secret).
    maxFiles: process.env.MAX_FILES_PER_COLLECTION ?? '20',
    maxFileBytes: process.env.MAX_FILE_BYTES ?? '26214400',
    maxRequestBytes: process.env.MAX_REQUEST_BYTES ?? '104857600',
  };
  console.log('Bootstrap summary (secrets excluded):');
  console.log(JSON.stringify(summary, null, 2));
  console.log('Bootstrap succeeded.');
}

main();
