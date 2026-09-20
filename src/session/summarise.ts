/** One session transcript reduced to the facts a session list prints. */
export interface SessionSummary {
  /** The first `sessionId` a record carries, or null when no record has one. */
  sessionId: string | null;
  /** The first `cwd` a record carries, or null when no record has one. */
  cwd: string | null;
  /** The earliest `timestamp`, exactly as the transcript writes it. */
  startedAt: string | null;
  /** The latest `timestamp`, exactly as the transcript writes it. */
  endedAt: string | null;
  /** `endedAt` minus `startedAt`; 0 when fewer than two records are stamped. */
  durationMs: number;
  /** Records whose `type` is `user`. */
  userMessages: number;
  /** Records whose `type` is `assistant`. */
  assistantMessages: number;
  /** Each distinct `message.model` on an assistant record, in first-seen order. */
  models: string[];
  /** Lines that are not a JSON object. */
  unreadable: number;
}

type TranscriptRecord = Record<string, unknown>;

/** A record's `timestamp` both as written and as the instant it names. */
interface Stamp {
  at: string;
  epochMs: number;
}

/**
 * Parse one transcript line, or undefined when it is not a JSON object.
 *
 * A transcript line is a JSON object per record, so anything else the file
 * holds — a truncated write, a bare `42`, `null`, an array — is unreadable
 * rather than a record with nothing in it.
 */
function parseRecord(line: string): TranscriptRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  return parsed as TranscriptRecord;
}

function stringField(record: TranscriptRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The record's timestamp, or undefined when it carries none.
 *
 * A `timestamp` that is not a string, or a string no date can be read out of,
 * names no instant; counting it would leave the span ordered by a NaN
 * comparison, so such a record counts as carrying no timestamp at all.
 */
function stampOf(record: TranscriptRecord): Stamp | undefined {
  const at = stringField(record, 'timestamp');
  if (at === undefined) {
    return undefined;
  }

  const epochMs = Date.parse(at);
  return Number.isNaN(epochMs) ? undefined : { at, epochMs };
}

/** The model an assistant record's nested message names, if it names one. */
function modelOf(record: TranscriptRecord): string | undefined {
  const message = record['message'];
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return undefined;
  }

  return stringField(message as TranscriptRecord, 'model');
}

/**
 * Summarise one session transcript from its JSONL lines.
 *
 * Lines arrive as they were written, one record each. Records of any type
 * contribute their timestamp to the session span — a title or mode record
 * still marks when the session was live — while only `user` and `assistant`
 * records are counted as messages and only `assistant` records name models.
 * An empty or whitespace-only line is skipped and counts as nothing; any
 * other line that is not a JSON object counts as unreadable.
 *
 * @param lines The transcript's lines, in file order.
 */
export function summariseSession(lines: string[]): SessionSummary {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let earliest: Stamp | undefined;
  let latest: Stamp | undefined;
  let stamped = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  const models = new Set<string>();
  let unreadable = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }

    const record = parseRecord(line);
    if (record === undefined) {
      unreadable += 1;
      continue;
    }

    sessionId ??= stringField(record, 'sessionId') ?? null;
    cwd ??= stringField(record, 'cwd') ?? null;

    const stamp = stampOf(record);
    if (stamp !== undefined) {
      stamped += 1;
      // Strict comparisons keep the first record to reach either end of the
      // span, so two records sharing an instant but not its spelling resolve
      // to the spelling the transcript reached first.
      if (earliest === undefined || stamp.epochMs < earliest.epochMs) {
        earliest = stamp;
      }
      if (latest === undefined || stamp.epochMs > latest.epochMs) {
        latest = stamp;
      }
    }

    const type = stringField(record, 'type');
    if (type === 'user') {
      userMessages += 1;
    } else if (type === 'assistant') {
      assistantMessages += 1;
      const model = modelOf(record);
      if (model !== undefined) {
        models.add(model);
      }
    }
  }

  let durationMs = 0;
  if (stamped >= 2 && earliest !== undefined && latest !== undefined) {
    durationMs = latest.epochMs - earliest.epochMs;
  }

  return {
    sessionId,
    cwd,
    startedAt: earliest?.at ?? null,
    endedAt: latest?.at ?? null,
    durationMs,
    userMessages,
    assistantMessages,
    models: [...models],
    unreadable,
  };
}
