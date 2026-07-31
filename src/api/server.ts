import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { authenticateCaller } from '../application/auth.js';
import type { SealResult, SealRequest, SealMultipartPart } from '../application/seal-collection.js';
import { sealCollection } from '../application/seal-collection.js';
import { verifyCollection } from '../application/verify-collection.js';
import {
  getArtifact,
  getManifest,
  streamEvidencePackage,
} from '../application/recover-collection.js';
import type { CollectionIndexPort } from '../ports/collection-index-port.js';
import type { StoragePort } from '../ports/storage-port.js';
import type { Receipt } from '../domain/receipt.js';
import { ProofVaultError, ValidationError } from '../domain/errors.js';
import type { VerificationReport } from '../domain/verification.js';
import type { Logger } from '../observability/logger.js';

export interface ServerDeps {
  index: CollectionIndexPort;
  storage: StoragePort;
  logger: Logger;
  now?: () => Date;
  maxFiles?: number;
  maxFileBytes?: number;
  maxRequestBytes?: number;
  minExpirationHours?: number;
  maxExpirationDays?: number;
}

/** Build the ProofVault API server on the given deps. */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // Multipart bodies are streamed by @fastify/multipart with its own limits;
  // the Fastify-level body limit must not truncate the multipart framing.
  // `logger: false` disables request logging entirely (structured logs come
  // from our own logger); no request-logging deprecation applies.
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  await app.register(multipart, { limits: { fileSize: deps.maxFileBytes ?? 26214400 } });

  // Request ID on every response (API_CONTRACT.md general rules).
  app.addHook('onRequest', async (request, reply) => {
    const requestId =
      request.headers['x-request-id'] ?? `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    request.headers['x-request-id'] = requestId;
    reply.header('X-Request-Id', requestId);
  });

  // Stable error envelope (API_CONTRACT.md).
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.headers['x-request-id'] as string | undefined;
    if (error instanceof ProofVaultError) {
      deps.logger.warn('request rejected', {
        requestId,
        errorCode: error.code,
        status: 'rejected',
        operation: (request as { routeOptions?: { url?: string } }).routeOptions?.url,
      });
      return reply.status(statusForCode(error.code)).send({
        error: { code: error.code, message: error.message, requestId, details: error.details },
      });
    }
    deps.logger.error('unhandled error', {
      requestId,
      errorCode: 'INTERNAL_ERROR',
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal error.', requestId, details: [] },
    });
  });

  // Auth: every route under /api/v1 requires a valid bearer key.
  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url?.startsWith('/health')) return;
    const caller = await authenticateCaller(deps.index, request.headers.authorization);
    (request as { caller?: unknown }).caller = caller;
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    const ready =
      (await deps.storage.exists('__health_probe__').catch(() => false)) === false ||
      (await deps.storage.exists('__health_probe__').catch(() => false));
    return { status: ready ? 'ready' : 'degraded' };
  });

  app.post('/api/v1/seal', async (request, reply) => {
    const caller = (request as { caller?: { callerId: string } }).caller;
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new ValidationError('Idempotency-Key header is required.', [
        { path: 'headers', reason: 'Idempotency-Key is required for mutating requests' },
      ]);
    }

    // Multipart parts are consumed lazily by the seal service so file streams
    // are drained as they are stored (never buffering a whole upload). The
    // parts iterator only advances after each file body is consumed.
    const sealRequest: SealRequest = {
      callerId: caller!.callerId,
      idempotencyKey,
      parts: multipartPartsOf(request, deps.maxFiles ?? 20),
    };
    const result = await sealCollection(sealRequest, {
      index: deps.index,
      storage: deps.storage,
      limits: {
        maxFiles: deps.maxFiles,
        maxFileBytes: deps.maxFileBytes,
        maxRequestBytes: deps.maxRequestBytes,
        minExpirationHours: deps.minExpirationHours,
        maxExpirationDays: deps.maxExpirationDays,
      },
      now: deps.now,
    });
    deps.logger.info('collection sealed', {
      requestId: request.headers['x-request-id'] as string,
      callerId: caller!.callerId,
      operation: 'seal',
      collectionId: result.collectionId,
      artifactCount: result.artifacts.length,
      status: 'sealed',
      adapter: deps.storage instanceof Object ? 'local' : undefined,
    });
    return reply.code(result.replayed ? 200 : 201).send(sealResponse(result));
  });

  app.post('/api/v1/verify', async (request) => {
    const body = request.body as { receipt?: unknown };
    if (body?.receipt === undefined) {
      throw new ValidationError('receipt is required.', [{ path: 'receipt', reason: 'required' }]);
    }
    const report = await verifyCollection(
      { receipt: body.receipt as Receipt },
      { index: deps.index, storage: deps.storage, now: deps.now },
    );
    return report;
  });

  app.get('/api/v1/manifests/:collectionId', async (request, reply) => {
    const { collectionId } = request.params as { collectionId: string };
    const receipt = await receiptForCollection(deps, collectionId, request);
    const { manifest } = await getManifest(receipt, { index: deps.index, storage: deps.storage });
    reply.header('Content-Type', 'application/json');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(manifest);
  });

  app.get('/api/v1/artifacts/:collectionId/:artifactId', async (request, reply) => {
    const { collectionId, artifactId } = request.params as {
      collectionId: string;
      artifactId: string;
    };
    const receipt = await receiptForCollection(deps, collectionId, request);
    const { manifest } = await getManifest(receipt, { index: deps.index, storage: deps.storage });
    const artifact = manifest.artifacts.find((a) => a.artifactId === artifactId);
    if (artifact === undefined) {
      throw new ProofVaultError('COLLECTION_NOT_FOUND', `No such artifact: ${artifactId}`);
    }
    const fetched = await getArtifact(artifact, { index: deps.index, storage: deps.storage });
    reply.header('Content-Type', fetched.contentType);
    if (fetched.size !== undefined) reply.header('Content-Length', fetched.size);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${sanitizeHeader(artifact.filename)}"`,
    );
    reply.header('ETag', `"${artifact.sha256}"`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(fetched.body);
  });

  app.post('/api/v1/packages/:collectionId', async (request, reply) => {
    const { collectionId } = request.params as { collectionId: string };
    const receipt = await receiptForCollection(deps, collectionId, request);
    const verification = await verifyCollection(
      { receipt },
      { index: deps.index, storage: deps.storage, now: deps.now },
    );
    const { manifest } = await getManifest(receipt, { index: deps.index, storage: deps.storage });
    const { zipStream } = await streamEvidencePackage(
      {
        receipt,
        verification,
        artifacts: manifest.artifacts,
        deps: { index: deps.index, storage: deps.storage },
      },
      () => undefined,
    );
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', 'attachment; filename="evidence.zip"');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(zipStream);
  });

  return app;
}

