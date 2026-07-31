import { z } from 'zod';
import { collectionIdSchema, sha256Schema, utcTimestampSchema } from './manifest.js';

/** Receipt version. Independent of the HTTP API version (API_CONTRACT.md). */
export const RECEIPT_VERSION = '1.0';

export const receiptSchema = z
  .object({
    version: z.literal(RECEIPT_VERSION),
    collectionId: collectionIdSchema,
    manifestKey: z.string().min(1).max(1024),
    manifestSha256: sha256Schema,
    expiresAt: utcTimestampSchema,
  })
  .strict();

export type Receipt = z.infer<typeof receiptSchema>;
