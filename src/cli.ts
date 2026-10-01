#!/usr/bin/env node
import { listSessions } from './sessions.js';

const usage = 'usage: claude-lens sessions <dir> [--limit <n>]\n';

function parseArgs(args: string[]): { dir: string; limit: number } | { exit: number } {
  const positional: string[] = [];
  let limit = Infinity;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--limit') {
      positional.push(args[i]!);
      continue;
    }
    const value = args[++i];
    if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      return { exit: 2 };
    }
    limit = Number(value);
  }
  return positional.length === 1 ? { dir: positional[0]!, limit } : { exit: 1 };
}

const [command, ...rest] = process.argv.slice(2);
const parsed = command === 'sessions' ? parseArgs(rest) : { exit: 1 };

if ('exit' in parsed) {
  process.stderr.write(usage);
  process.exitCode = parsed.exit;
} else {
  listSessions(parsed.dir, process.stdout, process.stderr, parsed.limit).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
