import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { summariseSession } from './session/summarise.js';

export type Writer = { write(chunk: string): unknown };

/** One readable transcript: where it was found and its lines in file order. */
export interface Transcript {
  path: string;
  lines: string[];
}

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
export function cell(value: string): string {
  return value.replace(/[\\\t\n\r]/g, (char) =>
    ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[char]!);
}

export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every readable transcript under `directory`, or the exit code to finish
 * with when there is nothing to list — its message already printed. A file
 * that cannot be read, or holds any unreadable JSONL record, is reported on
 * stderr and left out.
 */
export async function readTranscripts(
  directory: string,
  stdout: Writer,
  stderr: Writer,
): Promise<Transcript[] | number> {
  let files: string[];
  try {
    files = await transcripts(directory, stderr);
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

  const read: Transcript[] = [];
  // A transcript reached through both a symlink and its target is read once.
  const seen = new Set<string>();
  for (const path of files) {
    try {
      const real = await realpath(path);
      if (seen.has(real)) continue;
      seen.add(real);
      const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
      const { unreadable } = summariseSession(lines);
      if (unreadable > 0) {
        stderr.write(`${path}: ${unreadable} unreadable JSONL record(s)\n`);
        continue;
      }
      read.push({ path, lines });
    } catch (error) {
      stderr.write(`${path}: ${reason(error)}\n`);
    }
  }
  return read;
}
