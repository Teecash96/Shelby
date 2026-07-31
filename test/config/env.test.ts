import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('defaults to the local driver when STORAGE_DRIVER is absent', () => {
    const config = loadConfig({});
    expect(config.STORAGE_DRIVER).toBe('local');
    expect('LOCAL_STORAGE_DIR' in config && config.LOCAL_STORAGE_DIR).toBe('.proofvault/storage');
  });

  it('accepts an explicit local driver with custom paths', () => {
    const config = loadConfig({
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: '/tmp/pv-data',
      DATABASE_URL: 'file:/tmp/pv.db',
    });
    expect(config.STORAGE_DRIVER).toBe('local');
    expect('LOCAL_STORAGE_DIR' in config && config.LOCAL_STORAGE_DIR).toBe('/tmp/pv-data');
  });

  it('rejects an unknown STORAGE_DRIVER', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 'ftp' })).toThrow(/STORAGE_DRIVER/);
  });

  it('fails closed for shelby when required variables are missing', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 'shelby' })).toThrow(/Shelby driver selected but environment is incomplete/);
  });

  it('fails closed for shelby with an invalid network', () => {
    expect(() =>
      loadConfig({
        STORAGE_DRIVER: 'shelby',
        SHELBY_NETWORK: 'mainnet',
        SHELBY_RPC_ENDPOINT: 'https://api.testnet.shelby.xyz/shelby',
        APTOS_FULLNODE_ENDPOINT: 'https://api.testnet.aptoslabs.com/v1',
        APTOS_INDEXER_ENDPOINT: 'https://api.testnet.aptoslabs.com/v1/graphql',
        SHELBY_API_KEY: 'k',
        SHELBY_ACCOUNT_ADDRESS: '0x1',
        SHELBY_ACCOUNT_PRIVATE_KEY: '0x2',
      }),
    ).toThrow();
  });

  it('accepts a complete shelby configuration', () => {
    const config = loadConfig({
      STORAGE_DRIVER: 'shelby',
      SHELBY_NETWORK: 'testnet',
      SHELBY_RPC_ENDPOINT: 'https://api.testnet.shelby.xyz/shelby',
      APTOS_FULLNODE_ENDPOINT: 'https://api.testnet.aptoslabs.com/v1',
      APTOS_INDEXER_ENDPOINT: 'https://api.testnet.aptoslabs.com/v1/graphql',
      SHELBY_API_KEY: 'shelby-key',
      SHELBY_ACCOUNT_ADDRESS: '0xaccount',
      SHELBY_ACCOUNT_PRIVATE_KEY: '0xprivate',
    });
    expect(config.STORAGE_DRIVER).toBe('shelby');
    expect('SHELBY_NETWORK' in config && config.SHELBY_NETWORK).toBe('testnet');
  });

  it('enforces numeric policy bounds', () => {
    expect(() => loadConfig({ MAX_FILES_PER_COLLECTION: '0' })).toThrow();
    expect(() => loadConfig({ MAX_FILE_BYTES: '-1' })).toThrow();
  });
});
