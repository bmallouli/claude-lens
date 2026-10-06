import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultPort, serveSessions } from './serve.js';
import { sessionIds } from './test-support/session-ids.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const env = { ...process.env, NODE_USE_ENV_PROXY: '0' };

beforeAll(() => {
  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: root });
}, 60_000);

function transcript(id: string, cwd: string, cost: number, tokens: number, tools: number, records: object[] = []): string {
  return [
    { type: 'user', sessionId: id, cwd, timestamp: '2026-01-01T00:00:00Z' },
    ...records,
    { type: 'assistant', timestamp: '2026-01-01T00:02:30Z', costUSD: cost,
      message: { usage: { input_tokens: tokens - 5, output_tokens: 5 },
        content: Array.from({ length: tools }, () => ({ type: 'tool_use' })) } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/** A user or assistant record holding `content`, which costs nothing. */
function said(type: 'user' | 'assistant', second: number, content: unknown): object {
  return { type, timestamp: `2026-01-01T00:01:${second}Z`, message: { role: type, content } };
}

/**
 * Session B ($1.00): a question, a thinking-only reply, an answer, the same turn's separate Bash
 * call, its tool-result-only reply, a meta record, a sidechain reply and a final answer. The
 * question also carries a tool result and the final answer a thinking block, neither shown.
 */
function transcriptB(): string {
  const assistant = (second: number, content: unknown[], extra: object = {}) => ({ type: 'assistant', sessionId: 'B',
    timestamp: `2026-01-01T00:00:${second}Z`, costUSD: 0.25, message: { usage: { input_tokens: 4, output_tokens: 1 }, content },
    ...extra });
  return [
    { type: 'user', sessionId: 'B', cwd: '/work/b', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'earlier', content: 'b-mixed-result' }, { type: 'text', text: 'b-question' }] } },
    assistant(10, [{ type: 'thinking', thinking: 'b-thought' }]),
    assistant(20, [{ type: 'text', text: 'b-answer' }]),
    assistant(20, [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'grep haystack' } }]),
    { type: 'user', sessionId: 'B', timestamp: '2026-01-01T00:00:30Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'bash', content: 'b-result' }] } },
    { type: 'user', sessionId: 'B', isMeta: true, timestamp: '2026-01-01T00:00:40Z', message: { role: 'user', content: 'b-meta' } },
    assistant(50, [{ type: 'text', text: 'b-side' }], { isSidechain: true, costUSD: 0 }),
    assistant(59, [{ type: 'thinking', thinking: 'b-mixed-thought' }, { type: 'text', text: 'b-final <b>x</b>' }]),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/**
 * Sessions A ($2.10), B ($1.00), C ($0.40, two directories deep) and one malformed transcript. A
 * shows `Needle one`, then `needle two` (which repeats it), with a tool-result-only record
 * between them also holding `needle`; C shows one message holding it, as markup; B shows none.
 */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-lens-serve-'));
  await mkdir(join(dir, 'one', 'two'), { recursive: true });
  await writeFile(join(dir, 'b.jsonl'), transcriptB());
  await writeFile(join(dir, 'one', 'a.jsonl'), transcript('A', '/work/a', 2.10, 40, 3, [
    said('user', 10, 'Needle one'),
    said('user', 20, [{ type: 'tool_result', tool_use_id: 'earlier', content: 'a needle result' }]),
    said('assistant', 30, [{ type: 'text', text: 'needle two, needle again' }]),
  ]));
  await writeFile(join(dir, 'one', 'two', 'c.jsonl'), transcript('C', '<i>c</i>', 0.40, 10, 1, [
    said('assistant', 10, [{ type: 'text', text: 'c-intro' }]),
    said('assistant', 20, [{ type: 'text', text: 'c <b>NEEDLE</b>' }]),
  ]));
  await writeFile(join(dir, 'bad.jsonl'), 'not json\n');
  return dir;
}

/** Every file under `dir` with its exact bytes. */
async function snapshot(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path, await readFile(path));
    }
  }
  return files;
}

interface Launch { child: ChildProcess; stdout: string; stderr: () => string }

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Start `claude-lens serve` and wait for the line it prints once listening. */
function launch(...args: string[]): Promise<Launch> {
  const child = spawn(process.execPath, [cli, 'serve', ...args], { env });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.endsWith('\n')) resolve({ child, stdout, stderr: () => stderr });
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
}

