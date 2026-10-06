import { describe, expect, it } from 'vitest';

import { displayedMessages } from './messages.js';

const line = (record: object) => JSON.stringify(record);

describe('displayedMessages', () => {
  it('keeps text and tool calls in recorded order, dropping thinking and tool results beside them', () => {
    expect(displayedMessages([
      line({ type: 'assistant', timestamp: 't1', message: { content: [
        { type: 'thinking', thinking: 'hidden', text: 'hidden-too' },
        { type: 'text', text: 'first' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_result', content: 'hidden-result' },
        { type: 'text', text: 'second' },
      ] } }),
    ])).toEqual([{ timestamp: 't1', role: 'assistant', parts: ['first', 'Read {"file_path":"/a"}', 'second'] }]);
  });

  it('reads string content as text and skips blank, meta, sidechain and non-message records', () => {
    expect(displayedMessages([
      '',
      'not json',
      line({ type: 'user', message: { content: 'plain question' } }),
      line({ type: 'user', message: { content: '   ' } }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }),
      line({ type: 'system', message: { content: 'system' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, 'stray', null] } }),
    ])).toEqual([
      { timestamp: null, role: 'user', parts: ['plain question'] },
      { timestamp: null, role: 'assistant', parts: ['Bash'] },
    ]);
  });

  it('keeps records split from one turn as separate messages', () => {
    const record = (text: string) => line({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text }] } });
    expect(displayedMessages([record('a'), record('b')]).map(({ parts }) => parts)).toEqual([['a'], ['b']]);
  });
});
