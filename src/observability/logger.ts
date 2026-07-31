/**
 * Structured logger (SECURITY.md observability). Logs request ID, caller ID,
 * operation, collection ID, artifact count, aggregate bytes, status, duration,
 * adapter, retry count, and stable error code. Never logs filenames by
 * default, artifact bytes, metadata values, receipts, API keys, or raw
 * upstream responses.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  requestId?: string;
  callerId?: string;
  operation?: string;
  collectionId?: string;
  artifactCount?: number;
  bytes?: number;
  status?: string;
  durationMs?: number;
  adapter?: string;
  retryCount?: number;
  errorCode?: string;
  [key: string]: unknown;
}

/** Values that must never be logged, even inside nested errors. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'authorizationheader',
  'api_key',
  'apikey',
  'x-api-key',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'private_key',
  'privatekey',
  'password',
  'bearer',
  'signature',
  'signedurl',
  'shelby_account_private_key',
  'shelby_api_key',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Recursively redact sensitive keys and truncate values. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}...[truncated]`;
  }
  return value;
}

export interface Logger {
  child(fields: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(level: LogLevel = 'info', baseFields: LogFields = {}): Logger {
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;

  const write = (messageLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[messageLevel] < threshold) return;
    const record = {
      level: messageLevel,
      message,
      timestamp: new Date().toISOString(),
      ...baseFields,
      ...fields,
    };
    // JSON with redaction applied to the whole record as a final safety net.
    process.stdout.write(`${JSON.stringify(redact(record))}\n`);
  };

  return {
    child: (fields) => createLogger(level, { ...baseFields, ...fields }),
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
