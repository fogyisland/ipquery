/**
 * Format a timestamp the database wrote as ISO-8601 in the clock it was
 * written in: "2026-01-15T03:04:05.067+08:00".
 *
 * A missing or unparseable value renders as the empty string — a CSV
 * cell that cannot be read is worse than one that is blank.
 */
export declare function formatDbTimestamp(value: Date | string | null | undefined): string;
/**
 * Format a timestamp the database wrote the way a person reads a clock:
 * the wall clock it holds — "2026-01-15 03:04:05".
 *
 * The console prints absolute times in this form. Printing them through
 * `toISOString()` instead would convert the wall clock into UTC and
 * shift every one of them by the server's offset from UTC.
 */
export declare function formatLocalTimestamp(value: Date | string | null | undefined): string;
