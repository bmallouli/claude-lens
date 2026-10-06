import { isRecord, objectField, parseRecord, stringField } from './summarise.js';

/** One main-conversation record a session page shows. */
export interface DisplayedMessage {
  /** The record's `timestamp`, exactly as the transcript writes it. */
  timestamp: string | null;
  role: 'user' | 'assistant';
  /** Its text blocks and tool calls in recorded order; a tool call reads as its name followed by its input. */
  parts: string[];
}

/**
 * The messages a session page shows, in file order: each `user` or
 * `assistant` record of the main conversation carrying text or a tool call.
 * Meta and sidechain records are skipped, as is any record holding only
 * thinking or tool results; thinking and tool-result blocks are never shown,
 * even beside text. Records split from one turn stay separate messages.
 *
 * @param lines The transcript's lines, in file order.
 */
export function displayedMessages(lines: string[]): DisplayedMessage[] {
  const messages: DisplayedMessage[] = [];
  for (const line of lines) {
    const record = parseRecord(line);
    if (record === undefined || record['isMeta'] === true || record['isSidechain'] === true) {
      continue;
    }
    const role = stringField(record, 'type');
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    const content = objectField(record, 'message')?.['content'];
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const parts: string[] = [];
    for (const block of blocks) {
      if (!isRecord(block)) {
        continue;
      }
      const text = stringField(block, 'text');
      if (block['type'] === 'text' && text !== undefined && text.trim() !== '') {
        parts.push(text);
      } else if (block['type'] === 'tool_use') {
        const input = block['input'] === undefined ? '' : ` ${JSON.stringify(block['input'])}`;
        parts.push(`${stringField(block, 'name') ?? 'tool'}${input}`);
      }
    }
    if (parts.length > 0) {
      messages.push({ timestamp: stringField(record, 'timestamp') ?? null, role, parts });
    }
  }
  return messages;
}
