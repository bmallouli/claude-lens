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
});
