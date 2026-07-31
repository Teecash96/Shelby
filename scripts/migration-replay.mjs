#!/usr/bin/env node
/**
 * Deterministic migration replay (IMPLEMENTATION_PLAN.md Phase 3).
 * Phase 3 (SQLite collection index) is not implemented yet, so this command
 * is a deterministic no-op that fails loudly if the environment claims a
 * schema version that does not exist.
 */
import { readFileSync } from 'node:fs';

const SCHEMA_VERSION_FILE = '.proofvault/schema-version';

function main() {
  const driver = process.env.STORAGE_DRIVER ?? 'local';
  const dbPath = process.env.DATABASE_URL ?? 'file:.proofvault/proofvault.db';
  console.log(`migration:replay — driver=${driver} database=${dbPath}`);

  let committedVersion = 0;
  try {
    committedVersion = Number.parseInt(readFileSync(SCHEMA_VERSION_FILE, 'utf8').trim(), 10);
  } catch {
    // No schema has been committed yet; version 0 is the honest state.
  }

  if (committedVersion > 0) {
    console.error(
      `Blocked: schema version ${committedVersion} is recorded but no migration code exists. ` +
        'This state must not occur after Phase 3.',
    );
    process.exit(1);
  }

  console.log('No migrations are defined yet (Phase 3 pending). Replay is a deterministic no-op.');
  console.log('migration:replay — succeeded (version 0).');
}

main();
