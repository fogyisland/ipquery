// SPDX-License-Identifier: MIT
// Integration test: the ETL schedule is an operator setting, not a
// deploy-time constant.
//
// `ETL_SCHEDULE` in `.env` meant changing how often the library
// refreshes required editing a file on the server and restarting the
// process. The admin console showed the value as read-only text. Weekly
// versus daily is an operating decision, and the operator should be able
// to make it from the console the way they already tune the random-IP
// runner.
//
// The setting now lives in the `settings` table. The env var stays as the
// seed for a fresh install; once an operator saves a value, the database
// wins.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { getSetting, setSetting } from "../../src/storage/settings";
import {
  loadEtlScheduleConfig,
  saveEtlScheduleConfig,
  DEFAULT_ETL_SCHEDULE,
  DEFAULT_ETL_TIMEZONE,
  validateCronExpression,
  validateTimezone,
} from "../../src/storage/etlSchedule";

let td: TestDb;

beforeAll(async () => {
  td = await createTestDb("etl_schedule");
});

afterAll(async () => {
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query("DELETE FROM settings WHERE k LIKE 'etl_schedule%'");
});

describe("ETL schedule settings", () => {
  it("falls back to the documented defaults when nothing is saved", async () => {
    const cfg = await loadEtlScheduleConfig(td.pool);
    expect(cfg.schedule).toBe(DEFAULT_ETL_SCHEDULE);
    expect(cfg.timezone).toBe(DEFAULT_ETL_TIMEZONE);
    expect(cfg.source).toBe("default");
  });

  it("uses the environment value as the seed on a fresh install", async () => {
    const cfg = await loadEtlScheduleConfig(td.pool, {
      schedule: "0 2 * * 1",
      timezone: "Asia/Shanghai",
    });
    expect(cfg.schedule).toBe("0 2 * * 1");
    expect(cfg.timezone).toBe("Asia/Shanghai");
    expect(cfg.source).toBe("env");
  });

  it("prefers a saved value over the environment seed", async () => {
    await setSetting(td.pool, "etl_schedule", "0 3 * * 0");
    await setSetting(td.pool, "etl_timezone", "Asia/Tokyo");
    const cfg = await loadEtlScheduleConfig(td.pool, {
      schedule: "0 2 * * 1",
      timezone: "UTC",
    });
    expect(cfg.schedule).toBe("0 3 * * 0");
    expect(cfg.timezone).toBe("Asia/Tokyo");
    expect(cfg.source).toBe("saved");
  });

  it("saves a new schedule and timezone", async () => {
    await saveEtlScheduleConfig(td.pool, {
      schedule: "0 4 * * 6",
      timezone: "Europe/London",
    });
    expect(await getSetting(td.pool, "etl_schedule")).toBe("0 4 * * 6");
    expect(await getSetting(td.pool, "etl_timezone")).toBe("Europe/London");

    const cfg = await loadEtlScheduleConfig(td.pool);
    expect(cfg.schedule).toBe("0 4 * * 6");
    expect(cfg.timezone).toBe("Europe/London");
    expect(cfg.source).toBe("saved");
  });

  it("rejects an invalid cron expression without touching the saved value", async () => {
    await saveEtlScheduleConfig(td.pool, { schedule: "0 2 * * 1", timezone: "UTC" });
    await expect(
      saveEtlScheduleConfig(td.pool, { schedule: "not a cron", timezone: "UTC" }),
    ).rejects.toThrow(/cron/i);
    // The good value survives a rejected save.
    expect(await getSetting(td.pool, "etl_schedule")).toBe("0 2 * * 1");
  });

  it("rejects an unknown timezone without touching the saved value", async () => {
    await saveEtlScheduleConfig(td.pool, { schedule: "0 2 * * 1", timezone: "UTC" });
    await expect(
      saveEtlScheduleConfig(td.pool, { schedule: "0 2 * * 1", timezone: "Mars/Olympus" }),
    ).rejects.toThrow(/时区/);
    expect(await getSetting(td.pool, "etl_timezone")).toBe("UTC");
  });

  it("falls back to the seed when the saved cron is somehow invalid", async () => {
    // A hand-edited database row must not take the scheduler down: the
    // loader reports the problem and hands back something runnable.
    await setSetting(td.pool, "etl_schedule", "99 99 * * *");
    const cfg = await loadEtlScheduleConfig(td.pool, { schedule: "0 2 * * 1", timezone: "UTC" });
    expect(cfg.schedule).toBe("0 2 * * 1");
    expect(cfg.source).toBe("env");
    expect(cfg.warning).toMatch(/无效/);
  });
});

describe("cron and timezone validation", () => {
  it("accepts the expressions an operator is likely to write", () => {
    for (const expr of ["0 2 * * 1", "0 3 * * 0", "0 2 1 * *", "*/15 * * * *", "0 2 * * *"]) {
      expect(validateCronExpression(expr), expr).toBeNull();
    }
  });

  it("rejects malformed cron expressions with a readable message", () => {
    for (const expr of ["", "not a cron", "0 2 * *", "99 99 * * *"]) {
      const problem = validateCronExpression(expr);
      expect(problem, expr).toBeTruthy();
    }
  });

  it("accepts IANA timezones and rejects invented ones", () => {
    expect(validateTimezone("UTC")).toBeNull();
    expect(validateTimezone("Asia/Shanghai")).toBeNull();
    expect(validateTimezone("Europe/London")).toBeNull();
    expect(validateTimezone("Mars/Olympus")).toBeTruthy();
  });
});
