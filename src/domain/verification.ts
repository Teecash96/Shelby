import { z } from 'zod';

/**
 * Stable verification result types (API_CONTRACT.md flow 2). These are domain
 * results, not transport failures: `incomplete`, `invalid`, and `expired` are
 * all valid answers to a verify request.
 */

export const VERIFICATION_RESULTS = ['verified', 'incomplete', 'invalid', 'expired'] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const ARTIFACT_VERIFICATION_RESULTS = ['verified', 'missing', 'invalid'] as const;

export type ArtifactVerificationResult = (typeof ARTIFACT_VERIFICATION_RESULTS)[number];

export interface ArtifactVerification {
  artifactId: string;
  result: ArtifactVerificationResult;
  expectedSha256: string;
  actualSha256?: string;
  reason?: string;
}

export interface VerificationSummary {
  total: number;
  verified: number;
  missing: number;
  invalid: number;
}

export interface VerificationReport {
  collectionId: string;
  result: VerificationResult;
  verifiedAt: string;
  manifest: { matched: boolean; actualSha256?: string };
  artifacts: ArtifactVerification[];
  summary: VerificationSummary;
}

export const artifactVerificationSchema = z.object({
  artifactId: z.string(),
  result: z.enum(ARTIFACT_VERIFICATION_RESULTS),
  expectedSha256: z.string(),
  actualSha256: z.string().optional(),
  reason: z.string().optional(),
});

export const verificationReportSchema = z.object({
  collectionId: z.string(),
  result: z.enum(VERIFICATION_RESULTS),
  verifiedAt: z.string(),
  manifest: z.object({ matched: z.boolean(), actualSha256: z.string().optional() }),
  artifacts: z.array(artifactVerificationSchema),
  summary: z.object({
    total: z.number().int(),
    verified: z.number().int(),
    missing: z.number().int(),
    invalid: z.number().int(),
  }),
});
