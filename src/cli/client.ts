/**
 * Thin HTTP client over the ProofVault API contract (API_CONTRACT.md).
 * The CLI never duplicates business logic: it only marshals requests and
 * streams responses against the existing /api/v1 endpoints. Downloads stream
 * to disk; uploads stream from files (no whole-file buffering).
 */

export interface CliConfig {
  baseUrl: string;
  apiKey: string;
  requestId?: string;
  fetchImpl?: typeof fetch;
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  requestId?: string;
  details?: Array<{ path: string; reason: string }>;
}

/** Full API error response: { error: { code, message, requestId, details } }. */
export interface ErrorResponse {
  error?: ErrorEnvelope;
}

export class ApiError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly details?: ErrorEnvelope['details'];
  readonly status: number;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.requestId = envelope.requestId;
    this.details = envelope.details;
    this.status = status;
  }
}

export interface SealResponse {
  collectionId: string;
  status: 'sealed';
  replayed: boolean;
  receipt: {
    version: string;
    collectionId: string;
    manifestKey: string;
    manifestSha256: string;
    expiresAt: string;
  };
  artifacts: Array<{
    artifactId: string;
    filename: string;
    size: number;
    mediaType: string;
    sha256: string;
  }>;
}

export interface VerifyResponse {
  collectionId: string;
  result: 'verified' | 'incomplete' | 'invalid' | 'expired';
  verifiedAt: string;
  manifest: { matched: boolean; actualSha256?: string };
  artifacts: Array<{
    artifactId: string;
    result: string;
    expectedSha256: string;
    actualSha256?: string;
  }>;
  summary: { total: number; verified: number; missing: number; invalid: number };
}

export class ProofVaultClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CliConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.requestId = config.requestId ?? `cli_${cryptoRandomId()}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Seal one or more artifacts. The same idempotency key retries safely. */
  async seal(
    collectionJson: string,
    files: Array<{ path: string; filename?: string; mediaType?: string }>,
    idempotencyKey: string,
  ): Promise<{ status: number; body: SealResponse }> {
    // Streaming multipart body: Node's FormData/File does not stream file
    // parts (it stringifies streams), so build the multipart stream manually.
    const { createReadStream } = await import('node:fs');
    const { basename } = await import('node:path');
    const { Readable } = await import('node:stream');
    const boundary = `----pvcliboundary${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();

    const header = (name: string, value: string): Uint8Array =>
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    const fileHeader = (filename: string, mediaType: string): Uint8Array =>
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`,
      );
    const footer = encoder.encode(`--${boundary}--\r\n`);

    const sources: Array<ReadableStream<Uint8Array>> = [];
    sources.push(streamOf(header('collection', collectionJson)));
    for (const file of files) {
      const filename = file.filename ?? basename(file.path);
      const mediaType = file.mediaType ?? 'application/octet-stream';
      sources.push(streamOf(fileHeader(filename, mediaType)));
      sources.push(Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>);
      sources.push(streamOf(encoder.encode('\r\n')));
    }
    sources.push(streamOf(footer));

    const body = concatStreams(sources);
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/seal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Idempotency-Key': idempotencyKey,
        'X-Request-Id': this.requestId,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body as BodyInit,
      // undici requires duplex for stream bodies; the TS lib type lags.
      duplex: 'half',
    } as RequestInit);
    const bodyJson = (await res.json()) as SealResponse | ErrorResponse;
    if (!res.ok) {
      throw toApiError(res.status, bodyJson);
    }
    return { status: res.status, body: bodyJson as SealResponse };
  }

  /** Verify a receipt. Domain results (incomplete/invalid/expired) are 200. */
  async verify(receipt: unknown): Promise<{ status: number; body: VerifyResponse }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-Id': this.requestId,
      },
      body: JSON.stringify({ receipt }),
    });
    const body = (await res.json()) as VerifyResponse | ErrorResponse;
    if (!res.ok) {
      throw toApiError(res.status, body);
    }
    return { status: res.status, body: body as VerifyResponse };
  }

  /** Stream one artifact to disk (never buffered whole). */
  async recoverArtifact(collectionId: string, artifactId: string, outPath: string): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/api/v1/artifacts/${collectionId}/${artifactId}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'X-Request-Id': this.requestId,
        },
      },
    );
    if (!res.ok) {
      throw toApiError(res.status, (await res.json()) as ErrorResponse);
    }
    if (res.body === null) {
      throw new Error('artifact response has no body');
    }
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(outPath));
  }

  /** Stream the ZIP evidence package to disk (never buffered whole). */
  async recoverPackage(collectionId: string, outPath: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/packages/${collectionId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'X-Request-Id': this.requestId,
      },
    });
    if (!res.ok) {
      throw toApiError(res.status, (await res.json()) as ErrorResponse);
    }
    if (res.body === null) {
      throw new Error('package response has no body');
    }
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(outPath));
  }
}

function toApiError(status: number, response: unknown): ApiError {
  const asErrorResponse = response as ErrorResponse;
  const envelope = asErrorResponse.error ?? (response as ErrorEnvelope);
  return new ApiError(status, envelope);
}

/** A single-chunk web stream. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Concatenate web streams in order without buffering them whole. */
function concatStreams(sources: ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= sources.length) {
        controller.close();
        return;
      }
      const reader = sources[index]!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          await reader.releaseLock();
          index += 1;
          return;
        }
        controller.enqueue(value);
      }
    },
  });
}

function cryptoRandomId(): string {
  // 12 hex chars, enough for correlation.
  let out = '';
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto !== 'undefined' && 'getRandomValues' in globalThis.crypto) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
