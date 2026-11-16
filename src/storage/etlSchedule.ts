// SPDX-License-Identifier: MIT
//
// The ETL schedule as an operator setting.
//
// How often the IP library refreshes is an operating decision — weekly
// costs less bandwidth than daily and is still ahead of DB-IP's monthly
// release cadence — not a deploy-time constant. It used to live only in
// `ETL_SCHEDULE`, which meant changing it required editing a file on the
// server and restarting the process; the console showed the value as
// read-only text.
//
// The env var is now only the SEED for a fresh install. Once an operator
// saves a value, the database wins and the env var is ignored, so a
// restart cannot silently revert their choice.
//
// The same shape as `loadRandomGenConfig` (src/storage/randomProbeLog.ts):
// read the settings table, clamp/validate, fall back to the default.
import type { Pool } from "mysql2/promise";
import * as cron from "node-cron";
import { getSetting, setSetting } from "./settings";

/** Every day at 02:00 UTC — the value `ETL_SCHEDULE` shipped with. */
export const DEFAULT_ETL_SCHEDULE = "0 2 * * *";

/** The timezone the default expression is written in. */
export const DEFAULT_ETL_TIMEZONE = "UTC";

const SCHEDULE_KEY = "etl_schedule";
const TIMEZONE_KEY = "etl_timezone";

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
export function validateCronExpression(expression: string): string | null {
  const trimmed = (expression ?? "").trim();
  if (trimmed === "") return "Cron 表达式不能为空";
  // node-cron's validate() is happy with six-field expressions (seconds
  // first) and unhappy with nonsense; it is the same parser the scheduler
  // uses, so agreeing with it is the only check that matters.
  if (!cron.validate(trimmed)) {
    return `无效的 cron 表达式：${trimmed}（例如「每周一 02:00」写作 0 2 * * 1）`;
  }
  return null;
}

/**
 * Validate an IANA timezone name.
 *
 * `Intl.DateTimeFormat` throws on an unknown zone, which is the check
 * available without pulling in a tz database.
 */
export function validateTimezone(timezone: string): string | null {
  const trimmed = (timezone ?? "").trim();
  if (trimmed === "") return "时区不能为空";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return null;
  } catch {
    return `无效的时区：${trimmed}（例如 UTC、Asia/Shanghai）`;
  }
}

/**
 * Resolve the schedule the scheduler should run.
 *
 * Precedence: a saved setting, then the environment seed, then the
 * default. A stored value that does not validate is reported through
 * `warning` and the next source is used — a hand-edited database row must
 * not take the scheduler down.
 */
export async function loadEtlScheduleConfig(
  pool: Pool,
  seed: EtlScheduleSeed = {},
): Promise<EtlScheduleConfig> {
  const [savedSchedule, savedTimezone] = await Promise.all([
    getSetting(pool, SCHEDULE_KEY),
    getSetting(pool, TIMEZONE_KEY),
  ]);

  const seedSchedule = (seed.schedule ?? "").trim();
  const seedTimezone = (seed.timezone ?? "").trim();

  // Saved values win, but only when both halves are usable. A schedule
  // with a broken timezone would fire at the wrong hour, so they are
  // accepted or rejected together.
  if (savedSchedule !== null) {
    const problems: string[] = [];
    const scheduleProblem = validateCronExpression(savedSchedule);
    if (scheduleProblem) problems.push(scheduleProblem);

    const effectiveTimezone =
      savedTimezone !== null && savedTimezone.trim() !== ""
        ? savedTimezone
        : seedTimezone || DEFAULT_ETL_TIMEZONE;
    const timezoneProblem = validateTimezone(effectiveTimezone);
    if (timezoneProblem) problems.push(timezoneProblem);

    if (problems.length === 0) {
      return {
        schedule: savedSchedule.trim(),
        timezone: effectiveTimezone.trim(),
        source: "saved",
        warning: null,
      };
    }
    // Fall through to the seed, carrying the complaint for the console.
    const fallback = resolveSeed(seedSchedule, seedTimezone);
    return {
      ...fallback,
      warning: `已保存的调度设置无效，已回退：${problems.join("；")}`,
    };
  }

  return resolveSeed(seedSchedule, seedTimezone);
}

/** The env seed, or the documented default when the seed is absent. */
function resolveSeed(seedSchedule: string, seedTimezone: string): EtlScheduleConfig {
  const schedule = seedSchedule === "" ? DEFAULT_ETL_SCHEDULE : seedSchedule;
  const timezone = seedTimezone === "" ? DEFAULT_ETL_TIMEZONE : seedTimezone;

  const scheduleProblem = validateCronExpression(schedule);
  if (scheduleProblem) {
    return {
      schedule: DEFAULT_ETL_SCHEDULE,
      timezone: DEFAULT_ETL_TIMEZONE,
      source: "default",
      warning: `环境变量中的调度设置无效，已回退到默认值：${scheduleProblem}`,
    };
  }
  const timezoneProblem = validateTimezone(timezone);
  if (timezoneProblem) {
    return {
      schedule,
      timezone: DEFAULT_ETL_TIMEZONE,
      source: seedSchedule === "" ? "default" : "env",
      warning: `环境变量中的时区无效，已回退到 UTC：${timezoneProblem}`,
    };
  }

  return {
    schedule,
    timezone,
    source: seedSchedule === "" && seedTimezone === "" ? "default" : "env",
    warning: null,
  };
}

/**
 * Persist a new schedule.
 *
 * Validates BEFORE writing, so a rejected save leaves the previous value
 * intact — the operator keeps a working schedule rather than discovering
 * on the next restart that the scheduler cannot start.
 */
export async function saveEtlScheduleConfig(
  pool: Pool,
  update: { schedule: string; timezone: string },
): Promise<EtlScheduleConfig> {
  const schedule = (update.schedule ?? "").trim();
  const timezone = (update.timezone ?? "").trim();

  const scheduleProblem = validateCronExpression(schedule);
  if (scheduleProblem) throw new Error(scheduleProblem);
  const timezoneProblem = validateTimezone(timezone);
  if (timezoneProblem) throw new Error(timezoneProblem);

  await Promise.all([
    setSetting(pool, SCHEDULE_KEY, schedule),
    setSetting(pool, TIMEZONE_KEY, timezone),
  ]);

  return { schedule, timezone, source: "saved", warning: null };
}

/** Presets the console offers, so an operator does not have to remember
 *  cron syntax for the common choices. */
export const ETL_SCHEDULE_PRESETS: ReadonlyArray<{
  id: string;
  schedule: string;
}> = [
  { id: "daily", schedule: "0 2 * * *" },
  { id: "weekly", schedule: "0 2 * * 1" },
  { id: "monthly", schedule: "0 2 1 * *" },
];
