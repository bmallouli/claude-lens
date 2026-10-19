import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Builds dist/ once before any test file runs. Test files that each rebuilt it in their own
 * beforeAll raced one another: tsc rewriting dist/cli.js while another file spawned it left
 * that spawn reading an empty file.
 */
export default function setup(): void {
  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: root });
}
