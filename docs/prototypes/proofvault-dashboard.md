# ProofVault dashboard prototype

Status: **approved design reference**. The production dashboard now lives at
`web/index.html` and is served by the Fastify process. This prototype remains
read-only and does not call the API, write files, send analytics, or touch Shelby.

## Compact design brief

- **Goal:** help a human seal a collection, understand the receipt, verify it later, and recover evidence without losing context.
- **Human and feel:** an operator handling important evidence; calm, exact, and recoverable rather than flashy or opaque.
- **Entry and exit:** enter from the Seal workspace; exit to a receipt, verification result, recovery package, or a safe retry.
- **System:** standalone responsive HTML with a quiet dark vault shell, high-contrast status colors, keyboard-first controls, and no network dependencies.
- **Signature:** the receipt is treated as a durable proof object; every result keeps the collection identity, expiration, and next safe action visible.
- **Feedback:** short state changes with an inline live announcement; medium semantic feedback for sealing, warning feedback for invalid/expired/unavailable states, and no routine haptics.
- **Rejecting:** generic dashboard metric grids and hidden recovery paths.
- **Variants:** Human view emphasizes comprehension; Agent view exposes the same flow as an API-shaped state summary. Phone, tablet, and desktop layouts retain the same state contract.

## State and transition map

| From | Trigger | Guard or input | To | Container | Feedback | Recovery or exit |
| --- | --- | --- | --- | --- | --- | --- |
| Seal entry | Choose sample files | Name and expiration valid | Sealing | Page | Progress announcement; medium semantic completion intent | Cancel or correct fields |
| Seal entry | Submit invalid form | Missing name, expiry, or files | Validation | Inline | Warning announcement | Correct and resubmit |
| Sealing | Advance mock response | Deterministic local mock | Receipt | Page | Success announcement | Verify, recover, or start again |
| Sealing | Simulate unavailable storage | Review control | Unavailable | Inline/page | Warning announcement | Retry or cancel |
| Receipt | Verify receipt | Receipt belongs to current caller | Verifying | Page | Progress announcement | Cancel or retry |
| Receipt | Open collections | Local mock has no rows | Empty collections | Page | Guidance | Start a seal |
| Verifying | Choose result | Verified, incomplete, invalid, or expired | Result | Page | Status announcement | Retry, recover, or return |
| Result | Recover package | Collection is not forbidden/expired | Recovery | Page | Progress announcement | Cancel or return |
| Result | Simulate permission denial | Wrong caller or restricted object | Permission denied | Page | Warning announcement | Return to owned collections |
| Recovery | Advance mock response | Mock package is ready | Package ready | Page | Success announcement | Simulated download or return |
| Any active flow | Cancel/back | No irreversible operation is running | Prior safe state | Page | No haptic | Preserve no data; return |

## Review checklist

- All primary and failure states are reachable from the separate review controls.
- The prototype uses deterministic local mocks and never claims backend, Shelby, native haptic, or production performance proof.
- Keyboard focus returns to the page heading after each state transition and important changes are announced through `aria-live`.
- Reduced motion removes spatial transitions while preserving state meaning.
- Production implementation was approved before the real API wiring was added.
- The production client keeps the same state language while replacing mock transitions with the documented local API contract.
