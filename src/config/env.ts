import { z } from 'zod';

/**
 * Environment validation (ARCHITECTURE.md environment boundary). Startup must
 * fail closed when a selected driver's required variables are missing.
 * Defaults to STORAGE_DRIVER=local when Shelby credentials are absent.
 */

const storageDriverSchema = z.enum(['local', 'shelby']);

const commonSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  STORAGE_DRIVER: storageDriverSchema.default('local'),
  MAX_FILES_PER_COLLECTION: z.coerce.number().int().min(1).max(20).default(20),
  MAX_FILE_BYTES: z.coerce.number().int().min(1).default(26214400),
  MAX_REQUEST_BYTES: z.coerce.number().int().min(1).default(104857600),
  MIN_EXPIRATION_HOURS: z.coerce.number().int().min(1).default(1),
  MAX_EXPIRATION_DAYS: z.coerce.number().int().min(1).default(365),
});

const localSchema = commonSchema.extend({
  STORAGE_DRIVER: z.literal('local').default('local'),
  LOCAL_STORAGE_DIR: z.string().min(1).default('.proofvault/storage'),
  DATABASE_URL: z.string().min(1).default('file:.proofvault/proofvault.db'),
});

const shelbySchema = commonSchema.extend({
  STORAGE_DRIVER: z.literal('shelby'),
  // The collection index is always SQLite for now (ARCHITECTURE.md); the
  // artifact backend is Shelby.
  DATABASE_URL: z.string().min(1).default('file:.proofvault/proofvault.db'),
  SHELBY_NETWORK: z.literal('testnet'),
  SHELBY_RPC_ENDPOINT: z.string().url(),
  APTOS_FULLNODE_ENDPOINT: z.string().url(),
  APTOS_INDEXER_ENDPOINT: z.string().url(),
  // The testnet RPC accepts anonymous challenges; the API key is optional.
  SHELBY_API_KEY: z.string().optional(),
  // Best-effort region hint for blob registration (required for writes).
  SHELBY_LOCATION_HINT: z.string().optional(),
  SHELBY_ACCOUNT_ADDRESS: z.string().min(1),
  SHELBY_ACCOUNT_PRIVATE_KEY: z.string().min(1),
});

export type AppConfig = z.infer<typeof localSchema> | z.infer<typeof shelbySchema>;

/**
 * Load and validate the environment. Fails closed when STORAGE_DRIVER=shelby
 * but any required Shelby variable is missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driver = env.STORAGE_DRIVER ?? 'local';
  const parsedDriver = storageDriverSchema.safeParse(driver);
  if (!parsedDriver.success) {
    throw new Error(`STORAGE_DRIVER must be 'local' or 'shelby', got: ${driver}`);
  }
  if (parsedDriver.data === 'shelby') {
    const result = shelbySchema.safeParse(env);
    if (!result.success) {
      throw new Error(
        `Shelby driver selected but environment is incomplete: ${result.error.issues
          .map((i) => `${i.path.join('.')} (${i.message})`)
          .join('; ')}`,
      );
    }
    return result.data;
  }
  const result = localSchema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Local driver environment is invalid: ${result.error.issues
        .map((i) => `${i.path.join('.')} (${i.message})`)
        .join('; ')}`,
    );
  }
  return result.data;
}
