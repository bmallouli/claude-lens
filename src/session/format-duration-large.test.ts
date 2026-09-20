import { describe, expect, it } from 'vitest';

import { formatDuration } from './format-duration.js';

describe('formatDuration over durations past exact double integers', () => {
  it('decomposes the represented millisecond value without losing precision', () => {
    // 1.1e24 is stored as 1100000000000000008388608 ms, which is
    // 305555555555555557h 53m.
    expect(formatDuration(1.1e24)).toBe('305555555555555557h 53m');
  });

  it('never prints a negative minute component', () => {
    expect(formatDuration(1.1e24)).not.toMatch(/-/);
  });
});
