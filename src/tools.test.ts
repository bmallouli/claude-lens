import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listTools, tallyTools } from './tools.js';

function capture() {
  let text = '';
  return { write(chunk: string) { text += chunk; }, get text() { return text; } };
}

function use(id: string, name: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
}

function result(id: string, isError: boolean): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });
}

describe('tool tally', () => {
  it('orders tools with equal call counts by name ascending', () => {
    expect(tallyTools([[use('1', 'Write'), use('2', 'Edit'), use('3', 'Grep')]])).toEqual([
      { name: 'Edit', calls: 1, errors: 0 },
      { name: 'Grep', calls: 1, errors: 0 },
      { name: 'Write', calls: 1, errors: 0 },
    ]);
  });

  it('counts a call with no matching result, but not as an error', () => {
    expect(tallyTools([[use('1', 'Bash'), use('2', 'Bash'), result('2', true)]])).toEqual([
      { name: 'Bash', calls: 2, errors: 1 },
    ]);
  });
});

describe('tools listing', () => {
  it('prints each tool with its calls and errors across transcripts, most-called first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      await writeFile(join(dir, 'one.jsonl'), [
        use('a', 'Bash'), result('a', false), use('b', 'Read'), result('b', false),
      ].join('\n') + '\n');
      await writeFile(join(dir, 'two.jsonl'), [
        use('c', 'Bash'), result('c', true), use('d', 'Bash'), result('d', false),
      ].join('\n') + '\n');

      const stdout = capture();
      expect(await listTools(dir, stdout, capture())).toBe(0);
      expect(stdout.text).toBe('tool\tcalls\terrors\nBash\t3\t1\nRead\t1\t0\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints a message for an empty directory with a successful exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      const stdout = capture();
      expect(await listTools(dir, stdout)).toBe(0);
      expect(stdout.text).toBe(`no sessions found under ${dir}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
