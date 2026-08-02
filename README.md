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

The production dashboard is served by the same Fastify process as the API. It
provides the approved seal, receipt, verification, and recovery flow at `/`,
`/seal`, `/verify`, and `/collections/:id`. API keys stay in memory for the
current browser tab; the dashboard does not provide public collection discovery.
An agent-facing CLI (`pnpm cli`) remains available for machine callers.

The original read-only flow prototype is preserved at
[docs/prototypes/proofvault-dashboard.html](docs/prototypes/proofvault-dashboard.html)
as design evidence. The production client uses real API responses; Shelby
testnet persistence is still explicitly unverified.

## Run locally

```sh
pnpm install
cp .env.example .env
pnpm bootstrap
pnpm start
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/) for the dashboard. Enter
the configured caller key in the tab; it is not persisted by the client.

The default local caller uses the development key configured in `.env`. Replace
that key before using the service outside a local development environment. The
development caller is seeded into the index only for the local driver; Shelby
or production deployments never carry it (`SqliteCollectionIndex.open` does
not seed by default — local entry points opt in explicitly).

## Agent CLI

The CLI is a thin client over the local HTTP API. It does not duplicate
business logic and streams uploads/downloads.

```sh
# seal one or more artifacts (same idempotency key retries safely)
pnpm cli seal collection.json file1.txt file2.csv --idempotency-key my-key
# verify a receipt (exit 0 verified, 1 incomplete/invalid/expired, 2 usage)
pnpm cli verify receipt.json
# recover one artifact or the ZIP evidence package (streaming)
pnpm cli recover-artifact <collectionId> <artifactId> -o out.bin
pnpm cli recover-package <collectionId> -o out.zip
```

Add `--json` for machine-readable output. Configuration comes from
`PROOFVAULT_BASE_URL` (default `http://127.0.0.1:3000`) and
`PROOFVAULT_API_KEY` (default `dev-local-key`).

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
