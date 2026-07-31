# ProofVault Implementation Plan

## Delivery strategy

Build one backend-first vertical slice before the dashboard. Each phase begins with failing tests, ends with fresh proof, and may not redefine a contract without updating this plan and the related specification.

## Phase 0: Repository bootstrap

1. Pin Node.js and pnpm versions.
2. Scaffold a strict TypeScript project with a committed lockfile.
3. Add format, lint, typecheck, unit test, contract test, build, secret scan, and dependency audit commands.
4. Add `.gitignore`, `.env.example`, structured logging, environment validation, and CI.
5. Record real commands in `BUILD_VERIFICATION.json` only after they exist.

Exit criteria: a clean checkout installs, tests, typechecks, and builds without Shelby credentials.

## Phase 1: Domain contracts

1. Implement manifest and receipt TypeScript schemas from `schemas/proofvault-manifest.schema.json`.
2. Implement deterministic canonical JSON serialization.
3. Add golden vectors for canonical bytes and SHA-256 digests.
4. Define stable domain errors and verification result types.

Required tests: valid manifest, every schema rejection, ordering invariance, Unicode handling, timestamp validation, unsupported version, and digest mismatch.

## Phase 2: Storage port and local adapter

1. Implement `StoragePort` without SDK-specific types.
2. Implement a streaming local filesystem adapter under a configurable data directory.
3. Prevent traversal and atomic-write partial files through temporary paths plus rename.
4. Add a shared adapter contract suite.

Required tests: put/get round trip, binary bytes, zero-byte file policy, missing key, traversal attempts, interrupted write, duplicate idempotency, and concurrent write behavior.

## Phase 3: Collection index and authorization

1. Create a versioned SQLite schema for callers, API-key hashes, collections, artifacts, and idempotency records.
2. Add deterministic local seed data.
3. Add idempotent bootstrap and migration replay scripts.
4. Implement caller ownership checks at application-service boundaries.
5. Implement an authorization smoke script that exercises real API calls.

Required proof: unauthenticated denied, revoked key denied, wrong caller denied, guessed ID hidden, migration replay deterministic, bootstrap succeeds twice.

## Phase 4: Seal vertical slice

1. Parse multipart uploads as streams with hard limits.
2. Validate metadata, expiration, filenames, counts, and media types.
3. Hash exact bytes while storing artifacts.
4. Build, canonicalize, hash, and store the manifest.
5. Commit the sealed index state and return a receipt.
6. Implement atomic idempotency and partial-failure reconciliation.

Required tests: successful multi-file seal, oversized request, unsupported file, duplicate filename, invalid expiration, replay, conflicting replay, concurrent replay, storage timeout, and partial artifact failure.

## Phase 5: Verify and recover

1. Validate receipt syntax and supported version.
2. Retrieve and hash the canonical manifest.
3. Retrieve and hash every artifact as a stream.
4. Return stable `verified`, `incomplete`, `invalid`, or `expired` results.
5. Implement authorized manifest and artifact downloads.
6. Stream a safe ZIP evidence package.

Required tests: unchanged, modified, missing, expired, malformed manifest, wrong manifest digest, unauthorized access, ZIP traversal resistance, duplicate output names, and large streaming fixture.

## Phase 6: Shelby adapter

1. Perform a minimal SDK compatibility spike using the pinned Node runtime.
2. Implement the Shelby adapter behind `StoragePort`.
3. Map only documented transient errors to retries.
4. Keep API keys and account keys in environment configuration.
5. Run the same adapter contract suite against Shelby testnet.
6. Capture upload, retrieval, digest comparison, and explorer or transaction evidence where available.

Stop if early-access credentials, APT, or ShelbyUSD are unavailable. Keep local proof green and mark Shelby runtime proof unverified; never substitute shelbynet without documenting and obtaining approval for that environment change.

## Phase 7: Dashboard prototype and implementation

1. Create a read-only clickable prototype for upload, progress, receipt, verify, invalid, incomplete, expired, and recovery states.
2. Obtain explicit approval before production UI code.
3. Implement keyboard-accessible pages with clear progress and error recovery.
4. Never render uploaded file content inline.

Target routes after approval:

- `/` product explanation and entry points;
- `/seal` upload and expiration flow;
- `/verify` receipt entry and verification report;
- `/collections/:id` owned collection details and downloads.

## Phase 8: Hardening and handoff

1. Run the full regression, secret, dependency, authorization, and adapter suites.
2. Test bounded retry, rate limit, partial failure, and reconciliation behavior.
3. Produce fresh runtime evidence and command transcript.
4. Review specification compliance before maintainability.
5. Document deployment, rollback, credential rotation, and incident response.
6. Do not deploy to production without explicit authorization.

## Definition of done

- All three product flows pass their contract and security tests.
- Local adapter proof is reproducible from a clean checkout.
- Shelby testnet proof is real and traceable, or clearly marked unverified with the exact missing prerequisite.
- No blocking security findings remain.
- The repository contains no secrets.
- Every claim in the README is classified as automated, static/build, runtime, or unverified.
