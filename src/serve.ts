import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { relative, sep } from 'node:path';

import { displayedMessages } from './session/messages.js';
import type { DisplayedMessage } from './session/messages.js';
import type { SessionSummary } from './session/summarise.js';
import { readSessions, reason, sessionColumns } from './sessions.js';
import type { ListedSession, Writer } from './sessions.js';

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

function document(title: string, body: string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${title}</title></head>`,
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function table(rows: string[][]): string {
  const cells = (tag: string, values: string[]) => values.map((value) => `<${tag}>${value}</${tag}>`).join('');
  return [
    '<table>',
    `<thead><tr>${cells('th', headings)}</tr></thead>`,
    '<tbody>',
    ...rows.map((row) => `<tr>${cells('td', row)}</tr>`),
    '</tbody>',
    '</table>',
  ].join('\n');
}

/**
 * What names a listed transcript in its page's URL: its path under
 * `directory`, which no other listed transcript shares, whatever session ID
 * either carries.
 */
function transcriptName(directory: string, path: string): string {
  return relative(directory, path).split(sep).join('/');
}

/** A percent-encoded path segment decoded, or undefined when it is malformed. */
function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function page(directory: string, sessions: ListedSession[]): string {
  const rows = sessions.map(({ path, summary }) => {
    const [id, ...values] = sessionColumns(summary, html);
    const href = `/sessions/${encodeURIComponent(transcriptName(directory, path))}`;
    return [`<a href="${html(href)}">${id}</a>`, ...values];
  });
  return document('claude-lens sessions', [
    `<h1>Sessions under ${html(directory)}</h1>`,
    rows.length === 0 ? '<p>No sessions found.</p>' : table(rows),
  ]);
}

function sessionPage(summary: SessionSummary, messages: DisplayedMessage[]): string {
  const columns = sessionColumns(summary, html);
  return document(`claude-lens session ${columns[0]}`, [
    '<p><a href="/">All sessions</a></p>',
    `<h1>Session ${columns[0]}</h1>`,
    table([columns]),
    '<h2>Messages</h2>',
    messages.length === 0 ? '<p>No messages to display.</p>' : messages.map(({ timestamp, role, parts }) => [
      '<article>',
      `<h3><time>${html(timestamp ?? '-')}</time> ${role}</h3>`,
      ...parts.map((part) => `<pre>${html(part)}</pre>`),
      '</article>',
    ].join('\n')).join('\n'),
  ]);
}

/**
 * The page for the listed transcript `name` names under `directory`, or
 * undefined when no listed transcript has that name. The summary comes from
 * the same discovery as the listing, and the messages from the very lines that
 * summary counted, so what the page omits from its messages never changes it.
 */
async function sessionPageFor(directory: string, name: string, stderr: Writer): Promise<string | undefined> {
  const { sessions } = await readSessions(directory, stderr);
  const listed = sessions.find(({ path }) => transcriptName(directory, path) === name);
  if (listed === undefined) {
    return undefined;
  }
  return sessionPage(listed.summary, displayedMessages(listed.lines));
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
 * 127.0.0.1:`port` only, each linking to a page under `/sessions/` showing its
 * summary and displayed messages. Each request rereads the transcripts and reports
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
    const path = request.url?.split('?')[0] ?? '';
    const name = path.startsWith('/sessions/') ? decoded(path.slice('/sessions/'.length)) : undefined;
    if (path !== '/' && name === undefined) {
      reply(response, 404, 'Not found.\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(response, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    const answer = name === undefined
      ? readSessions(directory, stderr).then(({ sessions }) => page(directory, sessions))
      : sessionPageFor(directory, name, stderr);
    answer.then(
      (body) => {
        if (body === undefined) {
          reply(response, 404, 'Not found.\n');
          return;
        }
        reply(response, 200, body, { 'Content-Type': 'text/html; charset=utf-8' });
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
