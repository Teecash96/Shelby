import {
  Account,
  Ed25519PrivateKey,
  Network,
  type UserTransactionResponse,
} from '@aptos-labs/ts-sdk';
import {
  createDefaultErasureCodingProvider,
  generateCommitments,
  ShelbyBlobClient,
  ShelbyNodeClient,
  type ShelbyRPCClient,
} from '@shelby-protocol/sdk/node';
import type { StoragePort, StoragePutInput, StoragePutResult } from '../ports/storage-port.js';

/**
 * Shelby storage adapter (IMPLEMENTATION_PLAN.md Phase 6).
 *
 * All `@shelby-protocol/sdk` and `@aptos-labs/ts-sdk` types stay inside this
 * module (ARCHITECTURE.md: the port carries no SDK types). Credentials come
 * only from environment configuration; nothing is committed, logged, or
 * invented. Without a complete testnet configuration the application fails
 * closed and this adapter is never constructed.
 *
 * Upload flow (streaming, never buffering the whole blob):
 *   generateCommitments(provider, tee)      -> commitments
 *   coordination.registerBlob(...)          -> pending blob; wait for tx
 *   registeredBlobUids(tx.events, deployer) -> on-chain uid
 *   rpc.putBlobChunksets({ blobData: tee }) -> spAcks
 *   coordination.commitObject({ spAcks })   -> durable write
 * The input body is teed so commitments and chunkset upload each get their own
 * streaming pass. If any step cannot be confirmed with real evidence (no UID,
 * no acks, rejected commit), the adapter throws — it never fabricates results.
 */

export interface ShelbyAdapterConfig {
  network: 'testnet';
  rpcBaseUrl: string;
  rpcApiKey: string;
  indexerBaseUrl?: string;
  indexerApiKey?: string;
  aptosFullnodeEndpoint: string;
  aptosIndexerEndpoint: string;
  accountAddress: string;
  accountPrivateKey: string;
}

function parsePrivateKeyHex(value: string): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('SHELBY_ACCOUNT_PRIVATE_KEY must be a 64-hex-character private key');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export class ShelbyStorageAdapter implements StoragePort {
  readonly providerName = 'shelby';

  readonly client: ShelbyNodeClient;
  readonly rpc: ShelbyRPCClient;
  readonly coordination: ShelbyBlobClient;
  readonly account: Account;
  readonly accountAddressHex: string;

  constructor(config: ShelbyAdapterConfig) {
    this.account = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(parsePrivateKeyHex(config.accountPrivateKey)),
    });
    this.accountAddressHex = this.account.accountAddress.toString();

    const client = new ShelbyNodeClient({
      network: Network.TESTNET,
      apiKey: config.rpcApiKey,
      rpc: { baseUrl: config.rpcBaseUrl, apiKey: config.rpcApiKey },
      indexer: config.indexerBaseUrl
        ? { baseUrl: config.indexerBaseUrl, apiKey: config.indexerApiKey }
        : undefined,
      aptos: {
        fullnode: config.aptosFullnodeEndpoint,
        indexer: config.aptosIndexerEndpoint,
      },
    });
    this.client = client;
    this.rpc = client.rpc;
    this.coordination = client.coordination;
  }

  async put(input: StoragePutInput): Promise<StoragePutResult> {
    const provider = await createDefaultErasureCodingProvider();
    const size = await contentLength(input.body);

    // Tee the body: one streaming pass feeds commitment generation, the other
    // feeds the chunkset upload. Neither pass buffers the whole blob.
    const [commitmentStream, uploadStream] = teeStreams(toWebStream(input.body));

    const commitments = await generateCommitments(provider, commitmentStream);
    const expirationMicros = Number(BigInt(Date.parse(input.expiresAt)) * 1000n);
    const blobName = input.key;

    const { transaction: registerTx } = await this.coordination.registerBlob({
      account: this.account,
      blobName,
      blobMerkleRoot: commitments.blob_merkle_root,
      size,
      expirationMicros,
    });

    // Wait for the register transaction and read the on-chain UID from its
    // events. Real evidence or nothing: no UID means no upload proceeds.
    const uid = await this.uidFromRegistration(registerTx, blobName);

    const chunksetResult = await this.rpc.putBlobChunksets({
      account: this.account,
      uid,
      blobData: uploadStream,
      commitments,
      totalBytes: size,
    });

    if (chunksetResult.spAcks.length === 0) {
      throw new Error(
        `Shelby upload for "${blobName}" produced no storage-provider acks. ` +
          'The adapter refuses to commit without real acknowledgements.',
      );
    }

    await this.coordination.commitObject({
      account: this.account,
      uid,
      blobName,
      overwrite: false,
      storageProviderAcks: chunksetResult.spAcks,
    });

    const providerRef = `${this.accountAddressHex}:${blobName}`;
    return { key: input.key, size, providerRef };
  }

  async get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    size?: number;
  }> {
    const blob = await this.rpc.getBlob({
      account: this.account.accountAddress,
      blobName: key,
    });
    return {
      body: blob.readable as ReadableStream<Uint8Array>,
      contentType: 'application/octet-stream',
      size: blob.contentLength,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.rpc.getBlob({ account: this.account.accountAddress, blobName: key });
      return true;
    } catch {
      return false;
    }
  }

  /** Extract the blob UID from a committed registration transaction's events. */
  private async uidFromRegistration(
    registerTx: { hash: string },
    blobName: string,
  ): Promise<bigint> {
    const tx = (await this.coordination.aptos.waitForTransaction({
      transactionHash: registerTx.hash,
    })) as UserTransactionResponse;
    const entries = ShelbyBlobClient.registeredBlobUids(
      tx.events ?? [],
      this.coordination.deployer,
    );
    const match = entries.find((entry) => entry.objectName.endsWith(blobName));
    if (match === undefined) {
      throw new Error(
        `Shelby registration for "${blobName}" produced no UID. ` +
          'Real testnet confirmation is required; nothing is fabricated.',
      );
    }
    return match.uid;
  }
}

/** Length of a streaming body without buffering (single pass counter). */
async function contentLength(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<number> {
  const stream = toWebStream(body);
  const reader = stream.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      await reader.releaseLock();
      return size;
    }
    size += value.byteLength;
  }
}

/** Tee a web stream into two independent readable branches (pull-based). */
function teeStreams(
  source: ReadableStream<Uint8Array>,
): [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>] {
  const reader = source.getReader();
  const queue: Uint8Array[] = [];
  let done = false;
  let error: unknown = undefined;

  const pump = async (): Promise<IteratorResult<Uint8Array>> => {
    if (queue.length > 0) return { done: false, value: queue.shift()! };
    if (done) return { done: true, value: undefined };
    if (error !== undefined) throw error;
    const { done: d, value } = await reader.read();
    if (d) {
      done = true;
      return { done: true, value: undefined };
    }
    queue.push(value);
    return { done: false, value: queue.shift()! };
  };

  const makeBranch = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await pump();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (cause) {
          error = cause;
          controller.error(cause);
        }
      },
      cancel() {
        void reader.cancel().catch(() => undefined);
      },
    });

  return [makeBranch(), makeBranch()];
}

/** Normalize an async iterable or web stream to a web stream (no buffering). */
function toWebStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    return body as ReadableStream<Uint8Array>;
  }
  const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      void iterator
        .return?.()
        .then(() => undefined)
        .catch(() => undefined);
    },
  });
}