function get(port: number, path = '/', options: { host?: string; method?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const headers = options.host === undefined ? {} : { Host: options.host };
    request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    }).on('error', reject).end();
  });
}

/** HTML text read back as the literal text it shows. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, '').replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) =>
    ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[name]!);
}

/** A page's table rows, each as the six literal values its cells show. */
function rows(body: string): string[][] {
  return [...body.matchAll(/<tr>((?:<td>.*?<\/td>)+)<\/tr>/g)]
    .map((row) => [...row[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => text(cell[1]!)));
}

/** The page each listing row links to, by the row's literal values. */
function links(body: string): { row: string[]; href: string }[] {
  return [...body.matchAll(/<tr><td><a href="([^"]*)">.*?<\/tr>/g)]
    .map((match) => ({ row: rows(match[0])[0]!, href: text(match[1]!) }));
}

/** A session page's messages, each as its timestamp and role line followed by its literal parts. */
function messages(body: string): string[][] {
  return [...body.matchAll(/<article>\n(.*?)\n<\/article>/gs)].map((article) =>
    [...article[1]!.matchAll(/<(h3|pre)>(.*?)<\/\1>/gs)].map((part) => text(part[2]!)));
}

/** A search page's results, each as its session ID, link, count line and first matching message. */
function results(body: string): { id: string; href: string; count: string; first: string[] }[] {
  return [...body.matchAll(/<section>\n<h2><a href="([^"]*)">(.*?)<\/a><\/h2>\n<p>(.*?)<\/p>\n(<article>.*?<\/article>)\n<\/section>/gs)]
    .map((match) => ({ id: text(match[2]!), href: text(match[1]!), count: text(match[3]!), first: messages(match[4]!)[0]! }));
}

/** The terminal `sessions` row for the session with ID `id`. */
function terminalRow(dir: string, id: string): string[] {
  const terminal = spawnSync(process.execPath, [cli, 'sessions', dir], { encoding: 'utf8', env });
  return terminal.stdout.trimEnd().split('\n').map((row) => row.split('\t')).find((row) => row[0] === id)!;
}

/** Every local address and port a process listens on for TCP, read from the kernel's socket tables. */
async function listeners(pid: number): Promise<string[]> {
  const inodes = new Set<string>();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    const socket = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''));
    if (socket) inodes.add(socket[1]!);
  }
  const found: string[] = [];
  for (const table of ['tcp', 'tcp6']) {
    for (const line of (await readFile(`/proc/${pid}/net/${table}`, 'utf8')).trim().split('\n').slice(1)) {
      const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
      if (state !== '0A' || !inodes.has(inode!)) continue;
      const [address, port] = local!.split(':');
      const ipv4 = table === 'tcp' ? address!.match(/../g)!.reverse().map((byte) => parseInt(byte, 16)).join('.') : `[${address}]`;
      found.push(`${table}:${ipv4}:${parseInt(port!, 16)}`);
    }
  }
  return found;
}

