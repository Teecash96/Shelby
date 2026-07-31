# ProofVault API Contract

## General rules

- Base path: `/api/v1`
- JSON responses use `application/json` except artifact and ZIP downloads.
- Machine callers authenticate with `Authorization: Bearer <api-key>`.
- Every response includes `X-Request-Id`.
- Mutating requests require `Idempotency-Key` with 16–128 printable ASCII characters.
- Timestamps are RFC 3339 UTC strings.
- IDs are opaque strings and must not encode secrets.
- Error shapes and codes are stable within API version 1.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be accepted.",
    "requestId": "req_...",
    "details": [
      { "path": "files", "reason": "At least one file is required." }
    ]
  }
}
```

Expected codes include `AUTHENTICATION_REQUIRED`, `FORBIDDEN`, `VALIDATION_ERROR`, `FILE_TOO_LARGE`, `REQUEST_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `IDEMPOTENCY_CONFLICT`, `COLLECTION_NOT_FOUND`, `COLLECTION_EXPIRED`, `STORAGE_UNAVAILABLE`, `RATE_LIMITED`, and `INTERNAL_ERROR`.

## `POST /api/v1/seal`

Seals a directly uploaded collection.

Request headers:

```http
Authorization: Bearer <api-key>
Idempotency-Key: <unique-key>
Content-Type: multipart/form-data
```

Multipart fields:

- `collection`: required JSON string matching:

```json
{
  "name": "Quarterly research bundle",
  "expiresAt": "2026-09-30T12:00:00.000Z",
  "metadata": {
    "source": "research-agent",
    "runId": "run_123"
  }
}
```

- `files`: one to 20 file parts.

Successful response: `201 Created`. An idempotent replay returns `200 OK` and the original body with `replayed: true`.

```json
{
  "collectionId": "col_...",
  "status": "sealed",
  "replayed": false,
  "receipt": {
    "version": "1.0",
    "collectionId": "col_...",
    "manifestKey": "collections/col_.../manifest.json",
    "manifestSha256": "64 lowercase hexadecimal characters",
    "expiresAt": "2026-09-30T12:00:00.000Z"
  },
  "artifacts": [
    {
      "artifactId": "art_...",
      "filename": "report.pdf",
      "size": 12345,
      "mediaType": "application/pdf",
      "sha256": "64 lowercase hexadecimal characters"
    }
  ]
}
```

## `POST /api/v1/verify`

Verifies a receipt and all retrievable artifacts.

```json
{
  "receipt": {
    "version": "1.0",
    "collectionId": "col_...",
    "manifestKey": "collections/col_.../manifest.json",
    "manifestSha256": "64 lowercase hexadecimal characters",
    "expiresAt": "2026-09-30T12:00:00.000Z"
  }
}
```

Successful request response: `200 OK` even when the verification result is `incomplete`, `invalid`, or `expired`, because those are domain results rather than transport failures.

```json
{
  "collectionId": "col_...",
  "result": "verified",
  "verifiedAt": "2026-08-01T10:00:00.000Z",
  "manifest": { "matched": true },
  "artifacts": [
    {
      "artifactId": "art_...",
      "result": "verified",
      "expectedSha256": "...",
      "actualSha256": "..."
    }
  ],
  "summary": { "total": 1, "verified": 1, "missing": 0, "invalid": 0 }
}
```

## `GET /api/v1/manifests/:collectionId`

Returns the validated manifest to its owning caller. `404` must not reveal whether a collection belonging to another caller exists.

## `GET /api/v1/artifacts/:collectionId/:artifactId`

Streams one artifact after caller ownership and expiration checks. Include safe `Content-Type`, `Content-Length` when known, `Content-Disposition: attachment`, `ETag` from the expected SHA-256, and `X-Content-Type-Options: nosniff`.

## `POST /api/v1/packages/:collectionId`

Creates or streams a ZIP evidence package containing:

```text
manifest.json
verification-report.json
artifacts/<sanitized-filename>
```

Large packages must be streamed. The server must reject path traversal, duplicate normalized filenames, ZIP bombs, and expired or unauthorized collections.

## Health endpoints

- `GET /health/live`: process is running; no dependency calls.
- `GET /health/ready`: selected storage and index dependencies pass bounded checks. Never expose secrets or detailed upstream responses.

## Compatibility rules

- Additive optional fields are allowed within v1.
- Removing or reinterpreting a field requires `/api/v2`.
- Receipt and manifest versions are independent of HTTP API versions.
- At least one contract test must prove an existing v1 receipt remains verifiable after additive schema changes.
