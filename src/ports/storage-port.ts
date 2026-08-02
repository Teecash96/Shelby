/**
 * The only artifact persistence boundary available to application services
 * (ARCHITECTURE.md). The interface intentionally carries no SDK-specific
 * types: `@shelby-protocol/sdk` and `@aptos-labs/ts-sdk` must never leak
 * through this port.
 */
export interface StoragePutInput {
  /** Server-derived storage key. Must never be derived from raw filenames. */
  key: string;
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  contentType: string;
  /** RFC 3339 UTC timestamp at which the object may be considered expired. */
  expiresAt: string;
  /** Idempotency key for the enclosing seal request. */
  idempotencyKey: string;
}

export interface StoragePutResult {
  key: string;
  size: number;
  /** Diagnostic metadata only, never an authorization secret. */
  providerRef?: string;
}

export interface StorageGetResult {
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  contentType: string;
  size?: number;
}

/**
 * StoragePort is the only artifact persistence dependency available to
 * application services. The local and Shelby adapters must both pass the
 * shared contract suite.
 */
export interface StoragePort {
  /** Diagnostic adapter identifier ('local' | 'shelby'); never a secret. */
  readonly providerName: string;

  put(input: StoragePutInput): Promise<StoragePutResult>;
  get(key: string): Promise<StorageGetResult>;
  exists(key: string): Promise<boolean>;
}
