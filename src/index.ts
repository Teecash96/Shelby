import { loadConfig } from './config/env.js';
import { createLogger } from './observability/logger.js';
import { LocalStorageAdapter } from './adapters/local-storage-adapter.js';
import { SqliteCollectionIndex } from './adapters/sqlite-collection-index.js';
import { buildServer } from './api/server.js';

/** Boot the ProofVault API with the configured driver. Fail closed on bad env. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  if (config.STORAGE_DRIVER !== 'local') {
    logger.error('startup failed', {
      errorCode: 'INTERNAL_ERROR',
      status: 'error',
      reason:
        'Only the local storage driver is implemented; STORAGE_DRIVER=shelby is not available yet.',
    });
    throw new Error('Shelby driver is not implemented; set STORAGE_DRIVER=local.');
  }

  const storage = new LocalStorageAdapter(config.LOCAL_STORAGE_DIR);
  const index = SqliteCollectionIndex.open(config.DATABASE_URL);
  const server = await buildServer({
    index,
    storage,
    logger,
    maxFiles: config.MAX_FILES_PER_COLLECTION,
    maxFileBytes: config.MAX_FILE_BYTES,
    maxRequestBytes: config.MAX_REQUEST_BYTES,
    minExpirationHours: config.MIN_EXPIRATION_HOURS,
    maxExpirationDays: config.MAX_EXPIRATION_DAYS,
  });

  const port = config.PORT;
  await server.listen({ port, host: '0.0.0.0' });
  logger.info('server listening', {
    operation: 'startup',
    status: 'ready',
    adapter: storage.providerName,
  });
}

main().catch((error: Error) => {
  process.stderr.write(`Fatal: ${error.message}\n`);
  process.exit(1);
});
