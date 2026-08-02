import { createHash } from 'node:crypto';
import { manifestSchema } from '../domain/manifest.js';
import { receiptSchema } from '../domain/receipt.js';
import type { Receipt } from '../domain/receipt.js';
import {
  type ArtifactVerification,
  type VerificationReport,
  type VerificationResult,
} from '../domain/verification.js';
import { ValidationError } from '../domain/errors.js';
import type { CollectionIndexPort } from '../ports/collection-index-port.js';
import type { StoragePort } from '../ports/storage-port.js';
import { streamSha256 } from './hashing.js';

export interface VerifyRequest {
  receipt: Receipt;
}

interface VerifyDeps {
  index: CollectionIndexPort;
  storage: StoragePort;
  now?: () => Date;
}

/**
 * Verify a receipt (PRODUCT_SPEC flow 2). Retrieves the canonical manifest and
 * every artifact, recalculates hashes over exact bytes, and returns a stable
 * domain result: verified | incomplete | invalid | expired. All results are
 * valid answers, never transport failures.
 */
export async function verifyCollection(
  request: VerifyRequest,
  deps: VerifyDeps,
): Promise<VerificationReport> {
  const verifiedAt = (deps.now?.() ?? new Date()).toISOString();

  // Receipt syntax + version (fail closed on malformed/unsupported).
  const receiptResult = receiptSchema.safeParse(request.receipt);
  if (!receiptResult.success) {
    throw new ValidationError('Receipt is malformed or unsupported.', [
      { path: 'receipt', reason: 'invalid receipt' },
    ]);
  }
  const receipt = receiptResult.data;

  // Expiration is authoritative: an expired collection cannot be verified.
  if (Date.parse(receipt.expiresAt) <= Date.now()) {
    return {
      collectionId: receipt.collectionId,
      result: 'expired',
      verifiedAt,
      manifest: { matched: false },
      artifacts: [],
      summary: { total: 0, verified: 0, missing: 0, invalid: 0 },
    };
  }

  // Retrieve the canonical manifest.
  const manifestFetch = await deps.storage.get(receipt.manifestKey).catch(() => undefined);
  if (manifestFetch === undefined) {
    return invalidReport(receipt.collectionId, verifiedAt);
  }
  const manifestBytes = await collectBytes(manifestFetch.body);
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestDigest !== receipt.manifestSha256) {
    return invalidReport(receipt.collectionId, verifiedAt);
  }
  const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (!parsed.success) {
    return invalidReport(receipt.collectionId, verifiedAt);
  }
  const manifest = parsed.data;
  if (manifest.collectionId !== receipt.collectionId) {
    return invalidReport(receipt.collectionId, verifiedAt);
  }

  // Verify every artifact as a stream.
  const artifactResults: ArtifactVerification[] = [];
  let missing = 0;
  let invalid = 0;
  let verified = 0;
  for (const artifact of manifest.artifacts) {
    const expected = artifact.sha256;
    const fetched = await deps.storage.get(artifact.storageKey).catch(() => undefined);
    if (fetched === undefined) {
      missing += 1;
      artifactResults.push({
        artifactId: artifact.artifactId,
        result: 'missing',
        expectedSha256: expected,
      });
      continue;
    }
    const actual = await collectSha256(fetched.body);
    if (actual === expected) {
      verified += 1;
      artifactResults.push({
        artifactId: artifact.artifactId,
        result: 'verified',
        expectedSha256: expected,
        actualSha256: actual,
      });
    } else {
      invalid += 1;
      artifactResults.push({
        artifactId: artifact.artifactId,
        result: 'invalid',
        expectedSha256: expected,
        actualSha256: actual,
      });
    }
  }

  let result: VerificationResult;
  if (missing === 0 && invalid === 0) {
    result = 'verified';
  } else if (missing > 0 && invalid === 0) {
    result = 'incomplete';
  } else {
    result = 'invalid';
  }

  return {
    collectionId: receipt.collectionId,
    result,
    verifiedAt,
    manifest: { matched: true, actualSha256: manifestDigest },
    artifacts: artifactResults,
    summary: { total: manifest.artifacts.length, verified, missing, invalid },
  };
}

function invalidReport(collectionId: string, verifiedAt: string): VerificationReport {
  return {
    collectionId,
    result: 'invalid',
    verifiedAt,
    manifest: { matched: false },
    artifacts: [],
    summary: { total: 0, verified: 0, missing: 0, invalid: 0 },
  };
}

async function collectBytes(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function collectSha256(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<string> {
  const { sha256 } = await streamSha256(body);
  return sha256;
}
