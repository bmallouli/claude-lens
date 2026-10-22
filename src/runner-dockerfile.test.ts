import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const dockerfile = readFileSync(join(root, '.forge', 'runner.Dockerfile'), 'utf8');
const packageManager: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;

/** The file's instructions, comment lines dropped and continuation lines joined as Docker joins them. */
const instructions = dockerfile
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')
  .replace(/\\\n/g, '')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [, keyword = '', args = ''] = /^(\S+)\s*(.*)$/.exec(line) ?? [];
    return { keyword: keyword.toUpperCase(), args };
  });
const named = (keyword: string) => instructions.filter((i) => i.keyword === keyword).map((i) => i.args);

describe('.forge/runner.Dockerfile', () => {
  it('builds from the pinned node:22-bookworm image and names every image by tag and digest', () => {
    expect(named('FROM')[0]).toBe('node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384');
    const copied = named('COPY').flatMap((args) => /--from=(\S+)/.exec(args)?.[1] ?? []);
    for (const image of [...named('FROM'), ...copied]) expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('declares no ARG or ADD, copies only from an image and installs no package', () => {
    expect(named('ARG')).toEqual([]);
    expect(named('ADD')).toEqual([]);
    expect(named('COPY').filter((args) => !args.includes('--from='))).toEqual([]);
    expect(named('RUN').filter((args) => /\b(apt|apt-get|curl)\b/.test(args))).toEqual([]);
  });

  it('labels the image for the mounted harness and ends as user runner', () => {
    expect(named('LABEL')).toContain('com.forge.harness=mounted');
    expect(named('USER').at(-1)).toBe('runner');
  });

  it("sets corepack's environment, gives runner an empty /work and /pnpm-store and holds nothing under /opt/forge-sdk", () => {
    expect(named('ENV').join(' ').split(/\s+/)).toEqual(
      expect.arrayContaining(['COREPACK_HOME=/opt/corepack', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0', 'COREPACK_DEFAULT_TO_LATEST=0']),
    );
    expect(instructions.filter((i) => i.args.includes('/opt/forge-sdk'))).toEqual([]);
    const naming = instructions.filter((i) => /\/work\b|\/pnpm-store\b/.test(i.args));
    expect(naming).toHaveLength(1);
    expect(naming[0]?.args).toMatch(/mkdir -p \/work \/pnpm-store\b.*chown runner:runner \/work \/pnpm-store\b/);
  });

  describe('its last RUN step, run as runner from /', () => {
    const last = instructions.findLastIndex((i) => i.keyword === 'RUN');
    const before = instructions.slice(0, last);
    const good = { id: ['1001', 0], git: ['git version 2.39.5', 0], node: ['v22.23.4', 0], pnpm: [packageManager.replace(/^pnpm@/, ''), 0] } as const;

    async function check(tools: Record<keyof typeof good, readonly [string, number]>) {
      const bin = await mkdtemp(join(tmpdir(), 'claude-lens-runner-'));
      try {
        for (const [name, [out, status]] of Object.entries(tools)) {
          await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${out}'\nexit ${status}\n`);
          await chmod(join(bin, name), 0o755);
        }
        return spawnSync('/bin/sh', ['-c', instructions[last]?.args ?? ''], { cwd: '/', encoding: 'utf8', env: { PATH: bin } });
      } finally {
        await rm(bin, { recursive: true, force: true });
      }
    }

    it('runs as runner from /', () => {
      expect(before.filter((i) => i.keyword === 'USER').at(-1)?.args).toBe('runner');
      expect(before.filter((i) => i.keyword === 'WORKDIR').at(-1)?.args).toBe('/');
    });

    it(`passes when id -u prints 1001, git --version exits 0, node is v22 and pnpm is ${packageManager}`, async () => {
      expect((await check(good)).status).toBe(0);
    });

    it.each([
      ['id -u prints another uid', { id: ['1000', 0] }, '1000'],
      ['git --version fails', { git: ['git: not usable', 1] }, 'git: not usable'],
      ['node --version is not v22', { node: ['v20.19.0', 0] }, 'v20.19.0'],
      ['node --version is v2x but not v22', { node: ['v220.0.0', 0] }, 'v220.0.0'],
      ['pnpm --version prints another version', { pnpm: ['10.29.2', 0] }, '10.29.2'],
    ] as const)('fails the build and prints the output when %s', async (_, bad, printed) => {
      const result = await check({ ...good, ...bad });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(printed);
    });
  });
});
