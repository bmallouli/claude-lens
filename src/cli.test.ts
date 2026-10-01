import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), ...args], { encoding: 'utf8' });
}

describe('claude-lens executable', () => {
  beforeAll(() => {
    execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: root });
  }, 60_000);

  it('lists sessions under a directory and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    try {
      await writeFile(join(dir, 'one.jsonl'), JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/w' }) + '\n');

      const result = run('sessions', dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('s1\t/w\t$0.00\t0\t0\t0s\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 for a missing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
    await rm(dir, { recursive: true });

    const result = run('sessions', dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`no sessions found under ${dir}\n`);
  });

  describe('--limit', () => {
    const transcript = (id: string, cost: number) => [
      JSON.stringify({ type: 'user', sessionId: id, cwd: '/w' }),
      JSON.stringify({ type: 'assistant', costUSD: cost, message: { usage: {}, content: [] } }),
    ].join('\n') + '\n';
    const ids = (stdout: string) => stdout.trimEnd().split('\n').map((row) => row.split('\t')[0]);

    async function withDir(test: (dir: string) => void) {
      const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
      try {
        await writeFile(join(dir, 'a.jsonl'), transcript('three', 3));
        await writeFile(join(dir, 'b.jsonl'), transcript('two', 2));
        await writeFile(join(dir, 'c.jsonl'), transcript('one', 1));
        await writeFile(join(dir, 'bad.jsonl'), 'not json\n');
        test(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    it('prints only the costliest n rows and still reports unreadable transcripts', () => withDir((dir) => {
      const limited = run('sessions', dir, '--limit', '2');
      expect(limited.status).toBe(0);
      expect(ids(limited.stdout)).toEqual(['three', 'two']);
      expect(limited.stderr).toContain('bad.jsonl');
      for (const args of [['--limit', '5'], []]) {
        const all = run('sessions', dir, ...args);
        expect(all.status).toBe(0);
        expect(ids(all.stdout)).toEqual(['three', 'two', 'one']);
        expect(all.stderr).toContain('bad.jsonl');
      }
    }));

    it.each([['0'], ['-1'], ['1.5'], ['x'], []])('rejects --limit %s with status 2', (...value) => withDir((dir) => {
      const result = run('sessions', dir, '--limit', ...value);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr.split('\n').filter((line) => line.startsWith('usage:'))).toEqual(['usage: claude-lens sessions <dir> [--limit <n>]']);
    }));
  });
});
