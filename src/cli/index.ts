#!/usr/bin/env node
/**
 * ProofVault agent CLI. A thin, deterministic interface over the local
 * ProofVault API (API_CONTRACT.md). No business logic lives here: every
 * command marshals the existing /api/v1 endpoints and streams responses.
 *
 * Usage:
 *   proofvault seal <collection.json> <file...> [--idempotency-key KEY] [--json]
 *   proofvault verify <receipt.json> [--json]
 *   proofvault recover-artifact <collectionId> <artifactId> -o <out> [--json]
 *   proofvault recover-package <collectionId> -o <out.zip> [--json]
 *
 * Env: PROOFVAULT_BASE_URL (default http://127.0.0.1:3000),
 *      PROOFVAULT_API_KEY (default: dev-local-key for local dev),
 *      PROOFVAULT_REQUEST_ID (optional).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/env.js';
import { ProofVaultClient } from './client.js';
import {
  emitSuccess,
  emitFailure,
  failureFrom,
  EXIT_OK,
  EXIT_DOMAIN,
  EXIT_TRANSPORT,
  type CliSuccess,
} from './output.js';

interface ParsedArgs {
  json: boolean;
  idempotencyKey?: string;
  outPath?: string;
  positionals: string[];
}

const DEV_LOCAL_KEY = 'dev-local-key';

function parseArgs(argv: string[], outFlag: string): ParsedArgs {
  const positionals: string[] = [];
  let json = false;
  let idempotencyKey: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--idempotency-key') {
      i += 1;
      idempotencyKey = argv[i];
    } else if (arg === outFlag) {
      i += 1;
      outPath = argv[i];
    } else {
      positionals.push(arg);
    }
  }
  return { json, idempotencyKey, outPath, positionals };
}

function clientFor(): ProofVaultClient {
  const config = loadConfig();
  const baseUrl = process.env.PROOFVAULT_BASE_URL ?? `http://127.0.0.1:${config.PORT}`;
  const apiKey = process.env.PROOFVAULT_API_KEY ?? DEV_LOCAL_KEY;
  return new ProofVaultClient({
    baseUrl,
    apiKey,
    requestId: process.env.PROOFVAULT_REQUEST_ID,
  });
}

/** A generated idempotency key from a content digest + timestamp. */
function generatedIdempotencyKey(files: string[]): string {
  const stamp = Date.now().toString(36);
  const digest = createHash('sha256').update(files.join('\u0000')).digest('hex').slice(0, 16);
  return `cli_${stamp}_${digest}`.slice(0, 128);
}

async function cmdSeal(argv: string[]): Promise<number> {
  const args = parseArgs(argv, '');
  if (args.positionals.length < 2) {
    process.stderr.write(
      'usage: proofvault seal <collection.json> <file...> [--idempotency-key KEY] [--json]\n',
    );
    return EXIT_TRANSPORT;
  }
  const collectionJson = readFileSync(args.positionals[0]!, 'utf8');
  const files = args.positionals.slice(1).map((p) => ({ path: p }));
  const idem = args.idempotencyKey ?? generatedIdempotencyKey(args.positionals.slice(1));
  try {
    const { status, body } = await clientFor().seal(collectionJson, files, idem);
    const data = {
      status,
      replayed: body.replayed,
      collectionId: body.collectionId,
      receipt: body.receipt,
      artifacts: body.artifacts,
    };
    return emitSuccess({ ok: true, data } satisfies CliSuccess<typeof data>, args.json, (d) => {
      const lines = [
        d.replayed
          ? `replayed (200): ${d.collectionId}`
          : `sealed (${d.status}): ${d.collectionId}`,
        `receipt: ${JSON.stringify(d.receipt)}`,
        `artifacts: ${d.artifacts.length}`,
      ];
      return lines.join('\n');
    });
  } catch (error) {
    return emitFailure(failureFrom(error), args.json);
  }
}

async function cmdVerify(argv: string[]): Promise<number> {
  const args = parseArgs(argv, '');
  if (args.positionals.length < 1) {
    process.stderr.write('usage: proofvault verify <receipt.json> [--json]\n');
    return EXIT_TRANSPORT;
  }
  const receipt = JSON.parse(readFileSync(args.positionals[0]!, 'utf8')) as unknown;
  try {
    const { status, body } = await clientFor().verify(receipt);
    const data = {
      status,
      result: body.result,
      summary: body.summary,
      artifacts: body.artifacts,
      verifiedAt: body.verifiedAt,
    };
    const ok = emitSuccess({ ok: true, data } satisfies CliSuccess<typeof data>, args.json, (d) => {
      return `verify (${d.status}): ${d.result} — ${d.summary.verified}/${d.summary.total} verified, ${d.summary.missing} missing, ${d.summary.invalid} invalid`;
    });
    // verified -> 0; domain results (incomplete/invalid/expired) -> 1.
    return body.result === 'verified' ? ok : EXIT_DOMAIN;
  } catch (error) {
    return emitFailure(failureFrom(error), args.json);
  }
}

async function cmdRecoverArtifact(argv: string[]): Promise<number> {
  const args = parseArgs(argv, '-o');
  if (args.positionals.length < 2 || args.outPath === undefined) {
    process.stderr.write(
      'usage: proofvault recover-artifact <collectionId> <artifactId> -o <out> [--json]\n',
    );
    return EXIT_TRANSPORT;
  }
  try {
    await clientFor().recoverArtifact(args.positionals[0]!, args.positionals[1]!, args.outPath);
    const data = {
      collectionId: args.positionals[0]!,
      artifactId: args.positionals[1]!,
      out: args.outPath,
    };
    return emitSuccess(
      { ok: true, data } satisfies CliSuccess<typeof data>,
      args.json,
      (d) => `artifact ${d.artifactId} written to ${d.out}`,
    );
  } catch (error) {
    return emitFailure(failureFrom(error), args.json);
  }
}

async function cmdRecoverPackage(argv: string[]): Promise<number> {
  const args = parseArgs(argv, '-o');
  if (args.positionals.length < 1 || args.outPath === undefined) {
    process.stderr.write(
      'usage: proofvault recover-package <collectionId> -o <out.zip> [--json]\n',
    );
    return EXIT_TRANSPORT;
  }
  try {
    await clientFor().recoverPackage(args.positionals[0]!, args.outPath);
    const data = { collectionId: args.positionals[0]!, out: args.outPath };
    return emitSuccess(
      { ok: true, data } satisfies CliSuccess<typeof data>,
      args.json,
      (d) => `evidence package written to ${d.out}`,
    );
  } catch (error) {
    return emitFailure(failureFrom(error), args.json);
  }
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'seal':
      return cmdSeal(rest);
    case 'verify':
      return cmdVerify(rest);
    case 'recover-artifact':
      return cmdRecoverArtifact(rest);
    case 'recover-package':
      return cmdRecoverPackage(rest);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(
        [
          'proofvault — local data-provenance agent CLI',
          '',
          '  seal <collection.json> <file...> [--idempotency-key KEY] [--json]',
          '  verify <receipt.json> [--json]',
          '  recover-artifact <collectionId> <artifactId> -o <out> [--json]',
          '  recover-package <collectionId> -o <out.zip> [--json]',
          '',
          'Exit codes: 0 ok, 1 domain failure, 2 usage/transport error.',
        ].join('\n') + '\n',
      );
      return EXIT_OK;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      return EXIT_TRANSPORT;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${JSON.stringify(failureFrom(error))}\n`);
    process.exitCode = EXIT_TRANSPORT;
  },
);
