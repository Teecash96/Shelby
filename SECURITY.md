# ProofVault Security Model

## Security objective

ProofVault must preserve caller isolation, byte integrity, and honest failure reporting while processing untrusted files. It must not claim confidentiality, truth, permanence, or successful Shelby storage without evidence.

## Data classification

- API keys, Shelby credentials, and signing keys: **secret**.
- Uploaded bytes before an encryption feature is approved: **potentially sensitive, not confidential by product guarantee**.
- Manifests and receipts: **private metadata by default**; filenames and metadata can reveal sensitive information.
- Hashes, sizes, timestamps, request IDs, and provider references: **operational metadata**.
- Logs and metrics: **restricted operational data** and must exclude file contents and secrets.

## Trust boundaries

1. Untrusted caller to API boundary.
2. Multipart parser to application service.
3. Application service to storage adapter.
4. Application service to collection index.
5. ProofVault infrastructure to Shelby testnet.
6. Operator configuration to runtime environment.

## Authentication and authorization

- Store only one-way hashes of API keys; compare in constant time where practical.
- Associate each authenticated key with a caller ID and status.
- Every manifest, artifact, verification result, and package request enforces caller ownership at the normal service boundary.
- Return indistinguishable `404` responses for absent and other-owner objects.
- Revoked keys fail immediately; rotation must allow a bounded overlap only when explicitly configured.
- Health liveness is public. Readiness details require operator access or expose only a boolean status.

Required authorization tests:

- unauthenticated seal, verify, manifest, artifact, and package requests are denied;
- one caller cannot read another caller's collection;
- a revoked key is denied;
- guessed collection and artifact IDs do not disclose existence.

## File and input validation

- Stream requests and enforce per-file, file-count, and total-request limits while reading bytes.
- Reject empty collections, zero-length filenames, path separators, control characters, duplicate normalized filenames, and unsupported media types.
- Treat client-provided `Content-Type` as a claim, not proof. Apply an allowlist and optional magic-byte inspection.
- Never execute, render inline, transform, or extract uploaded files in the MVP.
- Generate storage keys from server IDs, not raw filenames.
- Download using `attachment` and `nosniff` headers.
- ZIP package entries use sanitized unique names and cannot contain `..`, absolute paths, symlinks, or device names.

## Integrity rules

- Compute SHA-256 over exact received bytes during streaming.
- A collection becomes `sealed` only after every artifact and the canonical manifest are durably acknowledged by the selected adapter.
- Verify retrieved bytes instead of trusting storage metadata.
- Canonical serialization is deterministic and covered by golden-vector tests.
- Receipt comparison uses exact normalized values; malformed or unsupported versions fail closed.

## Replay, idempotency, and concurrency

- `Idempotency-Key` is scoped to the authenticated caller and retained at least through the collection expiration.
- Store a digest of normalized metadata and artifact descriptors (filename, media type, size,
  and SHA-256) with the idempotency record.
- Same key plus same digest returns the original response; same key plus different digest returns `409`.
- Concurrent requests for the same key must have one winner through a unique database constraint or atomic claim.
- Retries are bounded and limited to documented transient failures.

## Secret handling

- Secret values exist only in the environment or an approved secret manager.
- `.env` files, private keys, API keys, bearer tokens, full authorization headers, and signed URLs must never be committed or logged.
- Validate environment variables at startup and fail closed.
- Redaction tests must cover nested errors and upstream SDK exceptions.
- The locally generated Shelby account in `~/.shelby/config.yaml` is not copied into this repository.

## Privacy and retention

- The MVP must display and document that uploads are not end-to-end encrypted.
- Do not accept secrets, health data, financial identity documents, or other regulated personal data before encryption, deletion, and policy requirements are reviewed.
- Every collection has an expiration; reject expiration outside configured minimum and maximum bounds.
- Deleting the local index does not prove remote artifact deletion. Report remote deletion or expiry truthfully according to Shelby capabilities.
- Never promise erasure when the backing network only supports expiry.

## Abuse controls

- Rate-limit by caller ID and IP with separate seal and retrieval budgets.
- Cap concurrent uploads and verification work.
- Apply request timeouts, bounded retries, and circuit breaking around storage.
- Record aggregate byte usage per caller for cost controls.
- Do not expose arbitrary external URL fetching in the MVP, avoiding SSRF.

## Observability

Log request ID, caller ID, operation, collection ID, artifact count, aggregate bytes, status, duration, adapter, retry count, and stable error code. Do not log filenames by default, artifact bytes, metadata values, receipts, API keys, or raw upstream responses.

## Release blockers

- No real Shelby adapter contract test with testnet credentials.
- No cross-caller authorization proof.
- No idempotency concurrency test.
- Secrets found in repository history or build output.
- Dashboard implemented without explicit prototype approval.
- Any claim of encryption, deletion, permanence, or content truth not proven by the implementation and Shelby behavior.
