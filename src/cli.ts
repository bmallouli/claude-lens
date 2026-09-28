#!/usr/bin/env node
import { listSessions } from './sessions.js';
import { listTools } from './tools.js';

const commands = { sessions: listSessions, tools: listTools };
const command = process.argv[2];

if (process.argv.length !== 4 || (command !== 'sessions' && command !== 'tools')) {
  process.stderr.write('usage: claude-lens sessions <dir>\n       claude-lens tools <dir>\n');
  process.exitCode = 1;
} else {
  commands[command](process.argv[3]!).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
