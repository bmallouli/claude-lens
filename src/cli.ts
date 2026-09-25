#!/usr/bin/env node
import { listSessions } from './sessions.js';

if (process.argv.length !== 4 || process.argv[2] !== 'sessions') {
  process.stderr.write('usage: claude-lens sessions <dir>\n');
  process.exitCode = 1;
} else {
  listSessions(process.argv[3]!).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
