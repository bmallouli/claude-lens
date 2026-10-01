import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

const root = process.cwd();

beforeAll(() => {
  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: root });
}, 60_000);

it.each(['9007199254740992', '1' + '0'.repeat(310)])('accepts positive whole-number limit %s without an upper bound', async (limit) => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-lens-'));
  try {
    for (const [id, cost] of [['one', 1], ['three', 3], ['two', 2]] as const) {
      await writeFile(join(dir, `${id}.jsonl`), [
        JSON.stringify({ type: 'user', sessionId: id, cwd: '/w' }),
        JSON.stringify({ type: 'assistant', costUSD: cost }),
      ].join('\n') + '\n');
    }
    await writeFile(join(dir, 'bad.jsonl'), 'not json\n');

    const result = spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'sessions', dir, '--limit', limit], {
      encoding: 'utf8', env: { ...process.env, NODE_USE_ENV_PROXY: '0' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('three\t/w\t$3.00\t0\t0\t0s\ntwo\t/w\t$2.00\t0\t0\t0s\none\t/w\t$1.00\t0\t0\t0s\n');
    expect(result.stderr).toBe(`${join(dir, 'bad.jsonl')}: 1 unreadable JSONL record(s)\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
