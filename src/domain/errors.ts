import type { ZodError } from 'zod';

/**
 * Stable domain error codes, versioned with API v1. Transport layers map these
 * codes to HTTP responses without reinterpreting them.
 */
export const DOMAIN_ERROR_CODES = [
  'AUTHENTICATION_REQUIRED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'FILE_TOO_LARGE',
  'REQUEST_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'IDEMPOTENCY_CONFLICT',
  'COLLECTION_NOT_FOUND',
  'COLLECTION_EXPIRED',
  'STORAGE_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** A single validation detail, mirroring the API contract error envelope. */
export interface ErrorDetail {
  path: string;
  reason: string;
}

export class ProofVaultError extends Error {
  readonly code: DomainErrorCode;
  readonly details: ErrorDetail[];
  /** Optional non-secret context that may be included in structured logs. */
  readonly context?: Record<string, string | number | boolean>;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: { details?: ErrorDetail[]; context?: Record<string, string | number | boolean> } = {},
  ) {
    super(message);
    this.name = 'ProofVaultError';
    this.code = code;
    this.details = options.details ?? [];
    this.context = options.context;
  }
}

export class ValidationError extends ProofVaultError {
  constructor(message: string, details?: ErrorDetail[]) {
    super('VALIDATION_ERROR', message, { details });
    this.name = 'ValidationError';
  }

  /** Build a VALIDATION_ERROR from a Zod failure with flattened paths. */
  static fromZod(error: ZodError): ValidationError {
    const details: ErrorDetail[] = [];
    for (const issue of error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '$';
      details.push({ path, reason: issue.message });
    }
    return new ValidationError('The request could not be accepted.', details);
  }
}
