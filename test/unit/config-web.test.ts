// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config";

describe("web config", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = [
    "WEB_BASE_URL",
    "COOKIE_DOMAIN",
    "COOKIE_SECURE",
    "SESSION_TTL_HOURS",
    "SESSION_SECRET",
    "CSRF_SECRET",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
    "LOGIN_MAX_ATTEMPTS",
    "LOGIN_LOCKOUT_MINUTES",
    "SIGNUP_RATE_PER_IP_PER_HOUR",
    "VERIFY_RESEND_COOLDOWN_SECONDS",
    "ADMIN_BOOTSTRAP_EMAIL",
    "ADMIN_BOOTSTRAP_PASSWORD",
  ];
  beforeEach(() => {
    for (const k of KEYS) {
      SAVED[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
  });

  it("default values", () => {
    const cfg = loadConfig();
    expect(cfg.web.baseUrl).toBe("http://localhost:3100");
    expect(cfg.web.cookieDomain).toBe("");
    expect(cfg.web.cookieSecure).toBe(false);
    expect(cfg.web.sessionTtlHours).toBe(168);
    expect(cfg.smtp.host).toBe("");
    expect(cfg.security.loginMaxAttempts).toBe(5);
    expect(cfg.security.loginLockoutMinutes).toBe(15);
  });

  it("parses numeric and boolean envs", () => {
    process.env.SESSION_TTL_HOURS = "24";
    process.env.COOKIE_SECURE = "true";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.LOGIN_MAX_ATTEMPTS = "10";
    const cfg = loadConfig();
    expect(cfg.web.sessionTtlHours).toBe(24);
    expect(cfg.web.cookieSecure).toBe(true);
    expect(cfg.smtp.port).toBe(465);
    expect(cfg.smtp.secure).toBe(true);
    expect(cfg.security.loginMaxAttempts).toBe(10);
  });

  it("rejects invalid SESSION_TTL_HOURS", () => {
    process.env.SESSION_TTL_HOURS = "0";
    expect(() => loadConfig()).toThrow(/SESSION_TTL_HOURS/);
  });

  it("rejects invalid LOGIN_MAX_ATTEMPTS", () => {
    process.env.LOGIN_MAX_ATTEMPTS = "-1";
    expect(() => loadConfig()).toThrow(/LOGIN_MAX_ATTEMPTS/);
  });

  it("admin bootstrap defaults to empty", () => {
    const cfg = loadConfig();
    expect(cfg.admin.email).toBe("");
    expect(cfg.admin.password).toBe("");
  });

  it("reads SMTP_FROM", () => {
    process.env.SMTP_FROM = "a@b.com";
    const cfg = loadConfig();
    expect(cfg.smtp.from).toBe("a@b.com");
  });
});
