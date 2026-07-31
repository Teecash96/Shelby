import { loadConfig, type AppConfig } from './config/env.js';
import { createLogger } from './observability/logger.js';
import { LocalStorageAdapter } from './adapters/local-storage-adapter.js';
import {
  ShelbyStorageAdapter,
  type ShelbyAdapterConfig,
} from './adapters/shelby-storage-adapter.js';
import { SqliteCollectionIndex } from './adapters/sqlite-collection-index.js';
import { buildServer } from './api/server.js';
import type { StoragePort } from './ports/storage-port.js';

/**
 * Build the storage adapter for the selected driver. Fails closed when
 * STORAGE_DRIVER=shelby but the environment is incomplete (loadConfig already
 * validates this). No credentials are ever read from files or invented.
 */
export function createStorage(config: AppConfig): StoragePort {
  if (config.STORAGE_DRIVER === 'local') {
    return new LocalStorageAdapter(config.LOCAL_STORAGE_DIR);
  }
  const shelbyConfig: ShelbyAdapterConfig = {
    network: 'testnet',
    rpcBaseUrl: config.SHELBY_RPC_ENDPOINT,
    rpcApiKey: config.SHELBY_API_KEY,
    aptosFullnodeEndpoint: config.APTOS_FULLNODE_ENDPOINT,
    aptosIndexerEndpoint: config.APTOS_INDEXER_ENDPOINT,
    accountAddress: config.SHELBY_ACCOUNT_ADDRESS,
    accountPrivateKey: config.SHELBY_ACCOUNT_PRIVATE_KEY,
  };
  return new ShelbyStorageAdapter(shelbyConfig);
}

/** Boot the ProofVault API with the configured driver. Fail closed on bad env. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const storage = createStorage(config);
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
