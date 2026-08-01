import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');

function runBootstrap(env: Record<string, string>): string {
  return execFileSync('node', ['scripts/bootstrap.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('bootstrap data root permissions', () => {
  it('creates a new data root owner-only', () => {
    const base = mkdtempSync(join(tmpdir(), 'pv-boot-perms-'));
    const localDir = join(base, 'storage');
    runBootstrap({
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: localDir,
      DATABASE_URL: `file:${join(base, 'pv.db')}`,
    });
    const mode = statSync(localDir).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other bits
  });

  it('tightens a pre-existing permissive data root to owner-only', () => {
    const base = mkdtempSync(join(tmpdir(), 'pv-boot-root-'));
    const localDir = join(base, 'storage');
    mkdirSync(localDir, { recursive: true });
    chmodSync(localDir, 0o755);
    runBootstrap({
      STORAGE_DRIVER: 'local',
      LOCAL_STORAGE_DIR: localDir,
      DATABASE_URL: `file:${join(base, 'pv.db')}`,
    });
    const mode = statSync(localDir).mode & 0o777;
    expect(mode).toBe(0o700); // tightened, not left permissive
  });
});
