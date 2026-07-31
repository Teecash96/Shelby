# CommandCode Build Prompt

You are the implementation agent for **ProofVault**, a Shelby-native data-provenance agent. Work in this repository and treat the repository specifications as authoritative.

## Required reading

Read these files completely before changing code:

1. `PRODUCT_SPEC.md`
2. `ARCHITECTURE.md`
3. `API_CONTRACT.md`
4. `schemas/proofvault-manifest.schema.json`
5. `SECURITY.md`
6. `IMPLEMENTATION_PLAN.md`
7. `.env.example`

Resolve conflicts in this order:

```text
current user instruction
> SECURITY.md
> API_CONTRACT.md and manifest schema
> PRODUCT_SPEC.md
> ARCHITECTURE.md
> IMPLEMENTATION_PLAN.md
> implementation judgment
```

## Mission

Implement ProofVault phase by phase. The repository begins as a blank project. Build a strict TypeScript backend-first application with a deterministic local storage adapter, then add the real Shelby adapter when credentials are available. Do not begin production dashboard styling until the user approves a representative UI prototype.

The first proven vertical slice is:

```text
authenticated multipart upload
-> streaming SHA-256
-> local storage adapter
-> canonical manifest
-> receipt
-> verification retrieval
-> digest comparison
```

## Operating rules

- Use test-driven development: write the failing behavior or security test before implementation.
- Use pnpm and commit the lockfile.
- Pin supported Node and package versions; confirm Shelby SDK compatibility before choosing a framework runtime.
- Keep Shelby SDK types inside `ShelbyStorageAdapter`.
- Do not invent credentials, addresses, tokens, transactions, or testnet results.
- Default to `STORAGE_DRIVER=local` when Shelby credentials are absent.
- Never copy `~/.shelby/config.yaml` or any private key into the repository.
- Preserve streaming behavior; do not buffer whole uploads, downloads, or ZIP packages.
- Treat every uploaded byte and all client metadata as untrusted.
- Do not fetch external URLs in the MVP.
- Do not silently alter API fields, manifest fields, limits, result states, or security rules. Propose a specification change first.
- Do not deploy, create paid resources, change DNS, accept legal terms, or perform destructive data actions without explicit user authorization.
- Preserve unrelated user changes in a dirty worktree.

## Implementation sequence

Follow `IMPLEMENTATION_PLAN.md` in order. Do not skip directly to Shelby or the dashboard. After each phase:

1. run focused tests;
2. run the full relevant suite;
3. run format, lint, typecheck, and build;
4. inspect the actual output and exit codes;
5. update a checklist in your final response with verified and unverified claims;
6. stop rather than advancing if the phase is red.

## Required project commands

Create project-owned commands for:

- `format:check`
- `lint`
- `typecheck`
- `test`
- `test:contract`
- `build`
- `security:secrets`
- `security:audit`
- `bootstrap`
- `migration:replay`
- `auth:smoke`
- `runtime:proof`

Create `BUILD_VERIFICATION.json` only after these commands exist. Each verification entry must reference the real project file defining the command. The runtime-proof command must generate fresh evidence under `evidence/` and redact secrets.

## Minimum test matrix

- Manifest schema and canonical digest golden vectors.
- Local and Shelby adapters share one contract suite.
- Binary round trip and modified/missing artifact detection.
- Multipart file-count, per-file, and total-size enforcement.
- Filename traversal, normalized duplicates, control characters, and media-type rejection.
- Expiration boundaries and expired retrieval.
- Unauthenticated, revoked, wrong-caller, and guessed-ID denial.
- Idempotent replay, conflicting replay, concurrent replay, and partial-failure recovery.
- Stable API error codes and v1 receipt backward compatibility.
- Log redaction for authorization headers, API keys, upstream errors, receipts, and metadata.
- ZIP entry traversal and duplicate-name prevention.

## Shelby activation gate

Before enabling `STORAGE_DRIVER=shelby`, verify that required environment variables are present, the intended environment is testnet, and the account has the required APT and ShelbyUSD. If any prerequisite is missing, report it exactly and continue only with local-adapter work. A mocked adapter does not prove Shelby integration.

When activated, capture evidence for:

- artifact upload acknowledgement;
- manifest upload acknowledgement;
- retrieval of exact bytes;
- recalculated SHA-256 match;
- relevant transaction or explorer references exposed by the SDK;
- adapter contract-suite results.

## Completion report

Finish with four sections:

1. Verified by automated tests.
2. Verified by static checks or build.
3. Verified by real runtime proof.
4. Not verified, with exact reasons and prerequisites.

Do not use the word “complete” while any required flow is unimplemented, red, or supported only by a mock.
