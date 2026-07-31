import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';

/**
 * Manifest schemas derived 1:1 from `schemas/proofvault-manifest.schema.json`
 * (draft 2020-12). Field names, requiredness, bounds, and patterns mirror the
 * JSON Schema exactly. Do not change these without changing the schema file
 * first.
 */

export const MANIFEST_VERSION = '1.0';

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be 64 lowercase hexadecimal characters');

export const collectionIdSchema = z
  .string()
  .regex(/^col_[A-Za-z0-9_-]{16,80}$/, 'must match ^col_[A-Za-z0-9_-]{16,80}$');

export const artifactIdSchema = z
  .string()
  .regex(/^art_[A-Za-z0-9_-]{16,80}$/, 'must match ^art_[A-Za-z0-9_-]{16,80}$');

export const mediaTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/,
    'must be a valid media type of the form type/subtype',
  );

/** RFC 3339 UTC timestamp string with an explicit timezone offset. */
export const utcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => /Z$|[+-]\d{2}:\d{2}$/.test(value), {
    message: 'must include a timezone offset (Z or +hh:mm / -hh:mm)',
  });

export const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !value.includes('/') && !value.includes('\\') && !value.includes('\u0000'),
    'must not contain path separators or NUL bytes',
  );

export const artifactSchema = z
  .object({
    artifactId: artifactIdSchema,
    filename: filenameSchema,
    mediaType: mediaTypeSchema,
    size: z.number().int().min(0).max(26214400),
    sha256: sha256Schema,
    storageKey: z.string().min(1).max(1024),
    providerRef: z.string().max(2048).optional(),
  })
  .strict();

export const metadataSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(500))
  .superRefine((record, ctx) => {
    if (Object.keys(record).length > 20) {
      ctx.addIssue({ code: 'custom', message: 'no more than 20 metadata entries' });
    }
  });

export const manifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    collectionId: collectionIdSchema,
    name: z.string().min(1).max(120),
    createdAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    hashAlgorithm: z.literal('sha256'),
    metadata: metadataSchema.optional(),
    artifacts: z.array(artifactSchema).min(1).max(20),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestArtifact = z.infer<typeof artifactSchema>;

/**
 * The manifest digest is computed over the canonical serialization of the
 * manifest with the `manifestSha256` field absent. No v1 manifest carries the
 * field, so this equals hashing the canonical manifest; the helper exists to
 * make the contract explicit and guard future self-referential versions.
 */
export function canonicalManifestJson(manifest: Manifest): string {
  return canonicalJson(manifest);
}
