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
 * the wall clock it holds, and the offset of the clock it is in —
 * "2026-01-15 03:04:05 +08:00".
 *
 * The console prints absolute times in this form. A bare "03:04:05" of
 * a date is unreadable across time zones: an operator working from
 * another office, or a screenshot pasted into a bug report, has no way
 * to place a moment that carries no zone. The CSV export has always
 * said which clock it was printing; the page now does too.
 */
export declare function formatLocalTimestamp(value: Date | string | null | undefined): string;
