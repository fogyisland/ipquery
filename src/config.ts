// SPDX-License-Identifier: MIT
import * as cronParser from 'node-cron';

export interface AppConfig {
  db: {
    host: string; port: number; user: string; password: string;
    database: string; poolSize: number;
  };
  maxmind: { licenseKey?: string; editions: string[] };
  api: { port: number; rateLimit: number };
  etl: { schedule: string; timezone: string; dataDir: string };
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected number, got ${v}`);
  return n;
}

function str(v: string | undefined, fallback: string): string {
  return v === undefined || v === '' ? fallback : v;
}

export function loadConfig(): AppConfig {
  const schedule = str(process.env.ETL_SCHEDULE, '0 2 * * *');
  if (!cronParser.validate(schedule)) {
    throw new Error(`ETL_SCHEDULE is not a valid cron expression: ${schedule}`);
  }

  return {
    db: {
      host: str(process.env.DB_HOST, 'localhost'),
      port: num(process.env.DB_PORT, 3306),
      user: str(process.env.DB_USER, 'root'),
      password: str(process.env.DB_PASSWORD, 'rootpass'),
      database: str(process.env.DB_NAME, 'ipquery'),
      poolSize: num(process.env.DB_POOL_SIZE, 10),
    },
    maxmind: {
      licenseKey: process.env.MAXMIND_LICENSE_KEY || undefined,
      editions: str(process.env.MAXMIND_EDITIONS, 'GeoLite2-City,GeoLite2-ASN')
        .split(',').map((s) => s.trim()).filter(Boolean),
    },
    api: {
      port: num(process.env.PORT, 3000),
      rateLimit: num(process.env.RATE_LIMIT, 60),
    },
    etl: {
      schedule,
      timezone: str(process.env.ETL_TIMEZONE, 'UTC'),
      dataDir: str(process.env.DATA_DIR, './data'),
    },
  };
}

export function redactSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return value.slice(0, 4) + '…' + value.slice(-4);
}

export function configSummary(cfg: AppConfig): string {
  const lines = [
    `[config] db=${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`,
    `[config] maxmind key=${cfg.maxmind.licenseKey ? redactSecret(cfg.maxmind.licenseKey) : '(none)'}`,
    `[config] editions=${cfg.maxmind.editions.join(',')}`,
    `[config] api port=${cfg.api.port} rateLimit=${cfg.api.rateLimit}/min`,
    `[config] etl schedule="${cfg.etl.schedule}" tz=${cfg.etl.timezone} dataDir=${cfg.etl.dataDir}`,
  ];
  return lines.join('\n');
}