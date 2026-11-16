/**
 * Throttled progress reporter for the long ETL stages.
 *
 * The insert stage can run for twenty minutes over eight million rows.
 * Without any output an operator watching the CLI has no way to tell
 * "working" from "hung", and the only signal in the database is a
 * progress column the CLI never reads. This prints one line periodically
 * with the rate and the projected finish, which is the difference between
 * waiting and killing the process.
 *
 * Throttled by TIME, not by row count: a slow disk and a fast one should
 * produce the same number of lines per minute.
 */
export interface ProgressReporter {
  /** Record that `count` more units are done. Prints when the interval
   *  has elapsed since the last print. */
  tick(count: number): void;
  /** Print a final line with the true total, regardless of the interval. */
  finish(): void;
}

export function createProgressReporter(opts: {
  /** What the units are, for the message: "rows", "files", "bytes". */
  unit: string;
  /** How often to print, in milliseconds. */
  intervalMs?: number;
  /** A label shown before the counters, e.g. the source name. */
  label: string;
  /** Total units expected. When unknown, the percentage and ETA are
   *  omitted rather than guessed. */
  total?: number;
  /** Where the line goes. Injectable so tests can capture it. */
  write?: (line: string) => void;
}): ProgressReporter {
  const intervalMs = opts.intervalMs ?? 10_000;
  const write = opts.write ?? ((line: string) => console.log(line));
  let done = 0;
  let lastPrintedAt = Date.now();
  let startedAt = lastPrintedAt;

  const formatDuration = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) return "?";
    const whole = Math.round(seconds);
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    return minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
  };

  const render = (final: boolean): string => {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = elapsedSec > 0 ? done / elapsedSec : 0;
    const parts = [`[etl] ${opts.label}`];

    if (opts.total !== undefined && opts.total > 0) {
      const pct = Math.min(100, (done / opts.total) * 100);
      parts.push(`${done.toLocaleString()}/${opts.total.toLocaleString()} ${opts.unit} (${pct.toFixed(1)}%)`);
      const remaining = opts.total - done;
      if (rate > 0 && remaining > 0) {
        parts.push(`eta ${formatDuration(remaining / rate)}`);
      }
    } else {
      parts.push(`${done.toLocaleString()} ${opts.unit}`);
    }

    parts.push(`${Math.round(rate).toLocaleString()} ${opts.unit}/s`);
    parts.push(`elapsed ${formatDuration(elapsedSec)}`);
    if (final) parts.push("done");
    return parts.join(" · ");
  };

  return {
    tick(count: number): void {
      done += count;
      const now = Date.now();
      if (now - lastPrintedAt < intervalMs) return;
      lastPrintedAt = now;
      write(render(false));
    },
    finish(): void {
      write(render(true));
    },
  };
}
