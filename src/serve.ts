import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';

import { readSessions, reason, sessionColumns } from './sessions.js';
import type { Writer } from './sessions.js';

/** The only address the sessions page listens on. */
export const host = '127.0.0.1';
export const defaultPort = 4317;

const headings = ['Session ID', 'Working directory', 'Cost', 'Tokens', 'Tool calls', 'Elapsed'];

/**
 * Every response forbids loading anything — scripts, styles, images, frames
 * — so the page can never fetch content from another origin.
 */
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Transcript text made literal inside HTML: no markup it holds is interpreted. */
function html(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function reply(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders, ...headers });
  response.end(body);
}

function page(directory: string, rows: string[][]): string {
  const cells = (tag: string, values: string[]) => values.map((value) => `<${tag}>${value}</${tag}>`).join('');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>claude-lens sessions</title></head>',
    '<body>',
    `<h1>Sessions under ${html(directory)}</h1>`,
    rows.length === 0 ? '<p>No sessions found.</p>' : [
      '<table>',
      `<thead><tr>${cells('th', headings)}</tr></thead>`,
      '<tbody>',
      ...rows.map((row) => `<tr>${cells('td', row)}</tr>`),
      '</tbody>',
      '</table>',
    ].join('\n'),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Fail unless `directory` names a directory that can be read, with a
 * diagnostic naming what is wrong with it.
 */
async function checkDirectory(directory: string): Promise<void> {
  try {
    await readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const problem = code === 'ENOENT' ? 'no such directory' : code === 'ENOTDIR' ? 'not a directory' : reason(error);
    throw new Error(`${directory}: ${problem}`);
  }
}

/**
 * Serve every session under `directory`, highest cost first, at `/` on
 * 127.0.0.1:`port` only. Each request rereads the transcripts and reports
 * omitted ones on `stderr`; nothing is ever written under `directory`.
 * Resolves once listening, or rejects when `directory` cannot be read or the
 * port cannot be bound.
 */
export async function serveSessions(directory: string, port: number, stderr: Writer = process.stderr): Promise<Server> {
  await checkDirectory(directory);

  const server = createServer((request, response) => {
    // A page on another site can point its own host name at 127.0.0.1 (DNS
    // rebinding); its requests then carry that name, so only requests naming
    // this listener as a loopback host at its port (80 when the Host header
    // omits one) see the listing.
    const named = /^(?:127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(request.headers.host ?? '');
    if (named === null || Number(named[1] ?? 80) !== port) {
      reply(response, 403, 'Forbidden: requests must name this server as 127.0.0.1 or localhost.\n');
      return;
    }
    if (request.url?.split('?')[0] !== '/') {
      reply(response, 404, 'Not found.\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(response, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    readSessions(directory, stderr).then(
      (sessions) => {
        const rows = sessions.map(({ summary }) => sessionColumns(summary, html));
        reply(response, 200, page(directory, rows), { 'Content-Type': 'text/html; charset=utf-8' });
      },
      (error: unknown) => {
        stderr.write(`${directory}: ${reason(error)}\n`);
        reply(response, 500, `Cannot read ${directory}: ${reason(error)}\n`);
      },
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
