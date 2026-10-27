import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

/** The lines of the `on:` block, up to the next top-level key. */
const triggers = workflow.split('\n\n').find((block) => block.startsWith('on:'))?.split('\n') ?? [];

describe('.github/workflows/ci.yml', () => {
  it('runs on pushes to main and to Forge merge-train branches, in that order', () => {
    const push = triggers.indexOf('  push:');
    expect(push).toBeGreaterThan(-1);
    expect(triggers[push + 1]).toBe('    branches: [main, "forge/merge-train/**"]');
  });
});
