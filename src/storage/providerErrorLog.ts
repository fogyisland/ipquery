// SPDX-License-Identifier: MIT
//
// provider_error_log: per-failure audit trail for the IP-geolocation
// providers. Read by the /admin/unknown-ips "Failure Logs" tab; written
// by the backfill + random-gen flows (and by the circuit breaker when
// it auto-disables a provider). See migration 017.

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { getSetting, setSetting } from './settings';

export interface ProviderErrorRow {
  id: number;
  providerName: string;
  ipText: string;
  mode: 'auto' | 'manual' | 'random';
  errorCode: string;
  reason: string;
  rawResponse: string | null;
  ts: Date;
  retryCount: number;
}

export interface ProviderErrorInsert {
  providerName: string;
  ipText: string;
  mode: 'auto' | 'manual' | 'random';
  errorCode: string;
  reason: string;
  rawResponse?: string | null;
  retryCount?: number;
}

export interface ProviderErrorFilter {
  providerName?: string;
  errorCode?: string;
  mode?: 'auto' | 'manual' | 'random';
  sinceMs?: number; // epoch ms — only rows with ts >= sinceMs
  limit?: number; // default 200, hard-capped at 500
}

function rowToError(r: RowDataPacket): ProviderErrorRow {
  return {
    id: Number(r.id),
    providerName: String(r.provider_name),
    ipText: String(r.ip_text),
    mode: String(r.mode) as ProviderErrorRow['mode'],
    errorCode: String(r.error_code),
    reason: String(r.reason),
    rawResponse: r.raw_response == null ? null : String(r.raw_response),
    ts: new Date(r.ts),
    retryCount: Number(r.retry_count),
  };
}

export async function recordProviderError(
  pool: Pool,
  row: ProviderErrorInsert,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_error_log
       (provider_name, ip_text, mode, error_code, reason, raw_response, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.providerName,
      row.ipText,
      row.mode,
      row.errorCode,
      row.reason.slice(0, 255),
      row.rawResponse ? row.rawResponse.slice(0, 512) : null,
      row.retryCount ?? 1,
    ],
  );
}

export async function queryProviderErrors(
  pool: Pool,
  filter: ProviderErrorFilter = {},
): Promise<ProviderErrorRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.providerName) {
    where.push('provider_name = ?');
    args.push(filter.providerName);
  }
  if (filter.errorCode) {
    where.push('error_code = ?');
    args.push(filter.errorCode);
  }
  if (filter.mode) {
    where.push('mode = ?');
    args.push(filter.mode);
  }
  if (filter.sinceMs) {
    where.push('ts >= FROM_UNIXTIME(? / 1000)');
    args.push(filter.sinceMs);
  }
  const limit = Math.min(filter.limit ?? 200, 500);
  const sql = `SELECT id, provider_name, ip_text, mode, error_code, reason,
                      raw_response, ts, retry_count
                 FROM provider_error_log
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY ts DESC, id DESC
                LIMIT ${limit}`;
  const [rows] = await pool.query<RowDataPacket[]>(sql, args);
  return rows.map(rowToError);
}

export async function distinctErrorCodes(pool: Pool): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT error_code FROM provider_error_log
       WHERE ts >= (NOW() - INTERVAL 30 DAY)
       ORDER BY error_code`,
  );
  return rows.map((r) => String(r.error_code));
}

// ─── Circuit breaker config ───────────────────────────────────────────

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThresholdPct: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

const DEFAULT_CB: CircuitBreakerConfig = {
  enabled: true,
  failureThresholdPct: 50,
  windowMinutes: 10,
  cooldownMinutes: 15,
};

export async function getCircuitBreakerConfig(pool: Pool): Promise<CircuitBreakerConfig> {
  const [enabledRaw, thresholdRaw, windowRaw, cooldownRaw] = await Promise.all([
    getSetting(pool, 'cb_enabled'),
    getSetting(pool, 'cb_failure_threshold'),
    getSetting(pool, 'cb_window_minutes'),
    getSetting(pool, 'cb_cooldown_minutes'),
  ]);
  return {
    enabled: enabledRaw === null ? DEFAULT_CB.enabled : enabledRaw === '1',
    failureThresholdPct: thresholdRaw === null
      ? DEFAULT_CB.failureThresholdPct
      : Math.min(100, Math.max(0, Number(thresholdRaw) || DEFAULT_CB.failureThresholdPct)),
    windowMinutes: windowRaw === null
      ? DEFAULT_CB.windowMinutes
      : Math.max(1, Number(windowRaw) || DEFAULT_CB.windowMinutes),
    cooldownMinutes: cooldownRaw === null
      ? DEFAULT_CB.cooldownMinutes
      : Math.max(1, Number(cooldownRaw) || DEFAULT_CB.cooldownMinutes),
  };
}

export interface CircuitBreakerUpdate {
  enabled?: boolean;
  failureThresholdPct?: number;
  windowMinutes?: number;
  cooldownMinutes?: number;
}

export async function setCircuitBreakerConfig(
  pool: Pool,
  patch: CircuitBreakerUpdate,
): Promise<void> {
  if (patch.enabled !== undefined) await setSetting(pool, 'cb_enabled', patch.enabled ? '1' : '0');
  if (patch.failureThresholdPct !== undefined) {
    const clamped = Math.min(100, Math.max(0, Math.round(patch.failureThresholdPct)));
    await setSetting(pool, 'cb_failure_threshold', String(clamped));
  }
  if (patch.windowMinutes !== undefined) {
    const clamped = Math.max(1, Math.round(patch.windowMinutes));
    await setSetting(pool, 'cb_window_minutes', String(clamped));
  }
  if (patch.cooldownMinutes !== undefined) {
    const clamped = Math.max(1, Math.round(patch.cooldownMinutes));
    await setSetting(pool, 'cb_cooldown_minutes', String(clamped));
  }
}