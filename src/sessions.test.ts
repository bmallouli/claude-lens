import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatDuration } from './session/format-duration.js';
import { summariseSession } from './session/summarise.js';
import { listSessions, readSessions } from './sessions.js';
import { sessionIds } from './test-support/session-ids.js';

function capture() {
  let text = '';
  return { write(chunk: string) { text += chunk; }, get text() { return text; } };
}

function transcript(id: string, cost: number, tokens: number, tools: number): string[] {
  return [
    JSON.stringify({ type: 'user', sessionId: id, cwd: `/workspace/${id}`, timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:01:05Z', costUSD: cost,
      message: { usage: { input_tokens: tokens - 2, output_tokens: 2 },
        content: Array.from({ length: tools }, () => ({ type: 'tool_use' })) } }),
  ];
}

describe('sessions listing', () => {
  it('lists recursive JSONL transcripts by cost, and reports a bad file only once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      await mkdir(join(dir, 'one', 'two'), { recursive: true });
      const fixtures = [
        { path: join(dir, 'cheap.jsonl'), lines: transcript('cheap', 0.40, 12, 1) },
        { path: join(dir, 'one', 'two', 'expensive.jsonl'), lines: transcript('expensive', 2.10, 41, 3) },
        { path: join(dir, 'one', 'middle.jsonl'), lines: transcript('middle', 1.00, 25, 2) },
      ];
      for (const { path, lines } of fixtures) {
        await writeFile(path, lines.join('\n') + '\n');
      }
      const malformed = join(dir, 'bad.jsonl');
      await writeFile(malformed, 'not json\n42\n');
      await writeFile(join(dir, 'ignored.txt'), 'not json\n');

      const stdout = capture();
      const stderr = capture();
      expect(await listSessions(dir, stdout, stderr)).toBe(0);

      const rows = stdout.text.trimEnd().split('\n');
      expect(rows).toHaveLength(3);
      expect(rows).toEqual([fixtures[1]!, fixtures[2]!, fixtures[0]!].map(({ lines }) => {
        const summary = summariseSession(lines);
        return [summary.sessionId, summary.cwd, `$${summary.costUSD.toFixed(2)}`,
          summary.totalTokens, summary.toolCalls, formatDuration(summary.durationMs)].join('\t');
      }));
      expect(stderr.text).toBe(`${malformed}: 2 unreadable JSONL record(s)\n`);
      expect(stdout.text + stderr.text).not.toContain('ignored.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('escapes tabs, line breaks and backslashes in the session id and cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      await writeFile(join(dir, 'odd.jsonl'), [
        JSON.stringify({ type: 'user', sessionId: 'a\nb', cwd: '/w\tx\\y\r', timestamp: '2026-01-01T00:00:00Z' }),
      ].join('\n') + '\n');

      const stdout = capture();
      expect(await listSessions(dir, stdout, capture())).toBe(0);

      expect(stdout.text).toBe(['a\\nb', '/w\\tx\\\\y\\r', '$0.00', 0, 0, formatDuration(0)].join('\t') + '\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints a message for an empty directory with a successful exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      const stdout = capture();
      expect(await listSessions(dir, stdout)).toBe(0);
      expect(stdout.text).toBe(`no sessions found under ${dir}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints a message for a missing directory with an unsuccessful exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    await rm(dir, { recursive: true });
    const stdout = capture();
    expect(await listSessions(dir, stdout)).toBe(1);
    expect(stdout.text).toBe(`no sessions found under ${dir}\n`);
  });

  it.skipIf(process.getuid?.() === 0)('reports an unreadable subdirectory and still lists the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    const locked = join(dir, 'locked');
    try {
      await mkdir(locked);
      await writeFile(join(locked, 'hidden.jsonl'), transcript('hidden', 1, 5, 0).join('\n') + '\n');
      await writeFile(join(dir, 'ok.jsonl'), transcript('ok', 0.5, 5, 0).join('\n') + '\n');
      await chmod(locked, 0o000);

      const stdout = capture();
      const stderr = capture();
      expect(await listSessions(dir, stdout, stderr)).toBe(0);

      expect(sessionIds(stdout.text)).toEqual(['ok']);
      expect(stderr.text).toMatch(new RegExp(`^${locked.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: EACCES`));
      expect(stderr.text.trimEnd().split('\n')).toHaveLength(1);
    } finally {
      await chmod(locked, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists a symlinked transcript but does not follow a symlinked directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      await writeFile(join(elsewhere, 'real.jsonl'), transcript('linked', 1, 5, 0).join('\n') + '\n');
      await symlink(join(elsewhere, 'real.jsonl'), join(dir, 'link.jsonl'));
      await symlink(elsewhere, join(dir, 'linkdir'));

      const stdout = capture();
      const stderr = capture();
      expect(await listSessions(dir, stdout, stderr)).toBe(0);

      expect(sessionIds(stdout.text)).toEqual(['linked']);
      expect(stderr.text).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('lists a transcript once when a symlink to it lies in the same tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      await writeFile(join(dir, 'real.jsonl'), transcript('s', 1, 5, 0).join('\n') + '\n');
      await symlink(join(dir, 'real.jsonl'), join(dir, 'dup.jsonl'));

      const stdout = capture();
      const stderr = capture();
      expect(await listSessions(dir, stdout, stderr)).toBe(0);

      expect(sessionIds(stdout.text)).toEqual(['s']);
      expect(stderr.text).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('keeps stdout empty when discovered transcripts are all omitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-lens-omitted-'));
  try {
    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, 'not json\n');
    let stdout = '';
    let stderr = '';
    expect(await listSessions(dir,
      { write(chunk: string) { stdout += chunk; } },
      { write(chunk: string) { stderr += chunk; } },
    )).toBe(0);
    expect(stderr).toBe(`${bad}: 1 unreadable JSONL record(s)\n`);
    expect(stdout).toBe('');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('retains no transcript lines by default and only the selected transcript lines on request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-lens-retention-'));
  const stderr = { write() {} };
  const cheap = join(dir, 'cheap.jsonl');
  const costly = join(dir, 'costly.jsonl');
  const cheapLine = JSON.stringify({ type: 'user', sessionId: 'cheap', message: { content: 'question' } });
  const costlyLine = JSON.stringify({ type: 'assistant', sessionId: 'costly', costUSD: 2,
    message: { content: [{ type: 'text', text: 'answer' }] } });
  try {
    await writeFile(cheap, cheapLine + '\r\n');
    await writeFile(costly, costlyLine + '\n');
    await writeFile(join(dir, 'bad.jsonl'), 'not json\n');

    const ordinary = await readSessions(dir, stderr);
    expect(ordinary.discovered).toBe(3);
    expect(ordinary.sessions.map(({ path }) => path)).toEqual([costly, cheap]);
    for (const session of ordinary.sessions) {
      expect(session).not.toHaveProperty('lines');
    }

    const selected = await readSessions(dir, stderr, (path) => path === cheap);
    expect(selected.discovered).toBe(ordinary.discovered);
    expect(selected.sessions.map(({ summary }) => summary)).toEqual(ordinary.sessions.map(({ summary }) => summary));
    expect(selected.sessions[0]).not.toHaveProperty('lines');
    expect(selected.sessions[1]?.lines).toEqual([cheapLine, '']);

    const all = await readSessions(dir, stderr, () => true);
    expect(all.sessions.map(({ lines }) => lines)).toEqual([[costlyLine, ''], [cheapLine, '']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
