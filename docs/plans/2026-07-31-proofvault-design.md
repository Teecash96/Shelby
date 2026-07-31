# ProofVault Design

## Decision

Build ProofVault as a Shelby-native agent that seals, verifies, and recovers digital artifact collections. Shelby is the artifact and manifest persistence layer. The product is independent of external agent marketplaces.

## Product shape

The first release is an API-first service with a minimal dashboard added only after a reviewed prototype. Human and machine callers use the same application services. A caller directly uploads files, provides a collection name and expiration, and receives a receipt that identifies a canonical manifest. Verification retrieves the manifest and every available artifact, recalculates exact-byte SHA-256 hashes, and reports verified, incomplete, invalid, or expired.

## Architecture

Domain and application modules depend on `StoragePort`, not the Shelby SDK. A local filesystem adapter enables deterministic development without credentials. A Shelby adapter implements the same contract once early-access credentials and testnet funds exist. Shelby stores artifact bytes and manifests; a small database stores caller ownership, lifecycle state, idempotency, and lookup metadata.

## Security posture

Uploads are untrusted and are streamed with strict count and byte limits. The MVP does not execute, render, transform, extract, or fetch remote content. API keys identify callers, and every object access enforces ownership. The product does not claim encryption, permanent retention, remote deletion, content truth, or successful testnet storage without direct evidence.

## Delivery sequence

Build manifest contracts, canonical hashing, the storage port, and the local adapter first. Then implement ownership and idempotency, the seal vertical slice, verification and recovery, and finally the real Shelby adapter. Prototype the dashboard before production UI implementation. Every phase must provide tests and distinguish automated, static, runtime, and unverified claims.
