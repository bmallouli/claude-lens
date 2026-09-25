import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatDuration } from './session/format-duration.js';
import { summariseSession } from './session/summarise.js';
import type { SessionSummary } from './session/summarise.js';

async function transcripts(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await transcripts(path));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print one tab-separated row per readable transcript, highest cost first. */
export async function listSessions(
  directory: string,
  stdout: { write(chunk: string): unknown } = process.stdout,
  stderr: { write(chunk: string): unknown } = process.stderr,
): Promise<number> {
  let files: string[];
  try {
    files = await transcripts(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      stdout.write(`no sessions found under ${directory}\n`);
    } else {
      stderr.write(`${directory}: ${reason(error)}\n`);
    }
    return 1;
  }

  if (files.length === 0) {
    stdout.write(`no sessions found under ${directory}\n`);
    return 0;
  }

  const sessions: { path: string; summary: SessionSummary }[] = [];
  for (const path of files) {
    try {
      const text = await readFile(path, 'utf8');
      const summary = summariseSession(text.split(/\r?\n/));
      if (summary.unreadable > 0) {
        stderr.write(`${path}: ${summary.unreadable} unreadable JSONL record(s)\n`);
        continue;
      }
      sessions.push({ path, summary });
    } catch (error) {
      stderr.write(`${path}: ${reason(error)}\n`);
    }
  }

  sessions.sort((a, b) => b.summary.costUSD - a.summary.costUSD || a.path.localeCompare(b.path));
  for (const { summary } of sessions) {
    stdout.write([
      cell(summary.sessionId ?? '-'),
      cell(summary.cwd ?? '-'),
      `$${summary.costUSD.toFixed(2)}`,
      summary.totalTokens,
      summary.toolCalls,
      formatDuration(summary.durationMs),
    ].join('\t') + '\n');
  }
  return 0;
}
