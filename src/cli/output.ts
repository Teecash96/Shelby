/**
 * Machine-readable CLI output. Every command prints one JSON object on
 * stdout (`--json`) or a human summary; failures always carry a stable
 * `{ ok: false, error: { code, message, requestId } }` shape on stderr.
 * Exit codes: 0 success, 1 domain failure, 2 transport/usage error.
 */

export interface CliSuccess<T> {
  ok: true;
  data: T;
}

export interface CliFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export type CliResult<T> = CliSuccess<T> | CliFailure;

export const EXIT_OK = 0;
export const EXIT_DOMAIN = 1;
export const EXIT_TRANSPORT = 2;

/** Print a success result and return its exit code. */
export function emitSuccess<T>(result: CliSuccess<T>, json: boolean, human: (data: T) => string): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${human(result.data)}\n`);
  }
  return EXIT_OK;
}

/** Print a failure result and return its exit code. */
export function emitFailure(result: CliFailure, json: boolean): number {
  if (json) {
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(
      `error: ${result.error.message} (${result.error.code}${result.error.requestId ? `, requestId=${result.error.requestId}` : ''})\n`,
    );
  }
  return EXIT_DOMAIN;
}

/** Build a failure result from a caught error (ApiError or generic). */
export function failureFrom(error: unknown): CliFailure {
  const err = error as { code?: string; message?: string; requestId?: string; name?: string };
  return {
    ok: false,
    error: {
      code: err.code ?? (err.name === 'ApiError' ? 'API_ERROR' : 'INTERNAL_ERROR'),
      message: err.message ?? String(error),
      requestId: err.requestId,
    },
  };
}

export function isApiError(error: unknown): boolean {
  return (error as { name?: string }).name === 'ApiError';
}

/** Transport-level failures (network, malformed response) exit 2. */
export function transportExitCode(): number {
  return EXIT_TRANSPORT;
}