function connectError(address: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port, timeout: 5_000 });
    socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe.each([
  ['the default port', async () => ({ args: [] as string[], port: 4317 })],
  ['an explicit port', async () => { const port = await freePort(); return { args: ['--port', String(port)], port }; }],
])('claude-lens serve on %s', (_, choose) => {
  it('prints a 127.0.0.1 URL, listens only on 127.0.0.1 and refuses other interfaces', async () => {
    const dir = await fixture();
    try {
      const { args, port } = await choose();
      const { child, stdout } = await launch(dir, ...args);

      expect(stdout).toBe(`Serving sessions under ${dir} at http://127.0.0.1:${port}/\n`);
      expect(await listeners(child.pid!)).toEqual([`tcp:127.0.0.1:${port}`]);
      expect((await get(port)).status).toBe(200);

      const others = Object.values(networkInterfaces()).flat()
        .filter((info) => info !== undefined && !info.internal)
        .map((info) => info!.address);
      expect(others.length).toBeGreaterThan(0);
      for (const address of [...others, '::1']) {
        expect(await connectError(address, port)).toBe('ECONNREFUSED');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('claude-lens serve', () => {
  it('lists every session by cost with the sessions command values, rereading on each request', async () => {
    const dir = await fixture();
    try {
      const port = await freePort();
      const server = await launch(dir, '--port', String(port));
      const before = await snapshot(dir);

      const page = await get(port);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      const terminal = spawnSync(process.execPath, [cli, 'sessions', dir], { encoding: 'utf8', env });
      expect(rows(page.body)).toEqual(terminal.stdout.trimEnd().split('\n').map((row) => row.split('\t')));
      expect(rows(page.body).map((row) => row[0])).toEqual(['A', 'B', 'C']);
      expect(server.stderr()).toContain(`${join(dir, 'bad.jsonl')}: 1 unreadable JSONL record(s)\n`);

      const limited = spawnSync(process.execPath, [cli, 'sessions', dir, '--limit', '1'], { encoding: 'utf8', env });
      expect(sessionIds(limited.stdout)).toEqual(['A']);
      expect(rows((await get(port)).body).map((row) => row[0])).toEqual(['A', 'B', 'C']);
      expect(await snapshot(dir)).toEqual(before);

      await writeFile(join(dir, 'one', 'd.jsonl'), transcript('D', '/work/d', 1.50, 30, 0));
      const after = await snapshot(dir);
      expect(rows((await get(port)).body).map((row) => row[0])).toEqual(['A', 'D', 'B', 'C']);
      expect(await snapshot(dir)).toEqual(after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('links every listed session to its own page, even when IDs repeat or are missing', async () => {
    const dir = await fixture();
    try {
      await mkdir(join(dir, 'copy'));
      await writeFile(join(dir, 'copy', 'b.jsonl'), transcript('B', '/work/b-copy', 0.70, 12, 0));
      await writeFile(join(dir, 'none.jsonl'), JSON.stringify({ type: 'user', cwd: '/work/none' }) + '\n');
      const port = await freePort();
      await launch(dir, '--port', String(port));

      const listed = links((await get(port)).body);
      expect(listed.map(({ row }) => row[0])).toEqual(['A', 'B', 'B', 'C', '-']);
      expect(new Set(listed.map(({ href }) => href)).size).toBe(5);
      for (const { row, href } of listed) {
        expect(href).toMatch(/^\/sessions\/[^/]+$/);
        const session = await get(port, href);
        expect(session.status).toBe(200);
        expect(rows(session.body)).toEqual([row]);
        expect(session.body).toContain(`<h1>Session ${row[0]}</h1>`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows a session's summary, then its displayed messages, rereading on each request", async () => {
    const dir = await fixture();
    try {
      const port = await freePort();
      await launch(dir, '--port', String(port));
      const before = await snapshot(dir);
      const { href } = links((await get(port)).body).find(({ row }) => row[0] === 'B')!;

      const session = await get(port, href);
      expect(session.status).toBe(200);
      expect(session.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(rows(session.body)).toEqual([terminalRow(dir, 'B')]);
      expect(session.body.indexOf('</table>')).toBeLessThan(session.body.indexOf('<article>'));
      expect(messages(session.body)).toEqual([
        ['2026-01-01T00:00:00Z user', 'b-question'],
        ['2026-01-01T00:00:20Z assistant', 'b-answer'],
        ['2026-01-01T00:00:20Z assistant', 'Bash {"command":"grep haystack"}'],
        ['2026-01-01T00:00:59Z assistant', 'b-final <b>x</b>'],
      ]);
      for (const excluded of ['b-thought', 'b-result', 'b-meta', 'b-side', 'b-mixed-result', 'b-mixed-thought']) {
        expect(session.body).not.toContain(excluded);
      }
      expect(session.body).toContain('<pre>b-final &lt;b&gt;x&lt;/b&gt;</pre>');
      expect(session.body).not.toContain('<b>');
      expect(session.body).not.toMatch(/(?:src|href)\s*=\s*["']?\s*https?:/i);
      expect(session.headers['content-security-policy']).toMatch(/^default-src 'none'(;|$)/);
      expect(await snapshot(dir)).toEqual(before);

      await appendFile(join(dir, 'b.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'B',
        timestamp: '2026-01-01T00:01:30Z', costUSD: 0.20, message: { usage: { input_tokens: 7 }, content: [{ type: 'text', text: 'b-late' }] } }) + '\n');
      const after = await snapshot(dir);
      const updated = await get(port, href);
      expect(messages(updated.body)).toEqual([...messages(session.body), ['2026-01-01T00:01:30Z assistant', 'b-late']]);
      expect(rows(updated.body)).toEqual([terminalRow(dir, 'B')]);
      expect(rows(updated.body)).not.toEqual(rows(session.body));
      expect(await snapshot(dir)).toEqual(after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shows transcript text literally and loads nothing from another origin', async () => {
    const dir = await fixture();
    try {
      const port = await freePort();
      await launch(dir, '--port', String(port));

      const { body, headers } = await get(port);
      expect(body).toContain('<td>&lt;i&gt;c&lt;/i&gt;</td>');
      expect(body).not.toContain('<i>');
      expect(body).not.toMatch(/(?:src|href)\s*=\s*["']?\s*https?:/i);
      expect(headers['content-security-policy']).toMatch(/^default-src 'none'(;|$)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('searches every displayed message, counting matching messages per session, rereading on each request', async () => {
    const dir = await fixture();
    try {
      const port = await freePort();
      await launch(dir, '--port', String(port));
      const before = await snapshot(dir);
      const href = async (id: string) => links((await get(port)).body).find(({ row }) => row[0] === id)!.href;
      const search = async (q: string) => results((await get(port, `/search?q=${q}`)).body);

      const found = await get(port, '/search?q=needle');
      expect(found.status).toBe(200);
      expect(found.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(results(found.body)).toEqual([
        { id: 'A', href: await href('A'), count: '2 matching messages', first: ['2026-01-01T00:01:10Z user', 'Needle one'] },
        { id: 'C', href: await href('C'), count: '1 matching message', first: ['2026-01-01T00:01:20Z assistant', 'c <b>NEEDLE</b>'] },
      ]);
      expect(found.body).not.toContain('needle two');
      expect(found.body).toContain('<pre>c &lt;b&gt;NEEDLE&lt;/b&gt;</pre>');
      expect(found.body).not.toContain('<b>');
      for (const { id, href } of results(found.body)) {
        const session = await get(port, href);
        expect(session.status).toBe(200);
        expect(session.body).toContain(`<h1>Session ${id}</h1>`);
      }

      expect(await search('haystack')).toEqual([{ id: 'B', href: await href('B'), count: '1 matching message',
        first: ['2026-01-01T00:00:20Z assistant', 'Bash {"command":"grep haystack"}'] }]);
      expect(await search('needle+one')).toEqual([{ id: 'A', href: await href('A'), count: '1 matching message',
        first: ['2026-01-01T00:01:10Z user', 'Needle one'] }]);
      for (const excluded of ['needle%20result', 'b-thought', 'b-result', 'b-meta', 'b-side', 'b-mixed-result', 'b-mixed-thought', 'absent']) {
        const none = await get(port, `/search?q=${excluded}`);
        expect(none.status).toBe(200);
        expect(results(none.body)).toEqual([]);
        expect(text(none.body)).toContain(`no session matches "${decodeURIComponent(excluded)}"`);
      }
      expect(await snapshot(dir)).toEqual(before);

      await appendFile(join(dir, 'b.jsonl'), JSON.stringify(said('assistant', 40, [{ type: 'text', text: 'b-late Needle' }])) + '\n');
      await writeFile(join(dir, 'one', 'd.jsonl'), transcript('D', '/work/d', 1.50, 30, 0, [said('user', 5, 'd-needle')]));
      const after = await snapshot(dir);
      expect((await search('needle')).map(({ id, count }) => [id, count])).toEqual([
        ['A', '2 matching messages'], ['D', '1 matching message'], ['B', '1 matching message'], ['C', '1 matching message']]);
      expect(await snapshot(dir)).toEqual(after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('submits searches from a same-origin form, shows the phrase literally and redirects an empty one', async () => {
    const dir = await fixture();
    try {
      const port = await freePort();
      await launch(dir, '--port', String(port));

      expect((await get(port)).body).toContain('<form method="get" action="/search"><input type="text" name="q" value="">');
      for (const path of ['/', '/sessions/b.jsonl', '/search?q=needle', '/search?q=absent', '/search?q=']) {
        const { headers, body } = await get(port, path);
        expect(headers['content-security-policy']).toMatch(/^default-src 'none';(?:.*; )?form-action 'self'(?:;|$)/);
        expect(body).not.toMatch(/(?:src|href|action)\s*=\s*["']?\s*https?:/i);
      }

      const script = await get(port, '/search?q=%3Cscript%3E');
      expect(script.status).toBe(200);
      expect(script.body).toContain('<p>no session matches "&lt;script&gt;"</p>');
      expect(script.body).not.toContain('<script');

      for (const empty of ['/search?q=', '/search']) {
        expect(await get(port, empty)).toMatchObject({ status: 302, headers: { location: '/' } });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers 404 for unknown routes, 405 for other methods and 403 for a foreign Host', async () => {
    const dir = await fixture();
    try {
      const port = await freePort();
      await launch(dir, '--port', String(port));

      expect((await get(port, '/no-such-page')).status).toBe(404);
      expect((await get(port, '/', { method: 'POST' })).status).toBe(405);
      expect(await get(port, '/', { method: 'HEAD' })).toMatchObject({ status: 200, body: '' });
      expect((await get(port, '/', { host: `localhost:${port}` })).status).toBe(200);
      for (const host of [`rebound.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
        const refused = await get(port, '/', { host });
        expect(refused.status).toBe(403);
        expect(refused.body).not.toContain('/work/a');
        expect(await get(port, '/sessions/b.jsonl', { host })).toMatchObject({ status: 403, body: expect.not.stringContaining('b-question') });
      }

      expect((await get(port, '/sessions/b.jsonl')).status).toBe(200);
      for (const unknown of ['/sessions/not-a-session', '/sessions/', '/sessions/bad.jsonl', '/sessions/%E0%A4%A']) {
        expect((await get(port, unknown)).status).toBe(404);
      }
      expect((await get(port, '/sessions/b.jsonl', { method: 'POST' })).status).toBe(405);
      expect(await get(port, '/sessions/b.jsonl', { method: 'HEAD' })).toMatchObject({ status: 200, body: '' });

      expect((await get(port, '/search/?q=needle')).status).toBe(404);
      expect((await get(port, '/search?q=needle', { method: 'POST' })).status).toBe(405);
      expect(await get(port, '/search?q=needle', { method: 'HEAD' })).toMatchObject({ status: 200, body: '' });
      expect(await get(port, '/search?q=needle', { host: 'rebound.example' })).toMatchObject({ status: 403, body: expect.not.stringContaining('Needle') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers 500 and reports it when the directory disappears after startup', async () => {
    const dir = await fixture();
    const port = await freePort();
    const server = await launch(dir, '--port', String(port));
    await rm(dir, { recursive: true, force: true });

    expect((await get(port)).status).toBe(500);
    expect(server.stderr()).toContain(`${dir}: ENOENT`);
  });
});

it('escapes hostile session and directory text and denies a foreign Host before discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-lens-&<script>-'));
  const server = await serveSessions(dir, defaultPort, { write() {} });
  const get = (host: string, path = '/') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port: defaultPort, path, headers: { Host: host }, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    }).on('error', reject).end();
  });
  try {
    await writeFile(join(dir, `attack #?%'"<i>.jsonl`), JSON.stringify({
      type: 'user', sessionId: '<img src="https://example.invalid/pixel">',
      cwd: String.raw`/work/one\two & "three" 'four' <script>alert(1)</script>`,
    }) + '\n');
    const page = await get(`127.0.0.1:${defaultPort}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('">&lt;img src=&quot;https://example.invalid/pixel&quot;&gt;</a></td>');
    expect(page.body).toContain(String.raw`<td>/work/one\two &amp; &quot;three&quot; &#39;four&#39; &lt;script&gt;alert(1)&lt;/script&gt;</td>`);
    expect(page.body).toContain('claude-lens-&amp;&lt;script&gt;-');
    expect(page.body).not.toContain('<img');
    expect(page.body).not.toContain('<script>');

    const [{ row, href }] = links(page.body) as [{ row: string[]; href: string }];
    expect(href).toBe(`/sessions/attack%20%23%3F%25'%22%3Ci%3E.jsonl`);
    const session = await get(`127.0.0.1:${defaultPort}`, href);
    expect(session.status).toBe(200);
    expect(rows(session.body)).toEqual([row]);
    expect(session.body).not.toContain('<img');
    expect(session.body).not.toContain('<script>');

    await rm(dir, { recursive: true, force: true });
    expect(await get(`foreign.example:${defaultPort}`)).toMatchObject({ status: 403 });
    expect((await get(`localhost:${defaultPort}`)).status).toBe(500);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
