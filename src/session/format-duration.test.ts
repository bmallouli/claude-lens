import { describe, expect, it } from 'vitest';

import { formatDuration } from './format-duration.js';

describe('formatDuration', () => {
  it('prints zero as whole seconds', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('rounds down to the last whole second below a minute', () => {
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('switches to minutes and seconds at exactly one minute', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
  });

  it('rounds down to the last whole second below an hour', () => {
    expect(formatDuration(3_599_999)).toBe('59m 59s');
  });

  it('switches to hours and minutes at exactly one hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
  });

  it('counts hours past a day rather than rolling over into days', () => {
    expect(formatDuration(90_061_000)).toBe('25h 1m');
  });

  it('throws a RangeError for a negative duration', () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
  });

  it('throws a RangeError for a non-finite duration', () => {
    expect(() => formatDuration(Number.NaN)).toThrow(RangeError);
  });
});
