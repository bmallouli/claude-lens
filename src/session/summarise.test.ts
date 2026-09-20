import { describe, expect, it } from 'vitest';

import { summariseSession } from './summarise.js';

/** The mixed transcript the ticket's acceptance case spans, in its order. */
const MIXED_TRANSCRIPT = [
  '{"type":"custom-title","sessionId":"s1","customTitle":"x"}',
  '{"type":"user","sessionId":"s1","cwd":"/w","timestamp":"2026-01-01T00:00:00.000Z"}',
  '{"type":"assistant","timestamp":"2026-01-01T00:00:30.000Z","message":{"model":"m1"}}',
  '{"type":"assistant","timestamp":"2026-01-01T00:01:00.000Z","message":{"model":"m1"}}',
  '{"type":"assistant","timestamp":"2026-01-01T00:02:00.000Z","message":{"model":"m2"}}',
  '{"type":"file-history-snapshot","snapshot":{}}',
  'not json',
  '42',
  '',
];

describe('summariseSession', () => {
  it('reduces a mixed transcript to one summary', () => {
    expect(summariseSession(MIXED_TRANSCRIPT)).toEqual({
      sessionId: 's1',
      cwd: '/w',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:02:00.000Z',
      durationMs: 120_000,
      userMessages: 1,
      assistantMessages: 3,
      models: ['m1', 'm2'],
      unreadable: 2,
    });
  });

  it('summarises an empty transcript as an empty session', () => {
    expect(summariseSession([])).toEqual({
      sessionId: null,
      cwd: null,
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      userMessages: 0,
      assistantMessages: 0,
      models: [],
      unreadable: 0,
    });
  });

  it('takes the session id and cwd from the first record carrying each', () => {
    const summary = summariseSession([
      '{"type":"custom-title","customTitle":"x"}',
      '{"type":"system","sessionId":"first"}',
      '{"type":"user","sessionId":"second","cwd":"/first"}',
      '{"type":"user","cwd":"/second"}',
    ]);

    expect(summary.sessionId).toBe('first');
    expect(summary.cwd).toBe('/first');
  });

  it('spans the earliest and latest timestamps rather than the first and last lines', () => {
    const summary = summariseSession([
      '{"type":"assistant","timestamp":"2026-01-01T00:05:00.000Z"}',
      '{"type":"user","timestamp":"2026-01-01T00:01:00.000Z"}',
      '{"type":"system","timestamp":"2026-01-01T00:09:00.000Z"}',
      '{"type":"user","timestamp":"2026-01-01T00:03:00.000Z"}',
    ]);

    expect(summary.startedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(summary.endedAt).toBe('2026-01-01T00:09:00.000Z');
    expect(summary.durationMs).toBe(480_000);
  });

  it('keeps timestamps as they are written rather than normalising them', () => {
    const summary = summariseSession([
      '{"type":"user","timestamp":"2026-01-01T01:00:00+01:00"}',
      '{"type":"assistant","timestamp":"2026-01-01T00:30:00.000Z"}',
    ]);

    // `01:00+01:00` is midnight UTC, so the offset line opens the span.
    expect(summary.startedAt).toBe('2026-01-01T01:00:00+01:00');
    expect(summary.endedAt).toBe('2026-01-01T00:30:00.000Z');
    expect(summary.durationMs).toBe(1_800_000);
  });

  it('keeps the first spelling of an instant two records both name', () => {
    const summary = summariseSession([
      '{"type":"user","timestamp":"2026-01-01T01:00:00+01:00"}',
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z"}',
    ]);

    expect(summary.startedAt).toBe('2026-01-01T01:00:00+01:00');
    expect(summary.endedAt).toBe('2026-01-01T01:00:00+01:00');
    expect(summary.durationMs).toBe(0);
  });

  it('reports no duration when a single record carries a timestamp', () => {
    const summary = summariseSession([
      '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}',
      '{"type":"file-history-snapshot"}',
    ]);

    expect(summary.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.endedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.durationMs).toBe(0);
  });

  it('ignores a timestamp no instant can be read out of', () => {
    const summary = summariseSession([
      '{"type":"user","timestamp":"whenever"}',
      '{"type":"assistant","timestamp":1735689600000}',
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z"}',
    ]);

    expect(summary.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.endedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.durationMs).toBe(0);
    expect(summary.unreadable).toBe(0);
  });

  it('lists each model once, in first-seen order, from assistant records only', () => {
    const summary = summariseSession([
      '{"type":"system","message":{"model":"not-an-assistant"}}',
      '{"type":"assistant","message":{"model":"m2"}}',
      '{"type":"assistant","message":{"model":"m1"}}',
      '{"type":"assistant","message":{"model":"m2"}}',
      '{"type":"assistant","message":{"role":"assistant"}}',
      '{"type":"assistant"}',
    ]);

    expect(summary.models).toEqual(['m2', 'm1']);
    expect(summary.assistantMessages).toBe(5);
  });

  it('counts every line that is not a JSON object as unreadable', () => {
    const summary = summariseSession([
      '{"type":"user"}',
      'not json',
      '{"type":"user"',
      '42',
      '"a string"',
      'null',
      '[{"type":"user"}]',
      'true',
    ]);

    expect(summary.unreadable).toBe(7);
    expect(summary.userMessages).toBe(1);
  });

  it('skips blank and whitespace-only lines without counting them', () => {
    const summary = summariseSession(['', '   ', '\t', '\n', '{"type":"user"}']);

    expect(summary.unreadable).toBe(0);
    expect(summary.userMessages).toBe(1);
  });

  it('counts nothing but the span for records of every other type', () => {
    const summary = summariseSession([
      '{"type":"system","timestamp":"2026-01-01T00:00:00.000Z"}',
      '{"type":"attachment","timestamp":"2026-01-01T00:00:10.000Z"}',
      '{"type":"file-history-snapshot","timestamp":"2026-01-01T00:00:20.000Z"}',
      '{"type":"custom-title","customTitle":"x"}',
    ]);

    expect(summary.userMessages).toBe(0);
    expect(summary.assistantMessages).toBe(0);
    expect(summary.models).toEqual([]);
    expect(summary.durationMs).toBe(20_000);
  });
});
