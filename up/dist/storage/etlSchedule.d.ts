import type { Pool } from "mysql2/promise";
/** Every day at 02:00 UTC — the value `ETL_SCHEDULE` shipped with. */
export declare const DEFAULT_ETL_SCHEDULE = "0 2 * * *";
/** The timezone the default expression is written in. */
export declare const DEFAULT_ETL_TIMEZONE = "UTC";
/** Where the effective values came from, so the console can say so. */
export type EtlScheduleSource = "saved" | "env" | "default";
export interface EtlScheduleConfig {
    schedule: string;
    timezone: string;
    source: EtlScheduleSource;
    /** Set when a stored or seeded value had to be replaced because it was
     *  unusable. The scheduler still runs — on the fallback — and the
     *  console can show the operator what was wrong. */
    warning: string | null;
}
/** The environment seed, as the caller read it at boot. */
export interface EtlScheduleSeed {
    schedule?: string;
    timezone?: string;
}
/**
 * Validate a cron expression.
 *
 * Returns null when it is usable, or a human-readable problem when it is
 * not. The message is shown to the operator, so it says what is wrong
 * rather than echoing a parser error.
 */
export declare function validateCronExpression(expression: string): string | null;
/**
 * Validate an IANA timezone name.
 *
 * `Intl.DateTimeFormat` throws on an unknown zone, which is the check
 * available without pulling in a tz database.
 */
export declare function validateTimezone(timezone: string): string | null;
/**
 * Resolve the schedule the scheduler should run.
 *
 * Precedence: a saved setting, then the environment seed, then the
 * default. A stored value that does not validate is reported through
 * `warning` and the next source is used — a hand-edited database row must
 * not take the scheduler down.
 */
export declare function loadEtlScheduleConfig(pool: Pool, seed?: EtlScheduleSeed): Promise<EtlScheduleConfig>;
/**
 * Persist a new schedule.
 *
 * Validates BEFORE writing, so a rejected save leaves the previous value
 * intact — the operator keeps a working schedule rather than discovering
 * on the next restart that the scheduler cannot start.
 */
export declare function saveEtlScheduleConfig(pool: Pool, update: {
    schedule: string;
    timezone: string;
}): Promise<EtlScheduleConfig>;
/** Presets the console offers, so an operator does not have to remember
 *  cron syntax for the common choices. */
export declare const ETL_SCHEDULE_PRESETS: ReadonlyArray<{
    id: string;
    schedule: string;
}>;
