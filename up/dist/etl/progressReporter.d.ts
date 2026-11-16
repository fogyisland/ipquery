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
export declare function createProgressReporter(opts: {
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
}): ProgressReporter;
