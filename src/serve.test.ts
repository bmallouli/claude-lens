import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
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

function transcript(id: string, cwd: string, cost: number, tokens: number, tools: number): string {
  return [
    JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:02:30Z', costUSD: cost,
      message: { usage: { input_tokens: tokens - 5, output_tokens: 5 },
        content: Array.from({ length: tools }, () => ({ type: 'tool_use' })) } }),
  ].join('\n') + '\n';
}

/** Sessions A ($2.10), B ($1.00), C ($0.40, two directories deep) and one malformed transcript. */
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-lens-serve-'));
  await mkdir(join(dir, 'one', 'two'), { recursive: true });
  await writeFile(join(dir, 'b.jsonl'), transcript('B', '/work/b', 1.00, 20, 2));
  await writeFile(join(dir, 'one', 'a.jsonl'), transcript('A', '/work/a', 2.10, 40, 3));
  await writeFile(join(dir, 'one', 'two', 'c.jsonl'), transcript('C', '<i>c</i>', 0.40, 10, 1));
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

/** The listing's rows, each as the six literal values its cells show. */
function rows(body: string): string[][] {
  const text = (cell: string) => cell.replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) =>
    ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[name]!);
  return [...body.matchAll(/<tr>((?:<td>.*?<\/td>)+)<\/tr>/g)]
    .map((row) => [...row[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => text(cell[1]!)));
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
      }
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
  const get = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port: defaultPort, headers: { Host: host }, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    }).on('error', reject).end();
  });
  try {
    await writeFile(join(dir, 'attack.jsonl'), JSON.stringify({
      type: 'user', sessionId: '<img src="https://example.invalid/pixel">',
      cwd: String.raw`/work/one\two & "three" 'four' <script>alert(1)</script>`,
    }) + '\n');
    const page = await get(`127.0.0.1:${defaultPort}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<td>&lt;img src=&quot;https://example.invalid/pixel&quot;&gt;</td>');
    expect(page.body).toContain(String.raw`<td>/work/one\two &amp; &quot;three&quot; &#39;four&#39; &lt;script&gt;alert(1)&lt;/script&gt;</td>`);
    expect(page.body).toContain('claude-lens-&amp;&lt;script&gt;-');
    expect(page.body).not.toContain('<img');
    expect(page.body).not.toContain('<script>');

    await rm(dir, { recursive: true, force: true });
    expect(await get(`foreign.example:${defaultPort}`)).toMatchObject({ status: 403 });
    expect((await get(`localhost:${defaultPort}`)).status).toBe(500);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
