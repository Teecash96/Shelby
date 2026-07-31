import { describe, it } from 'vitest';
import { runStorageContractSuite, type AdapterHarness } from './storage-contract.js';
import {
  ShelbyStorageAdapter,
  type ShelbyAdapterConfig,
} from '../../src/adapters/shelby-storage-adapter.js';

/**
 * Shelby adapter contract suite (COMMANDCODE_PROMPT.md: "Local and Shelby
 * adapters share one contract suite"). The suite runs ONLY with a complete
 * real testnet configuration from the environment; without credentials it is
 * skipped, never mocked. A mocked adapter does not prove Shelby integration.
 */
export const shelbyAdapterHarness: AdapterHarness = {
  name: 'shelby',
  makeAdapter: (_dataDir) => {
    const config = shelbyConfigFromEnv();
    if (config === undefined) {
      throw new Error('Shelby contract suite requires STORAGE_DRIVER=shelby credentials');
    }
    return new ShelbyStorageAdapter(config);
  },
};

/** Read the Shelby config from the environment; undefined when incomplete. */
export function shelbyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ShelbyAdapterConfig | undefined {
  const required = [
    'SHELBY_RPC_ENDPOINT',
    'APTOS_FULLNODE_ENDPOINT',
    'APTOS_INDEXER_ENDPOINT',
    'SHELBY_ACCOUNT_ADDRESS',
    'SHELBY_ACCOUNT_PRIVATE_KEY',
  ] as const;
  for (const key of required) {
    if (env[key] === undefined || env[key] === '') return undefined;
  }
  if (env.SHELBY_NETWORK !== 'testnet') return undefined;
  return {
    network: 'testnet',
    rpcBaseUrl: env.SHELBY_RPC_ENDPOINT!,
    // The testnet RPC accepts anonymous challenges; the API key is optional.
    rpcApiKey:
      env.SHELBY_API_KEY === undefined || env.SHELBY_API_KEY === ''
        ? undefined
        : env.SHELBY_API_KEY,
    aptosFullnodeEndpoint: env.APTOS_FULLNODE_ENDPOINT!,
    aptosIndexerEndpoint: env.APTOS_INDEXER_ENDPOINT!,
    accountAddress: env.SHELBY_ACCOUNT_ADDRESS!,
    accountPrivateKey: env.SHELBY_ACCOUNT_PRIVATE_KEY!,
  };
}

const config = shelbyConfigFromEnv();

if (config === undefined) {
  // No credentials: register an explicitly skipped suite so the file is a
  // valid test file and the missing prerequisite is unambiguous. The suite
  // never runs and nothing is mocked.
  describe('storage contract suite: shelby', () => {
    it.skip('requires complete testnet credentials (SHELBY_RPC_ENDPOINT, SHELBY_API_KEY, APTOS_*, SHELBY_ACCOUNT_*)', () => {
      // Skipped by design: no credentials, no fabricated evidence.
    });
  });
} else {
  runStorageContractSuite(shelbyAdapterHarness);
}
