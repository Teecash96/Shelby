# ProofVault

ProofVault is a Shelby-native data-provenance agent: it stores digital artifacts,
records exactly what was stored, and lets a human or another agent verify those
artifacts later.

## Current phase

The local backend vertical slice is the source of truth while Shelby testnet
credentials are pending. The local adapter supports streaming seal, receipt
verification, artifact recovery, evidence-package download, caller isolation,
bounded uploads, and idempotent retries. The Shelby adapter remains behind the
same `StoragePort`; no local result is presented as testnet proof.

The production dashboard is intentionally deferred until the upload-to-receipt
flow has a reviewed prototype.

## Run locally

```sh
pnpm install
cp .env.example .env
pnpm bootstrap
pnpm start
```

The default local caller uses the development key configured in `.env`. Replace
that key before using the service outside a local development environment.

## Verify the implementation

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm build
pnpm runtime:proof
```

The Shelby contract test is skipped unless real, validated Shelby credentials
are present. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md),
[ARCHITECTURE.md](ARCHITECTURE.md), and [SECURITY.md](SECURITY.md) for the
authoritative product, boundary, and security requirements.
