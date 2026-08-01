#!/usr/bin/env node
/**
 * Deterministic migration replay (IMPLEMENTATION_PLAN.md Phase 3).
 * Replays all migrations on the configured database and prints the resulting
 * schema version. Replaying twice produces the identical state (version 1,
 * seed data present, no duplicates).
 */
import { SqliteCollectionIndex } from '../dist/src/adapters/sqlite-collection-index.js';
import { loadConfig } from '../dist/src/config/env.js';

function main() {
  const config = loadConfig();
  if (config.STORAGE_DRIVER !== 'local') {
    console.error('migration:replay — shelby driver has no local SQLite index; nothing to replay.');
    process.exit(1);
  }
  console.log(`migration:replay — database=${config.DATABASE_URL}`);

  const index = SqliteCollectionIndex.open(config.DATABASE_URL, { seedDevCaller: true });
  const version = index.migrate();
  // Determinism check: replaying again yields the same version and the same
  // single seed caller (INSERT OR IGNORE never duplicates).
  const again = index.migrate();
  const seedCaller = index.getCaller('caller_dev_local');
  index.close();

  if (again !== version || seedCaller === undefined) {
    console.error('migration:replay — FAILED: replay is not deterministic.');
    process.exit(1);
  }
  console.log(`migration:replay — succeeded (schema version ${version}, seed caller present).`);
}

main();
