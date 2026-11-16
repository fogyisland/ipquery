"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ETL_SCHEDULE_PRESETS = exports.DEFAULT_ETL_TIMEZONE = exports.DEFAULT_ETL_SCHEDULE = void 0;
exports.validateCronExpression = validateCronExpression;
exports.validateTimezone = validateTimezone;
exports.loadEtlScheduleConfig = loadEtlScheduleConfig;
exports.saveEtlScheduleConfig = saveEtlScheduleConfig;
const cron = __importStar(require("node-cron"));
const settings_1 = require("./settings");
/** Every day at 02:00 UTC — the value `ETL_SCHEDULE` shipped with. */
exports.DEFAULT_ETL_SCHEDULE = "0 2 * * *";
/** The timezone the default expression is written in. */
exports.DEFAULT_ETL_TIMEZONE = "UTC";
const SCHEDULE_KEY = "etl_schedule";
const TIMEZONE_KEY = "etl_timezone";
/**
 * Validate a cron expression.
 *
 * Returns null when it is usable, or a human-readable problem when it is
 * not. The message is shown to the operator, so it says what is wrong
 * rather than echoing a parser error.
 */
function validateCronExpression(expression) {
    const trimmed = (expression ?? "").trim();
    if (trimmed === "")
        return "Cron 表达式不能为空";
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
function validateTimezone(timezone) {
    const trimmed = (timezone ?? "").trim();
    if (trimmed === "")
        return "时区不能为空";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
        return null;
    }
    catch {
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
async function loadEtlScheduleConfig(pool, seed = {}) {
    const [savedSchedule, savedTimezone] = await Promise.all([
        (0, settings_1.getSetting)(pool, SCHEDULE_KEY),
        (0, settings_1.getSetting)(pool, TIMEZONE_KEY),
    ]);
    const seedSchedule = (seed.schedule ?? "").trim();
    const seedTimezone = (seed.timezone ?? "").trim();
    // Saved values win, but only when both halves are usable. A schedule
    // with a broken timezone would fire at the wrong hour, so they are
    // accepted or rejected together.
    if (savedSchedule !== null) {
        const problems = [];
        const scheduleProblem = validateCronExpression(savedSchedule);
        if (scheduleProblem)
            problems.push(scheduleProblem);
        const effectiveTimezone = savedTimezone !== null && savedTimezone.trim() !== ""
            ? savedTimezone
            : seedTimezone || exports.DEFAULT_ETL_TIMEZONE;
        const timezoneProblem = validateTimezone(effectiveTimezone);
        if (timezoneProblem)
            problems.push(timezoneProblem);
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
function resolveSeed(seedSchedule, seedTimezone) {
    const schedule = seedSchedule === "" ? exports.DEFAULT_ETL_SCHEDULE : seedSchedule;
    const timezone = seedTimezone === "" ? exports.DEFAULT_ETL_TIMEZONE : seedTimezone;
    const scheduleProblem = validateCronExpression(schedule);
    if (scheduleProblem) {
        return {
            schedule: exports.DEFAULT_ETL_SCHEDULE,
            timezone: exports.DEFAULT_ETL_TIMEZONE,
            source: "default",
            warning: `环境变量中的调度设置无效，已回退到默认值：${scheduleProblem}`,
        };
    }
    const timezoneProblem = validateTimezone(timezone);
    if (timezoneProblem) {
        return {
            schedule,
            timezone: exports.DEFAULT_ETL_TIMEZONE,
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
async function saveEtlScheduleConfig(pool, update) {
    const schedule = (update.schedule ?? "").trim();
    const timezone = (update.timezone ?? "").trim();
    const scheduleProblem = validateCronExpression(schedule);
    if (scheduleProblem)
        throw new Error(scheduleProblem);
    const timezoneProblem = validateTimezone(timezone);
    if (timezoneProblem)
        throw new Error(timezoneProblem);
    await Promise.all([
        (0, settings_1.setSetting)(pool, SCHEDULE_KEY, schedule),
        (0, settings_1.setSetting)(pool, TIMEZONE_KEY, timezone),
    ]);
    return { schedule, timezone, source: "saved", warning: null };
}
/** Presets the console offers, so an operator does not have to remember
 *  cron syntax for the common choices. */
exports.ETL_SCHEDULE_PRESETS = [
    { id: "daily", schedule: "0 2 * * *" },
    { id: "weekly", schedule: "0 2 * * 1" },
    { id: "monthly", schedule: "0 2 1 * *" },
];
//# sourceMappingURL=etlSchedule.js.map