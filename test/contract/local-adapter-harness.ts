import { LocalStorageAdapter } from '../../src/adapters/local-storage-adapter.js';
import type { AdapterHarness } from './storage-contract.js';

export const localAdapterHarness: AdapterHarness = {
  name: 'local',
  makeAdapter: (dataDir) => new LocalStorageAdapter(dataDir),
  objectPath: (dataDir, key) => `${dataDir}/${key}`,
  corruptObject: async (dataDir, key) => {
    const { unlink } = await import('node:fs/promises');
    await unlink(`${dataDir}/${key}`);
  },
};
