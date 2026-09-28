import { cell, readTranscripts } from './transcripts.js';
import type { Writer } from './transcripts.js';

/** How often one tool was called across transcripts, and how often it failed. */
export interface ToolTally {
  name: string;
  calls: number;
  errors: number;
}

type Block = Record<string, unknown>;

/** The object content blocks of a record's nested `message`, if it has any. */
function blocksOf(line: string): { type: unknown; blocks: Block[] } | undefined {
  if (line.trim() === '') return undefined;
  const record: unknown = JSON.parse(line);
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const { type, message } = record as Record<string, unknown>;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter((block: unknown): block is Block =>
    typeof block === 'object' && block !== null && !Array.isArray(block));
  return { type, blocks };
}

/**
 * Count each tool's assistant `tool_use` blocks across `transcripts` (each one
 * transcript's JSONL lines), and how many of those calls have a `tool_result`
 * with the same `tool_use_id` in the same transcript marked `is_error: true`.
 * A call with no matching result counts as a call and not as an error.
 * Sorted by calls, highest first, ties by tool name ascending.
 */
export function tallyTools(transcripts: string[][]): ToolTally[] {
  const tallies = new Map<string, ToolTally>();
  for (const lines of transcripts) {
    const calls: { name: string; id: unknown }[] = [];
    const failed = new Set<unknown>();
    for (const line of lines) {
      const parsed = blocksOf(line);
      if (parsed === undefined) continue;
      for (const block of parsed.blocks) {
        if (parsed.type === 'assistant' && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
          calls.push({ name: block['name'], id: block['id'] });
        } else if (block['type'] === 'tool_result' && block['is_error'] === true && typeof block['tool_use_id'] === 'string') {
          failed.add(block['tool_use_id']);
        }
      }
    }
    for (const { name, id } of calls) {
      const tally = tallies.get(name) ?? { name, calls: 0, errors: 0 };
      tally.calls += 1;
      if (typeof id === 'string' && failed.has(id)) tally.errors += 1;
      tallies.set(name, tally);
    }
  }
  return [...tallies.values()].sort((a, b) =>
    b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Print a header and one tab-separated row per tool, most-called first. */
export async function listTools(
  directory: string,
  stdout: Writer = process.stdout,
  stderr: Writer = process.stderr,
): Promise<number> {
  const transcripts = await readTranscripts(directory, stdout, stderr);
  if (typeof transcripts === 'number') return transcripts;

  stdout.write('tool\tcalls\terrors\n');
  for (const { name, calls, errors } of tallyTools(transcripts.map(({ lines }) => lines))) {
    stdout.write(`${cell(name)}\t${calls}\t${errors}\n`);
  }
  return 0;
}
