import { formatDuration } from './session/format-duration.js';
import { summariseSession } from './session/summarise.js';
import type { SessionSummary } from './session/summarise.js';
import { cell, readTranscripts } from './transcripts.js';
import type { Writer } from './transcripts.js';

/** Print one tab-separated row per readable transcript, highest cost first. */
export async function listSessions(
  directory: string,
  stdout: Writer = process.stdout,
  stderr: Writer = process.stderr,
): Promise<number> {
  const transcripts = await readTranscripts(directory, stdout, stderr);
  if (typeof transcripts === 'number') return transcripts;

  const sessions: { path: string; summary: SessionSummary }[] = transcripts.map(({ path, lines }) =>
    ({ path, summary: summariseSession(lines) }));

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