/** Look up a collection's receipt and enforce caller ownership at the boundary. */
async function receiptForCollection(
  deps: ServerDeps,
  collectionId: string,
  request: { headers: { authorization?: string; 'x-request-id'?: string } },
): Promise<Receipt> {
  const caller = await authenticateCaller(deps.index, request.headers.authorization);
  const snapshot = deps.index.getCollection(collectionId);
  if (snapshot === undefined) {
    throw new ProofVaultError('COLLECTION_NOT_FOUND', `No such collection: ${collectionId}`);
  }
  if (snapshot.collection.callerId !== caller.callerId) {
    // Indistinguishable from absent: never reveal another caller's collection.
    throw new ProofVaultError('COLLECTION_NOT_FOUND', `No such collection: ${collectionId}`);
  }
  if (snapshot.collection.receiptJson === null) {
    throw new ProofVaultError('COLLECTION_NOT_FOUND', `No such collection: ${collectionId}`);
  }
  if (Date.parse(snapshot.collection.expiresAt) <= Date.now()) {
    throw new ProofVaultError('COLLECTION_EXPIRED', `Collection expired: ${collectionId}`);
  }
  return JSON.parse(snapshot.collection.receiptJson) as Receipt;
}

/**
 * Lazy multipart parts adapter for the seal service. Yields structural parts
 * directly from @fastify/multipart so file bodies are consumed as the seal
 * service streams them; the parts iterator never pre-buffers a whole upload.
 */
function multipartPartsOf(
  request: FastifyRequest,
  maxFiles: number,
): AsyncIterable<SealMultipartPart> {
  const parts = request.parts();
  let fileCount = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SealMultipartPart>> {
          const { done, value } = await parts.next();
          if (done) return { done: true, value: undefined };
          if (value.type === 'field') {
            return {
              done: false,
              value: { type: 'field', fieldname: value.fieldname, value: value.value as string },
            };
          }
          fileCount += 1;
          if (fileCount > maxFiles) {
            throw new ProofVaultError(
              'VALIDATION_ERROR',
              `No more than ${maxFiles} files per collection.`,
            );
          }
          return {
            done: false,
            value: {
              type: 'file',
              fieldname: value.fieldname,
              filename: value.filename,
              mimetype: value.mimetype,
              file: value.file as unknown as AsyncIterable<Uint8Array>,
            },
          };
        },
      };
    },
  };
}

function sealResponse(result: SealResult) {
  return {
    collectionId: result.collectionId,
    status: result.status,
    replayed: result.replayed,
    receipt: result.receipt,
    artifacts: result.artifacts,
  };
}

function sanitizeHeader(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}

const STATUS_MAP: Record<string, number> = {
  AUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  FILE_TOO_LARGE: 413,
  REQUEST_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_CONFLICT: 409,
  COLLECTION_NOT_FOUND: 404,
  COLLECTION_EXPIRED: 410,
  STORAGE_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

function statusForCode(code: string): number {
  return STATUS_MAP[code] ?? 500;
}

export type { VerificationReport };
