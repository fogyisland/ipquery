import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, redactSecret } from "../../src/config";

describe("config", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns defaults when env vars are unset", () => {
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.MAXMIND_LICENSE_KEY;
    const cfg = loadConfig();
    expect(cfg.db.host).toBe("localhost");
    expect(cfg.db.port).toBe(3306);
    expect(cfg.maxmind.editions).toEqual(["GeoLite2-City", "GeoLite2-ASN"]);
    expect(cfg.maxmind.licenseKey).toBeUndefined();
  });

  it("parses comma-separated editions list", () => {
    process.env.MAXMIND_EDITIONS = "GeoLite2-City,GeoLite2-ASN,GeoLite2-Country";
    const cfg = loadConfig();
    expect(cfg.maxmind.editions).toEqual(["GeoLite2-City", "GeoLite2-ASN", "GeoLite2-Country"]);
  });

  it("throws on invalid cron expression", () => {
    process.env.ETL_SCHEDULE = "not a cron";
    expect(() => loadConfig()).toThrow(/ETL_SCHEDULE/);
  });

  it("accepts a valid 5-field cron", () => {
    process.env.ETL_SCHEDULE = "0 2 * * *";
    expect(() => loadConfig()).not.toThrow();
  });

  it("redactSecret masks middle of long string", () => {
    expect(redactSecret("abcdefghijklmnop")).toBe("abcd…mnop");
  });

  it("redactSecret leaves short strings fully masked", () => {
    expect(redactSecret("short")).toBe("*****");
  });
});
