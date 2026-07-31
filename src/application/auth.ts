import { createHash, timingSafeEqual } from 'node:crypto';
import { ProofVaultError } from '../domain/errors.js';
import type { CallerRecord, CollectionIndexPort } from '../ports/collection-index-port.js';

export const hashApiKey = (apiKey: string): string =>
  createHash('sha256').update(apiKey, 'utf8').digest('hex');

/**
 * Authenticate a bearer API key against the one-way key hashes in the index.
 * Returns the caller record, or throws with the stable domain codes:
 * - AUTHENTICATION_REQUIRED: no key presented;
 * - FORBIDDEN: unknown key or revoked caller.
 * Unknown keys and revoked callers both map to FORBIDDEN so the two states
 * are indistinguishable to callers.
 */
export async function authenticateCaller(
  index: CollectionIndexPort,
  authorizationHeader: string | undefined,
): Promise<CallerRecord> {
  if (authorizationHeader === undefined || authorizationHeader === '') {
    throw new ProofVaultError('AUTHENTICATION_REQUIRED', 'A valid API key is required.');
  }
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (match === null) {
    throw new ProofVaultError(
      'AUTHENTICATION_REQUIRED',
      'Authorization must use the Bearer scheme.',
    );
  }
  const key = match[1]?.trim() ?? '';
  if (key.length === 0) {
    throw new ProofVaultError('AUTHENTICATION_REQUIRED', 'A valid API key is required.');
  }
  const keyHash = hashApiKey(key);
  const caller = await index.getCallerByKeyHash(keyHash);
  if (caller === undefined || caller.status !== 'active') {
    // Indistinguishable denial for unknown keys and revoked callers.
    throw new ProofVaultError('FORBIDDEN', 'The provided API key is not authorized.');
  }
  return caller;
}

/**
 * Constant-time string comparison. Lengths are compared first; for equal
 * lengths, a timing-safe digest comparison is used.
 */
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export const hashHexEqual = safeEqual;

/**
 * Enforce caller ownership at the service boundary (SECURITY.md). Absent and
 * other-owner objects must be indistinguishable: both raise COLLECTION_NOT_FOUND.
 */
export function assertCollectionOwner(
  collectionCallerId: string,
  caller: CallerRecord,
  collectionId: string,
): void {
  if (!safeEqual(collectionCallerId, caller.callerId)) {
    throw new ProofVaultError('COLLECTION_NOT_FOUND', `No such collection: ${collectionId}`);
  }
}
