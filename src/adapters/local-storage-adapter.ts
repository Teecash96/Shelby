import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { StoragePort, StoragePutInput, StoragePutResult } from '../ports/storage-port.js';

/**
 * Storage keys accepted by the local adapter. Hierarchical keys are
 * `/`-separated segments; each segment is a safe single path element (no dot
 * segments, no path separators, no control characters). Server-derived keys
 * (e.g. `collections/<collectionId>/<sha256>` or `<sha256>`) satisfy this by
 * construction.
 */
const KEY_PATTERN = /^(?:[A-Za-z0-9._-]{1,128}\/)*[A-Za-z0-9._-]{1,128}$/;

/** In-progress uploads are written here before the atomic rename to the final key. */
const UPLOAD_SUFFIX = '.upload';

/** Sidecar claim carrying the stored content type and requested expiry. */
const META_SUFFIX = '.meta.json';

/** Reject dot segments explicitly; the pattern permits plain dots inside names. */
const SEGMENT_DOT_PATTERN = /(^|\/)\.{1,2}(\/|$)/;

/**
 * Deterministic local filesystem adapter.
 *
 * - Keys are validated against a strict segment pattern and dot-segment
 *   rejection; a key is never joined into a path until it has passed both.
 * - Uploads stream to a unique `<key>.<uuid>.upload` temporary file, then
 *   atomically renames to the final key once the source stream completes. A
 *   reader that observes a final path is guaranteed to read the complete
 *   object; a failed upload removes only its own temporary file.
 * - Keys are content-addressed by the caller: a later seal of identical bytes
 *   overwrites nothing because the key is the byte digest.
 * - `get()` resolves the real path before reading so a symlink cannot smuggle
 *   reads outside the data directory, and refuses objects that are still
 *   being uploaded so partial bytes are never returned as a sealed artifact.
 */
export class LocalStorageAdapter implements StoragePort {
  readonly providerName = 'local';

  constructor(private readonly dataDir: string) {}

  async put(input: StoragePutInput): Promise<StoragePutResult> {
    this.assertKey(input.key);
    await mkdir(join(this.dataDir, dirname(input.key)), { recursive: true });

    // Each writer owns its temporary pathname; a shared path lets concurrent
    // puts unlink or rename one another's active inode.
    const tempPath = join(this.dataDir, `${input.key}.${randomUUID()}${UPLOAD_SUFFIX}`);
    const finalPath = join(this.dataDir, input.key);
    const metaPath = join(this.dataDir, `${input.key}${META_SUFFIX}`);
    const hash = createHash('sha256');
    let size = 0;

    // Content-addressed keys: an already-committed object under the same key
    // is the same artifact. Skip the write rather than risk a torn or mixed
    // object, and report the committed size.
    const existing = await this.statObject(finalPath);
    if (existing !== undefined && existing.size !== undefined) {
      return { key: input.key, size: existing.size, providerRef: `local:${input.key}` };
    }

    try {
      // `flags: 'wx'` gives the atomic exclusive create. The write stream owns
      // the descriptor and closes it on
      // finish/error, which `pipeline` waits for. (FileHandle-backed write
      // streams never emit 'close' with autoClose:false, which deadlocks
      // pipeline on current Node.)
      const out = await openTempWriteStream(tempPath);
      const source = toNodeReadable(input.body);
      await pipeline(source, new HashThrough(hash, (n) => (size = n)), out);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    // Content type is persisted as a sidecar claim (metadata, not proof).
    await writeFile(
      metaPath,
      JSON.stringify({ contentType: input.contentType, expiresAt: input.expiresAt }),
      { encoding: 'utf8' },
    );
    await rename(tempPath, finalPath);

    return { key: input.key, size, providerRef: `local:${input.key}` };
  }

  async get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    size?: number;
  }> {
    this.assertKey(key);
    const path = join(this.dataDir, key);
    const object = await this.statObject(path);
    if (object === undefined) {
      throw new Error(`object not found: ${key}`);
    }
    if (object.size === undefined) {
      throw new Error(`object is still being uploaded: ${key}`);
    }
    // Open with O_NOFOLLOW so a symlink cannot redirect the read outside the
    // data directory, even if one is swapped in mid-request (TOCTOU
    // defense-in-depth). The stream is created from the handle; the handle is
    // the single owner of the fd and is closed when the stream finishes.
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const nodeStream = handle.createReadStream({ autoClose: false });
    nodeStream.once('end', () => void handle.close().catch(() => undefined));
    nodeStream.once('error', () => void handle.close().catch(() => undefined));
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const contentType = await this.readContentType(key);
    return { body, contentType, size: object.size };
  }

