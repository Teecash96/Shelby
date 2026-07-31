#!/usr/bin/env node
/**
 * Idempotent repository bootstrap (IMPLEMENTATION_PLAN.md Phase 0/3).
 * - Validates the environment and fails closed on an invalid STORAGE_DRIVER.
 * - Creates the local data directories.
 * - Opens the collection index (runs migrations + deterministic seed) when
 *   the driver is local.
 * - Reports the effective (non-secret) configuration.
 * Safe to run repeatedly; identical state on every run.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteCollectionIndex } from '../dist/src/adapters/sqlite-collection-index.js';
import { loadConfig } from '../dist/src/config/env.js';

function main() {
  const config = loadConfig();
  const driver = config.STORAGE_DRIVER;

  if (driver === 'local') {
    const localDir = resolve(config.LOCAL_STORAGE_DIR);
    mkdirSync(localDir, { recursive: true });
    console.log(`Local storage directory ready: ${localDir}`);

    const index = SqliteCollectionIndex.open(config.DATABASE_URL);
    const version = index.migrate();
    index.close();
    console.log(`Collection index ready (schema version ${version}).`);
  }

  const summary = {
    driver,
    node: process.version,
    localDir: driver === 'local' ? resolve(config.LOCAL_STORAGE_DIR) : undefined,
    database: driver === 'local' ? config.DATABASE_URL : undefined,
    maxFiles: config.MAX_FILES_PER_COLLECTION,
    maxFileBytes: config.MAX_FILE_BYTES,
    maxRequestBytes: config.MAX_REQUEST_BYTES,
  };
  console.log('Bootstrap summary (secrets excluded):');
  console.log(JSON.stringify(summary, null, 2));
  console.log('Bootstrap succeeded.');
}

main();
