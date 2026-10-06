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
 * — so the page can never fetch content from another origin, and lets forms
 * submit only to this server.
 */
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

/** A link, labelled with already-safe `label`, to the page of the transcript at `path`. */
function sessionLink(directory: string, path: string, label: string): string {
  const href = `/sessions/${encodeURIComponent(transcriptName(directory, path))}`;
  return `<a href="${html(href)}">${label}</a>`;
}

/** The form that searches every session's displayed messages, holding `phrase`. */
function searchForm(phrase = ''): string {
  return `<form method="get" action="/search"><input type="text" name="q" value="${html(phrase)}"> <button type="submit">Search messages</button></form>`;
}

function page(directory: string, sessions: ListedSession[]): string {
  const rows = sessions.map(({ path, summary }) => {
    const [id, ...values] = sessionColumns(summary, html);
    return [sessionLink(directory, path, id!), ...values];
  });
  return document('claude-lens sessions', [
    `<h1>Sessions under ${html(directory)}</h1>`,
    searchForm(),
    rows.length === 0 ? '<p>No sessions found.</p>' : table(rows),
  ]);
}

function article({ timestamp, role, parts }: DisplayedMessage): string {
  return [
    '<article>',
    `<h3><time>${html(timestamp ?? '-')}</time> ${role}</h3>`,
    ...parts.map((part) => `<pre>${html(part)}</pre>`),
    '</article>',
  ].join('\n');
}

function sessionPage(summary: SessionSummary, messages: DisplayedMessage[]): string {
  const columns = sessionColumns(summary, html);
  return document(`claude-lens session ${columns[0]}`, [
    '<p><a href="/">All sessions</a></p>',
    `<h1>Session ${columns[0]}</h1>`,
    table([columns]),
    '<h2>Messages</h2>',
    messages.length === 0 ? '<p>No messages to display.</p>' : messages.map(article).join('\n'),
  ]);
}

/**
 * Every session under `directory` with a displayed message containing
 * `phrase`, ignoring case, most matching messages first, each with how many
 * of its messages match and the first of them. Only what a session page shows
 * is searched: a message matches when one of its parts contains the phrase.
 */
async function searchPage(directory: string, phrase: string, stderr: Writer): Promise<string> {
  const { sessions } = await readSessions(directory, stderr, () => true);
  const wanted = phrase.toLowerCase();
  const results = sessions.flatMap(({ path, lines, summary }) => {
    const matching = displayedMessages(lines!).filter(({ parts }) => parts.some((part) => part.toLowerCase().includes(wanted)));
    return matching.length === 0 ? [] : [{ path, summary, matching }];
  }).sort((a, b) => b.matching.length - a.matching.length);
  return document(`claude-lens search "${html(phrase)}"`, [
    '<p><a href="/">All sessions</a></p>',
    `<h1>Sessions matching "${html(phrase)}"</h1>`,
    searchForm(phrase),
    results.length === 0 ? `<p>no session matches "${html(phrase)}"</p>` : results.map(({ path, summary, matching }) => [
      '<section>',
      `<h2>${sessionLink(directory, path, sessionColumns(summary, html)[0]!)}</h2>`,
      `<p>${matching.length} matching message${matching.length === 1 ? '' : 's'}</p>`,
      article(matching[0]!),
      '</section>',
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
  const named = (path: string) => transcriptName(directory, path) === name;
  const { sessions } = await readSessions(directory, stderr, named);
  const listed = sessions.find(({ path }) => named(path));
  if (listed === undefined) {
    return undefined;
  }
  return sessionPage(listed.summary, displayedMessages(listed.lines!));
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
 * summary and displayed messages, which `/search?q=` searches across sessions.
 * Each request rereads the transcripts and reports
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
    const url = request.url ?? '';
    const path = url.split('?')[0]!;
    const name = path.startsWith('/sessions/') ? decoded(path.slice('/sessions/'.length)) : undefined;
    const search = path === '/search';
    if (path !== '/' && !search && name === undefined) {
      reply(response, 404, 'Not found.\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(response, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    // The search form submits `q` as form data, so `+` reads as a space.
    const phrase = new URLSearchParams(url.slice(path.length)).get('q') ?? '';
    if (search && phrase === '') {
      reply(response, 302, 'Found.\n', { Location: '/' });
      return;
    }
    const answer = search
      ? searchPage(directory, phrase, stderr)
      : name === undefined
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
