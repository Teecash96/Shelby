import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const NONCE_PLACEHOLDER = '__PROOFVAULT_CSP_NONCE__';

/** Load the dashboard shell from the source tree or the copied build asset. */
export async function loadDashboardHtml(): Promise<string> {
  const path = fileURLToPath(new URL('../../web/index.html', import.meta.url));
  return readFile(path, 'utf8');
}

/** Render the shell with a request-scoped CSP nonce for its inline assets. */
export function dashboardResponse(html: string): { body: string; csp: string } {
  const nonce = randomUUID().replace(/-/g, '');
  return {
    body: html.replaceAll(NONCE_PLACEHOLDER, nonce),
    csp: [
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  };
}
