// SPDX-License-Identifier: MIT
// The .env file is GENERATED on first start, from .env.example.
//
// The import order below is load-bearing:
//
//   1. `./api/envBootstrap` runs and creates .env if it does not exist.
//   2. `dotenv/config` loads .env into process.env.
//   3. loadConfig() resolves the config from process.env.
//
// The bootstrap has to come first: a .env written after the config was
// resolved is a file the running process never reads. And it cannot
// import this module — that would be a cycle — so it carries its own
// (small) copy of the parsing rules.
import { bootstrapEnvFile } from "./api/envBootstrap";

bootstrapEnvFile();

import "dotenv/config"; // side-effect import: auto-loads .env into process.env at module load
import * as cronParser from "node-cron";

export interface WebConfig {
  baseUrl: string;
  cookieDomain: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  sessionSecret: string;
  csrfSecret: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface SecurityConfig {
  loginMaxAttempts: number;
  loginLockoutMinutes: number;
  signupRatePerIpPerHour: number;
  verifyResendCooldownSeconds: number;
}

export interface AdminBootstrap {
  email: string;
  password: string;
}

export interface AppConfig {
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize: number;
  };
  maxmind: { licenseKey?: string; editions: string[] };
  api: { port: number; rateLimit: number };
  etl: { schedule: string; timezone: string; dataDir: string };
  web: WebConfig;
  smtp: SmtpConfig;
  security: SecurityConfig;
  admin: AdminBootstrap;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected number, got ${v}`);
  return n;
}

function str(v: string | undefined, fallback: string): string {
  return v === undefined || v === "" ? fallback : v;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

export function loadConfig(): AppConfig {
  const schedule = str(process.env.ETL_SCHEDULE, "0 2 * * *");
  if (!cronParser.validate(schedule)) {
    throw new Error(`ETL_SCHEDULE is not a valid cron expression: ${schedule}`);
  }

  const sessionTtl = num(process.env.SESSION_TTL_HOURS, 168);
  if (sessionTtl < 1) throw new Error("SESSION_TTL_HOURS must be >= 1");
  const loginMax = num(process.env.LOGIN_MAX_ATTEMPTS, 5);
  if (loginMax < 1) throw new Error("LOGIN_MAX_ATTEMPTS must be >= 1");

  return {
    db: {
      host: str(process.env.DB_HOST, "localhost"),
      port: num(process.env.DB_PORT, 3306),
      user: str(process.env.DB_USER, "root"),
      password: str(process.env.DB_PASSWORD, "rootpass"),
      database: str(process.env.DB_NAME, "ipquery"),
      poolSize: num(process.env.DB_POOL_SIZE, 10),
    },
    maxmind: {
      licenseKey: process.env.MAXMIND_LICENSE_KEY || undefined,
      editions: str(process.env.MAXMIND_EDITIONS, "GeoLite2-City,GeoLite2-ASN")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    api: {
      port: num(process.env.PORT, 3880),
      rateLimit: num(process.env.RATE_LIMIT, 60),
    },
    etl: {
      schedule,
      timezone: str(process.env.ETL_TIMEZONE, "UTC"),
      dataDir: str(process.env.DATA_DIR, "./data"),
    },
    web: {
      baseUrl: str(process.env.WEB_BASE_URL, "http://localhost:3880"),
      cookieDomain: str(process.env.COOKIE_DOMAIN, ""),
      cookieSecure: bool(process.env.COOKIE_SECURE, false),
      sessionTtlHours: sessionTtl,
      sessionSecret: str(process.env.SESSION_SECRET, ""),
      csrfSecret: str(process.env.CSRF_SECRET, ""),
    },
    smtp: {
      host: str(process.env.SMTP_HOST, ""),
      port: num(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: str(process.env.SMTP_USER, ""),
      pass: str(process.env.SMTP_PASS, ""),
      from: str(process.env.SMTP_FROM, "IPQuery <noreply@example.com>"),
    },
    security: {
      loginMaxAttempts: loginMax,
      loginLockoutMinutes: num(process.env.LOGIN_LOCKOUT_MINUTES, 15),
      signupRatePerIpPerHour: num(process.env.SIGNUP_RATE_PER_IP_PER_HOUR, 5),
      verifyResendCooldownSeconds: num(process.env.VERIFY_RESEND_COOLDOWN_SECONDS, 60),
    },
    admin: {
      email: str(process.env.ADMIN_BOOTSTRAP_EMAIL, ""),
      password: str(process.env.ADMIN_BOOTSTRAP_PASSWORD, ""),
    },
  };
}

export function redactSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "…" + value.slice(-4);
}

export function configSummary(cfg: AppConfig): string {
  const lines = [
    `[config] db=${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`,
    `[config] maxmind key=${cfg.maxmind.licenseKey ? redactSecret(cfg.maxmind.licenseKey) : "(none)"}`,
    `[config] editions=${cfg.maxmind.editions.join(",")}`,
    `[config] api port=${cfg.api.port} rateLimit=${cfg.api.rateLimit}/min`,
    `[config] etl schedule="${cfg.etl.schedule}" tz=${cfg.etl.timezone} dataDir=${cfg.etl.dataDir}`,
    `[config] web baseUrl=${cfg.web.baseUrl} cookieSecure=${cfg.web.cookieSecure}`,
    `[config] smtp host=${cfg.smtp.host || "(console)"} from=${cfg.smtp.from}`,
    `[config] session secret=${cfg.web.sessionSecret ? redactSecret(cfg.web.sessionSecret) : "(unset)"}`,
    `[config] csrf secret=${cfg.web.csrfSecret ? redactSecret(cfg.web.csrfSecret) : "(unset)"}`,
  ];
  return lines.join("\n");
}
