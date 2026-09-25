import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatDuration } from './session/format-duration.js';
import { summariseSession } from './session/summarise.js';
import { listSessions } from './sessions.js';

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
});
