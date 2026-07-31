# ProofVault Product Specification

## Product statement

ProofVault is a Shelby-native data-provenance agent that stores digital artifacts, records exactly what was stored, and lets a human or software agent verify those artifacts later.

The product promise is: **store it once, prove what it was, verify it anytime.**

## Problem

AI agents and people create reports, datasets, media, model outputs, and evidence collections. Those artifacts are commonly delivered through temporary links or application servers that are poor long-term sources of truth. A recipient needs to answer three concrete questions:

1. What files were originally submitted?
2. Are the retrieved bytes identical to the submitted bytes?
3. Can the complete collection be recovered before its declared expiration?

ProofVault answers those questions. It proves provenance and byte integrity; it does not decide whether the content is factually true or subjectively good.

## Primary actors

- **Human user:** seals a collection, receives a receipt, and later verifies or downloads it.
- **Agent caller:** invokes the same capabilities through a versioned API.
- **Operator:** configures storage, observes failures, and rotates credentials without reading private artifact contents.

## MVP flows

### Flow 1: Seal a collection

The caller submits a collection name, expiration, optional metadata, and one or more files. ProofVault validates the request, streams each file through SHA-256 hashing, stores the artifacts, creates a canonical manifest, stores that manifest, and returns a receipt.

Success means every declared artifact and the manifest are persisted by the selected storage adapter and the returned receipt can identify the manifest without exposing credentials.

### Flow 2: Verify a receipt

The caller submits a receipt. ProofVault retrieves the manifest and artifacts, validates the manifest schema, recalculates every artifact hash, and returns one of:

- `verified`: every required artifact is present and matches.
- `incomplete`: one or more artifacts cannot be retrieved.
- `invalid`: the manifest, receipt, or retrieved bytes fail integrity checks.
- `expired`: the collection expiration has passed; retrieval may no longer be possible.

### Flow 3: Recover a collection

The caller uses a valid receipt to download an individual artifact or a ZIP evidence package containing the manifest, verification report, and all retrievable artifacts.

## MVP scope

- Direct multipart file uploads only; external URL ingestion is excluded from the first release.
- One to 20 files per collection.
- Default maximum file size: 25 MiB per file and 100 MiB per request, configurable downward by operators.
- SHA-256 hashing over exact uploaded bytes.
- Versioned canonical JSON manifest.
- Pluggable local filesystem and Shelby storage adapters.
- API-key authentication for machine callers.
- Minimal web dashboard after the API vertical slice is proven.
- Explicit expiration on every collection.
- Structured, redacted logs with correlation IDs.

## Non-goals

- Determining whether stored content is true, lawful, or high quality.
- Malware scanning beyond a documented optional hook in the MVP.
- Public discovery, social feeds, token issuance, payments, or marketplaces.
- Permanent storage guarantees beyond Shelby's configured expiration and network behavior.
- Encrypting files end to end in the first vertical slice. Until encryption is implemented and reviewed, users must be warned not to upload secrets or regulated personal data.
- Production deployment before an approved UI direction, security review, and explicit release authorization.

## Success criteria

1. A clean checkout can run the local adapter without Shelby credentials.
2. A caller can seal two test files and receive a schema-valid receipt.
3. Verification passes for unchanged bytes and fails after a fixture is modified or removed.
4. Duplicate seal requests with the same idempotency key return the original result and do not create duplicate collections.
5. Unauthorized, wrong-owner, oversized, unsupported, malformed, and expired requests have stable error responses.
6. With real testnet credentials, the same contract uploads, downloads, and verifies artifacts through Shelby.
7. Testnet verification includes transaction or explorer evidence where the Shelby SDK exposes it.

## Product decisions

- **APPROVED:** ProofVault belongs to Shelby only; no third-party agent marketplace is part of the product.
- **APPROVED:** The first product is backend-first, with machine-callable seal and verify capabilities.
- **APPROVED:** Shelby is the persistent artifact and manifest layer, not an optional marketing integration.
- **ASSUMED:** Direct upload only for the MVP. This is reversible after the chain-of-custody model is proven.
- **ASSUMED:** API keys identify callers initially. A stronger identity mechanism may replace them later without changing artifact integrity contracts.
- **LOCKED:** Missing Shelby credentials must never be replaced with invented values or fake testnet-success claims.
