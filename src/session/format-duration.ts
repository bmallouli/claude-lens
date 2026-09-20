const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Format a session duration as the label the session list prints.
 *
 * Under a minute it is whole seconds (`42s`), under an hour minutes and
 * seconds (`3m 7s`), and from an hour up hours and minutes (`2h 5m`). Every
 * unit rounds down, so a label never claims more time than elapsed.
 *
 * @param ms Elapsed milliseconds; must be finite and non-negative.
 * @throws {RangeError} If `ms` is negative or not finite.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(
      `formatDuration expects a finite, non-negative number of milliseconds, received ${ms}`,
    );
  }

  if (ms < MINUTE_MS) {
    return `${Math.floor(ms / SECOND_MS)}s`;
  }

  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    const seconds = Math.floor((ms - minutes * MINUTE_MS) / SECOND_MS);
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms - hours * HOUR_MS) / MINUTE_MS);
  return `${hours}h ${minutes}m`;
}
