import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { formatDuration } from './session/format-duration.js';
import { summariseSession } from './session/summarise.js';
import type { SessionSummary } from './session/summarise.js';

export type Writer = { write(chunk: string): unknown };

/**
 * Every `*.jsonl` file under `directory`, following symlinks to files but not
 * to directories (which could form a cycle). A nested directory or symlink
 * that cannot be read is reported on stderr and skipped; only a failure to
 * read the top-level directory itself is thrown.
 */
async function transcripts(directory: string, stderr: Writer, nested = false): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (!nested) throw error;
    stderr.write(`${directory}: ${reason(error)}\n`);
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await transcripts(path, stderr, true));
    } else if (entry.name.endsWith('.jsonl')) {
      if (entry.isFile()) {
        files.push(path);
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(path)).isFile()) files.push(path);
        } catch (error) {
          stderr.write(`${path}: ${reason(error)}\n`);
        }
      }
    }
  }
  return files;
}

/**
 * A transcript-sourced string made safe for one table cell: a tab or line
 * break inside it would otherwise split its row into extra columns or rows,
 * and a backslash is escaped too so a literal `\t` stays distinguishable.
 */
function cell(value: string): string {
  return value.replace(/[\\\t\n\r]/g, (char) =>
    ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[char]!);
}

export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A readable transcript found under a directory, with its summary. */
export interface ListedSession {
  path: string;
  /** The transcript's lines as read for `summary`, in file order. */
  lines: string[];
  summary: SessionSummary;
}

/**
 * Summarise every readable transcript under `directory`, highest cost first,
 * with how many transcripts were discovered, omitted ones included. A
 * transcript that cannot be read, or holds unreadable records, is reported
 * on stderr and omitted; a failure to read `directory` itself is thrown.
 */
export async function readSessions(
  directory: string,
  stderr: Writer = process.stderr,
): Promise<{ sessions: ListedSession[]; discovered: number }> {
  const files = await transcripts(directory, stderr);
  const sessions: ListedSession[] = [];
  // A transcript reached through both a symlink and its target is listed once.
  const seen = new Set<string>();
  for (const path of files) {
    try {
      const real = await realpath(path);
      if (seen.has(real)) continue;
      seen.add(real);
      const text = await readFile(path, 'utf8');
      const lines = text.split(/\r?\n/);
      const summary = summariseSession(lines);
      if (summary.unreadable > 0) {
        stderr.write(`${path}: ${summary.unreadable} unreadable JSONL record(s)\n`);
        continue;
      }
      sessions.push({ path, lines, summary });
    } catch (error) {
      stderr.write(`${path}: ${reason(error)}\n`);
    }
  }

  sessions.sort((a, b) => b.summary.costUSD - a.summary.costUSD || a.path.localeCompare(b.path));
  return { sessions, discovered: files.length };
}

/**
 * The six values a session list shows for one session: session ID, working
 * directory, dollar cost, total tokens, tool calls and elapsed time. `text`
 * makes the transcript-sourced ID and directory safe for the output format.
 */
export function sessionColumns(summary: SessionSummary, text: (value: string) => string): string[] {
  return [
    text(summary.sessionId ?? '-'),
    text(summary.cwd ?? '-'),
    `$${summary.costUSD.toFixed(2)}`,
    String(summary.totalTokens),
    String(summary.toolCalls),
    formatDuration(summary.durationMs),
  ];
}

/** Print one tab-separated row per readable transcript, highest cost first, at most `limit` of them. */
export async function listSessions(
  directory: string,
  stdout: Writer = process.stdout,
  stderr: Writer = process.stderr,
  limit = Infinity,
): Promise<number> {
  let sessions: ListedSession[];
  let discovered: number;
  try {
    ({ sessions, discovered } = await readSessions(directory, stderr));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      stdout.write(`no sessions found under ${directory}\n`);
    } else {
      stderr.write(`${directory}: ${reason(error)}\n`);
    }
    return 1;
  }

  if (discovered === 0) {
    stdout.write(`no sessions found under ${directory}\n`);
    return 0;
  }

  for (const { summary } of sessions.slice(0, limit)) {
    stdout.write(sessionColumns(summary, cell).join('\t') + '\n');
  }
  return 0;
}
