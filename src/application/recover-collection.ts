import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { manifestSchema } from '../domain/manifest.js';
import type { Manifest, ManifestArtifact } from '../domain/manifest.js';
import type { Receipt } from '../domain/receipt.js';
import { ProofVaultError } from '../domain/errors.js';
import type { VerificationReport } from '../domain/verification.js';
import type { CollectionIndexPort } from '../ports/collection-index-port.js';
import type { StoragePort } from '../ports/storage-port.js';

export interface ManifestWithRecord {
  manifest: Manifest;
  manifestSha256: string;
}

interface RecoverDeps {
  index: CollectionIndexPort;
  storage: StoragePort;
}

/** Fetch and schema-validate the manifest for a receipt. */
export async function getManifest(
  receipt: Receipt,
  deps: RecoverDeps,
): Promise<ManifestWithRecord> {
  const fetched = await deps.storage.get(receipt.manifestKey).catch(() => undefined);
  if (fetched === undefined) {
    throw new ProofVaultError(
      'COLLECTION_NOT_FOUND',
      `No such collection: ${receipt.collectionId}`,
    );
  }
  const bytes: Uint8Array[] = [];
  for await (const chunk of fetched.body) {
    bytes.push(chunk);
  }
  const total = bytes.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of bytes) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const manifestSha256 = await sha256Hex(merged);
  // The receipt's manifest digest is the integrity anchor: a schema-valid but
  // tampered manifest must never be served. Digest mismatch is
  // indistinguishable from an absent collection.
  if (manifestSha256 !== receipt.manifestSha256) {
    throw new ProofVaultError(
      'COLLECTION_NOT_FOUND',
      `No such collection: ${receipt.collectionId}`,
    );
  }
  const parsed = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(merged)));
  if (!parsed.success) {
    throw new ProofVaultError(
      'COLLECTION_NOT_FOUND',
      `No such collection: ${receipt.collectionId}`,
    );
  }
  return { manifest: parsed.data, manifestSha256 };
}

/** Stream one artifact, returning headers the HTTP layer must set. */
export async function getArtifact(
  artifact: ManifestArtifact,
  deps: RecoverDeps,
): Promise<{
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  contentType: string;
  size?: number;
}> {
  const fetched = await deps.storage.get(artifact.storageKey).catch(() => undefined);
  if (fetched === undefined) {
    throw new ProofVaultError('COLLECTION_NOT_FOUND', `No such artifact: ${artifact.artifactId}`);
  }
  return fetched;
}

/**
 * Stream a ZIP evidence package (API_CONTRACT.md packages route):
 * manifest.json, verification-report.json, artifacts/<sanitized-filename>.
 * Entries are sanitized (no path separators, no dot segments, unique
 * normalized names), so traversal and duplicate-name attacks are rejected.
 */
export async function streamEvidencePackage(
  input: {
    receipt: Receipt;
    verification: VerificationReport;
    artifacts: ManifestArtifact[];
    deps: RecoverDeps;
  },
  onEntry: (entryName: string) => void,
): Promise<{ zipStream: ReadableStream<Uint8Array>; fileCount: number }> {
  const { receipt, verification, artifacts, deps } = input;
  const manifest = (await getManifest(receipt, deps)).manifest;
  const zip = new ZipFile();

  const usedNames = new Set<string>();
  const uniqueName = (base: string): string => {
    const noNulls = base.includes('\u0000') ? base.split('\u0000').join('_') : base;
    const sanitized = noNulls
      .replace(/\//g, '_')
      .replace(/\\/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .normalize('NFC');
    const lower = sanitized.toLowerCase();
    if (usedNames.has(lower)) {
      const ext = sanitized.includes('.') ? sanitized.slice(sanitized.lastIndexOf('.')) : '';
      const stem = ext ? sanitized.slice(0, -ext.length) : sanitized;
      let candidate = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
      }
      usedNames.add(candidate.toLowerCase());
      return candidate;
    }
    usedNames.add(lower);
    return sanitized;
  };

  // Manifest (already validated).
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestName = uniqueName('manifest.json');
  zip.addBuffer(Buffer.from(manifestBytes), manifestName);
  onEntry(manifestName);

  // Verification report.
  const reportBytes = new TextEncoder().encode(JSON.stringify(verification));
  const reportName = uniqueName('verification-report.json');
  zip.addBuffer(Buffer.from(reportBytes), reportName);
  onEntry(reportName);

  // Artifacts, streamed (never buffered as a whole).
  for (const artifact of artifacts) {
    const fetched = await deps.storage.get(artifact.storageKey).catch(() => undefined);
    if (fetched === undefined) {
      // Missing artifacts are reported in the verification report; the ZIP
      // still contains everything retrievable.
      continue;
    }
    const entryName = uniqueName(`artifacts/${artifact.filename}`);
    zip.addReadStream(toNodeReadable(fetched.body), entryName);
    onEntry(entryName);
  }

  zip.end();
  const zipStream = new ReadableStream<Uint8Array>({
    start(controller) {
      zip.outputStream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      zip.outputStream.on('end', () => controller.close());
      zip.outputStream.on('error', (error: Error) => controller.error(error));
    },
  });
  return { zipStream, fileCount: usedNames.size };
}

function toNodeReadable(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>) {
  if (Symbol.asyncIterator in Object(body)) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  return Readable.from({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const { done, value } = await reader.read();
          if (done) {
            await reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value };
        },
      };
    },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}
