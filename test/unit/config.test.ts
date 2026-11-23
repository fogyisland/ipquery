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
    const cfg = loadConfig();
    expect(cfg.db.host).toBe("localhost");
    expect(cfg.db.port).toBe(3306);
  });

  it("carries no MaxMind configuration", () => {
    // MaxMind was never wired into the pipeline: the ETL downloads
    // DB-IP and three GitHub-hosted lists and nothing else. The config
    // section for it is gone, so a deployment that still exports
    // MAXMIND_LICENSE_KEY is setting a variable the code ignores.
    //
    // The alternative — keeping the section so an old .env keeps
    // working — would keep advertising a source the project does not
    // use, which is the same false claim the marketing copy used to
    // make.
    delete process.env.MAXMIND_LICENSE_KEY;
    delete process.env.MAXMIND_EDITIONS;
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    expect(cfg).not.toHaveProperty("maxmind");
    expect(cfg).not.toHaveProperty("ip2region");
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

  it("does not trust the proxy header unless told to", () => {
    // The default has to be the safe one: `X-Forwarded-For` is
    // attacker-controlled, and trusting it by default would hand every
    // visitor the right to pick their own rate-limit bucket.
    delete process.env.TRUST_PROXY;
    expect(loadConfig().api.trustProxy).toBe(false);
  });

  it("trusts the proxy header when TRUST_PROXY is set", () => {
    for (const value of ["true", "1"]) {
      process.env.TRUST_PROXY = value;
      expect(loadConfig().api.trustProxy).toBe(true);
    }
  });

  it("treats any other TRUST_PROXY value as off", () => {
    // Not "on" means off. The flag turns on a header that an attacker
    // can forge, so an ambiguous value must resolve to the safe side.
    for (const value of ["false", "0", "yes", "", "TRUE"]) {
      process.env.TRUST_PROXY = value;
      expect(loadConfig().api.trustProxy, `TRUST_PROXY=${value}`).toBe(false);
    }
  });
});
