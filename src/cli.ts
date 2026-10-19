#!/usr/bin/env node
import type { AddressInfo } from 'node:net';

import { defaultPort, host, serveSessions } from './serve.js';
import { listSessions, reason } from './sessions.js';

const usage = 'usage: claude-lens sessions <dir> [--limit <n>]\n';
const serveUsage = 'usage: claude-lens serve <dir> [--port <n>]\n';

/** Split `<dir> [<option> <value>]...` arguments; every value given for `option` is kept, in order. */
function splitArgs(args: string[], option: string): { positional: string[]; values: (string | undefined)[] } {
  const positional: string[] = [];
  const values: (string | undefined)[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === option) {
      values.push(args[++i]);
    } else {
      positional.push(args[i]!);
    }
  }
  return { positional, values };
}

/** Whether an option value is a positive whole number written in decimal digits, however large. */
function positiveWholeNumber(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value) && Number(value) >= 1;
}

/**
 * Parse `<dir> [<option> <n>]...`, naming the first problem found: an option value `accepts` refuses
 * (exit 2, described by `rule`) before a missing or extra `<dir>` (exit 1). The last value given wins.
 */
function parseDirArgs(args: string[], option: string, accepts: (value: string | undefined) => boolean, rule: string):
  { dir: string; value: string | undefined } | { exit: number; problem: string } {
  const { positional, values } = splitArgs(args, option);
  for (const value of values) {
    if (!accepts(value)) {
      const got = value === undefined ? 'nothing' : JSON.stringify(value);
      return { exit: 2, problem: `${option} must be ${rule}, got ${got}` };
    }
  }
  if (positional.length !== 1) {
    return { exit: 1, problem: positional.length === 0 ? 'missing <dir>' : 'expected one <dir>' };
  }
  return { dir: positional[0]!, value: values.at(-1) };
}

function parseArgs(args: string[]): { dir: string; limit: number } | { exit: number; problem: string } {
  const parsed = parseDirArgs(args, '--limit', positiveWholeNumber, 'a whole number of 1 or more');
  return 'exit' in parsed ? parsed : { dir: parsed.dir, limit: parsed.value === undefined ? Infinity : Number(parsed.value) };
}

function parseServeArgs(args: string[]): { dir: string; port: number } | { exit: number; problem: string } {
  const parsed = parseDirArgs(args, '--port', (value) => positiveWholeNumber(value) && Number(value) <= 65535,
    'a whole number from 1 to 65535');
  return 'exit' in parsed ? parsed : { dir: parsed.dir, port: parsed.value === undefined ? defaultPort : Number(parsed.value) };
}

function serve(args: string[]): void {
  const parsed = parseServeArgs(args);
  if ('exit' in parsed) {
    process.stderr.write(`claude-lens serve: ${parsed.problem}\n${serveUsage}`);
    process.exitCode = parsed.exit;
    return;
  }
  serveSessions(parsed.dir, parsed.port, process.stderr).then(
    (server) => {
      const { port } = server.address() as AddressInfo;
      process.stdout.write(`Serving sessions under ${parsed.dir} at http://${host}:${port}/\n`);
    },
    (error: unknown) => {
      process.stderr.write(`claude-lens serve: ${reason(error)}\n`);
      process.exitCode = 1;
    },
  );
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'serve') {
  serve(rest);
} else {
  const parsed = command === 'sessions' ? parseArgs(rest) : { exit: 1, problem: undefined };
  if ('exit' in parsed) {
    process.stderr.write(parsed.problem === undefined ? usage + serveUsage : `claude-lens sessions: ${parsed.problem}\n${usage}`);
    process.exitCode = parsed.exit;
  } else {
    listSessions(parsed.dir, process.stdout, process.stderr, parsed.limit).then(
      (code) => { process.exitCode = code; },
      (error: unknown) => {
        process.stderr.write(`${reason(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
