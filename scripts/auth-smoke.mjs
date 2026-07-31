#!/usr/bin/env node
/**
 * Authorization smoke script (IMPLEMENTATION_PLAN.md Phase 3).
 * Exercises real API calls against a running server. Phase 3 (API server,
 * SQLite index, caller ownership) is not implemented yet, so this command
 * reports the exact missing prerequisite and exits non-zero — it never fakes
 * authorization results.
 */
function main() {
  const baseUrl = process.env.PROOFVAULT_BASE_URL ?? 'http://localhost:3000';

  console.log(`auth:smoke — target ${baseUrl}`);

  const missing = [
    'Phase 3 API server (POST /api/v1/seal, POST /api/v1/verify) is not implemented yet.',
    'Phase 3 caller ownership and revoked-key handling are not implemented yet.',
    'Idempotency-key state is not implemented yet.',
  ];

  for (const reason of missing) {
    console.log(`  BLOCKED: ${reason}`);
  }
  console.error(
    'auth:smoke — FAILED: prerequisites missing. This command must not claim ' +
      'authorization proof before Phase 3. Re-run after Phase 3 is implemented.',
  );
  process.exit(1);
}

main();