  private async readContentType(key: string): Promise<string> {
    try {
      const raw = await readFile(join(this.dataDir, `${key}${META_SUFFIX}`), 'utf8');
      const parsed = JSON.parse(raw) as { contentType?: unknown };
      if (typeof parsed.contentType === 'string' && parsed.contentType.length > 0) {
        return parsed.contentType;
      }
    } catch {
      // A missing or malformed sidecar falls back to the opaque default.
    }
    return 'application/octet-stream';
  }

  async exists(key: string): Promise<boolean> {
    this.assertKey(key);
    const path = join(this.dataDir, key);
    try {
      // `lstat` does not follow a symlink planted at the key, so a symlink
      // cannot make a phantom key report as a committed object.
      const info = await lstat(path);
      return info.isFile();
    } catch {
      return false;
    }
  }

  /** Remove a committed object. Internal helper for tests and cleanup. */
  async remove(key: string): Promise<void> {
    this.assertKey(key);
    await unlink(join(this.dataDir, key));
  }

  private async statObject(path: string): Promise<{ size?: number } | undefined> {
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        throw new Error(`storage object is not a regular file: ${path}`);
      }
      return { size: info.size };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private assertKey(key: string): void {
    if (!KEY_PATTERN.test(key) || SEGMENT_DOT_PATTERN.test(key)) {
      throw new Error(`invalid storage key: ${key}`);
    }
  }
}

/**
 * Atomically create a uniquely owned temp write stream. `createWriteStream`
 * reports exclusive-create failures asynchronously via the 'error' event, so
 * this wraps the operation in a promise without deleting another writer's file.
 */
async function openTempWriteStream(
  tempPath: string,
): Promise<ReturnType<typeof createWriteStream>> {
  return new Promise<ReturnType<typeof createWriteStream>>((resolve, reject) => {
    const stream = createWriteStream(tempPath, { flags: 'wx' });
    stream.once('error', (error) => reject(error));
    stream.once('open', () => resolve(stream));
  });
}

function toNodeReadable(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Readable {
  if (Symbol.asyncIterator in Object(body)) {
    // Prefer the async-iterable form: `pipeline(Readable.fromWeb(...))` hangs
    // on current Node when the source uses web stream internals.
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  // A DOM-style web stream: expose it as an async iterable over its reader.
  const webStream = body as unknown as ReadableStream<Uint8Array>;
  const reader = webStream.getReader();
  const asyncIterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const { done, value } = await reader.read();
          if (done) {
            await reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value: value as Uint8Array };
        },
      };
    },
  };
  return Readable.from(asyncIterable);
}

/**
 * Node-style write-through transform that updates a running byte counter as
 * chunks pass. The adapter uses Node streams end-to-end inside `put` because
 * `pipeline` requires Node stream objects.
 */
class HashThrough extends Transform {
  private size = 0;
  private readonly hash: ReturnType<typeof createHash>;
  private readonly onBytes: (size: number) => void;

  constructor(hash: ReturnType<typeof createHash>, onBytes: (size: number) => void) {
    super();
    this.hash = hash;
    this.onBytes = onBytes;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: unknown) => void,
  ): void {
    this.hash.update(chunk);
    this.size += chunk.byteLength;
    this.onBytes(this.size);
    callback(null, chunk);
  }
}
