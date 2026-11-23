// SPDX-License-Identifier: MIT

/**
 * A DATETIME the database wrote, printed for a human or a spreadsheet.
 *
 * The pool reads these literals in the SERVER's own clock — that is what
 * `timezone: "local"` in the pool configuration means — so the Date the
 * driver hands back IS the wall clock the server wrote, not an instant
 * in UTC.
 *
 * Printing it through `toISOString()` converts it, which shifts the
 * digits by the server's offset from UTC. A CSV export would then
 * disagree with the console, which prints the wall clock: the same row,
 * two different times, in two places a minute apart.
 *
 * So the offset is written out instead. The digits stay the ones the
 * database holds, and the string says which clock they are in.
 */

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/**
 * The Date a value carries, or null when there is nothing to print.
 *
 * A missing or unparseable value is not a time — it renders as the empty
 * string, because a cell that cannot be read is worse than one that is
 * blank.
 */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const epochMs = date.getTime();
  if (typeof epochMs !== "number" || Number.isNaN(epochMs)) return null;
  return date;
}

/**
 * The offset of the clock the date is written in, as "±HH:MM".
 *
 * This is the offset of the zone the DIGITS are in — the zone the driver
 * read the literal in, which is the zone the server wrote it in. It is
 * not an offset from UTC applied to the digits: it says which clock
 * those digits are, so a reader in another zone can place them.
 */
function offsetLabel(date: Date): string {
  // getTimezoneOffset() is the number of minutes to ADD to local time to
  // reach UTC, so the offset FROM UTC is its negation.
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * Format a timestamp the database wrote as ISO-8601 in the clock it was
 * written in: "2026-01-15T03:04:05.067+08:00".
 *
 * A missing or unparseable value renders as the empty string — a CSV
 * cell that cannot be read is worse than one that is blank.
 */
export function formatDbTimestamp(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "";

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    offsetLabel(date)
  );
}

/**
 * Format a timestamp the database wrote the way a person reads a clock:
 * the wall clock it holds — "2026-01-15 03:04:05".
 *
 * The console prints absolute times in this form. Printing them through
 * `toISOString()` instead would convert the wall clock into UTC and
 * shift every one of them by the server's offset from UTC.
 */
export function formatLocalTimestamp(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "";

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
