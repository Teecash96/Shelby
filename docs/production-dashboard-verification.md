# Production dashboard verification

The approved dashboard is served by the compiled Fastify process at `/`,
`/seal`, `/verify`, and `/collections/:id`.

## Automated checks

- `pnpm exec vitest run test/api/dashboard.test.ts`: 3 route and security-header tests passed.
- `pnpm test`: 209 passed, 1 Shelby contract test skipped without credentials.
- `pnpm test:contract`: 17 local storage contract tests passed, 1 Shelby test skipped.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`: passed.
- `pnpm security:secrets`: clean.
- `pnpm security:audit`: production dependency audit passed; the documented dev-only brace-expansion advisory remains non-shipping.

## Live browser checks

Against a fresh local `pnpm start` process, the dashboard was checked for:

- API readiness status and accessible navigation landmarks;
- no-key seal validation with an inline alert and live announcement;
- real local receipt verification, returning `verified` and the artifact digest summary;
- real evidence-package recovery with a browser download-start status;
- wrong-key verification returning a redacted stable `FORBIDDEN` error with request ID;
- `/verify` and `/collections/:id` deep-link entry states.

The browser proof does not claim Shelby persistence, wallet activity, native
haptics, or production deployment. File-byte integrity remains backed by the
existing HTTP runtime proof (`pnpm runtime:proof`), which returned a verified
local collection and matching artifact SHA-256.
