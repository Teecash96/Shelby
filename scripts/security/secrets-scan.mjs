#!/usr/bin/env node
/**
 * Secrets scanner (SECURITY.md secret handling). Scans the repository for
 * high-signal secret patterns and aborts with a non-zero exit code when
 * anything matches. Intentionally conservative: patterns that produce false
 * positives in tests or docs are skipped, and the scan is defense-in-depth,
 * not a guarantee.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const IGNORE = [
  'node_modules',
  'dist',
  'coverage',
  'evidence',
  '.proofvault',
  '.git',
  '.commandcode',
  'pnpm-lock.yaml',
];

const PATTERNS = [
  // PEM private keys (multi-line)
  { name: 'private key (PEM)', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  // Common AWS/Google/OpenAI-style secret keys
  { name: 'AWS secret key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS secret access key', re: /\b(?:aws)?secret\s*access\s*key\b.{0,40}[A-Za-z0-9/+=]{40}/i },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  // GitHub tokens
  { name: 'GitHub token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  // Private key hex blobs (Aptos/Shelby style, 64 hex chars after a known label)
  { name: 'private key hex', re: /\b(?:private[_-]?key|private_key)\b.{0,60}\b[0-9a-f]{64}\b/i },
  // JWT-like bearer secrets in committed config (not in test fixtures)
  { name: 'bearer token assignment', re: /(?:bearer|authorization)\s*[:=]\s*["']?(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|\S{30,})/i },
  // Generic high-entropy assignment to a secret-ish key in non-test files
  { name: 'high-entropy secret', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{32,}["']?/i },
];

async function main() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

  const matches = [];
  for (const file of files) {
    if (IGNORE.some((part) => file.startsWith(part))) continue;
    let content;
    try {
      content = await readFile(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    // Skip the scanner's own patterns and test fixtures that intentionally
    // exercise secrets.
    if (file.includes('.env.example')) continue;
    for (const { name, re } of PATTERNS) {
      const match = content.match(re);
      if (match) {
        matches.push({ file: relative(ROOT, file), name, sample: mask(match[0]) });
      }
    }
  }

  if (matches.length > 0) {
    console.error('SECRET SCAN FAILED — potential secrets found:');
    for (const { file, name, sample } of matches) {
      console.error(`  - ${file}: ${name} (${sample})`);
    }
    process.exit(1);
  }
  console.log('Secret scan clean: no high-signal secret patterns found.');
}

function mask(value) {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

main().catch((error) => {
  console.error('Secret scan error:', error.message);
  process.exit(2);
});
