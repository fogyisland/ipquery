// SPDX-License-Identifier: MIT
//
// Admin-tunable configuration for the IP-geolocation providers that
// /admin/unknown-ips backfill fans out to. Lives in MySQL so the admin
// can toggle a provider on/off and rotate its key from the UI without
// a server restart.
//
// The provider CATALOG below is the source of truth for which providers
// the system CAN use. The DB holds the runtime toggle + key. To add a
// new provider:
//   1. Add a class in src/etl/providers/<name>.ts implementing
//      IpGeoProvider.
//   2. Add an entry to PROVIDER_CATALOG.
//   3. Add an INSERT to migration 016_ingest_providers.sql.
//   4. Wire buildProvidersFromConfig() to map the catalog entry to the
//      provider class with the configured api_key.

import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { IpGeoProvider } from '../etl/providers/types';
import { getSetting, setSetting } from './settings';
import { IpApiProvider } from '../etl/providers/ipApi';
import { IpinfoProvider } from '../etl/providers/ipinfo';
import { IplocateProvider } from '../etl/providers/iplocate';
import { FreeIpApiProvider } from '../etl/providers/freeipapi';
import { IpapiCoProvider } from '../etl/providers/ipapiCo';

export interface ProviderConfigRow {
  name: string;
  displayName: string;
  freeQuota: string;
  enabled: boolean;
  apiKey: string | null;
  rateLimitPerMin: number | null;
  lastUsedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorReason: string | null;
  autoReenableAt: Date | null;
  autoDisabledReason: string | null;
}

/** Static catalog. Mirrors the seeded rows in migration 016 — adding a
 *  new provider requires a row AND a catalog entry, never one alone.
 *  Exported (not just a module-private const) so peers like
 *  providerErrorLog can iterate the provider names without re-typing
 *  them. */
export const PROVIDER_CATALOG: Record<string, { displayName: string; freeQuota: string }> = {
  'ip-api':    { displayName: 'IP-API',       freeQuota: '45 req/min, no key (HTTP only)' },
  'iplocate':  { displayName: 'IPLocate.io',  freeQuota: '1,000 req/day, key required (HTTPS)' },
  'ipinfo':    { displayName: 'IPinfo.io',    freeQuota: '50,000 req/month, key required (HTTPS)' },
  'freeipapi': { displayName: 'FreeIPAPI',    freeQuota: '60 req/min, no key (HTTPS)' },
  'ipapi-co':  { displayName: 'ipapi.co',     freeQuota: '30,000 req/month, no key (HTTPS)' },
};

export const PROVIDER_CATALOG_LIST: ProviderConfigRow[] = Object.entries(PROVIDER_CATALOG)
  .map(([name, meta]) => ({
    name,
    displayName: meta.displayName,
    freeQuota: meta.freeQuota,
    enabled: true,
    apiKey: null,
    rateLimitPerMin: null,
    lastUsedAt: null,
    lastErrorAt: null,
    lastErrorReason: null,
    autoReenableAt: null,
    autoDisabledReason: null,
  }));

export async function listProviderConfigs(pool: Pool): Promise<ProviderConfigRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT name, display_name, free_quota, enabled, api_key,
            rate_limit_per_min, last_used_at, last_error_at, last_error_reason,
            auto_reenable_at, auto_disabled_reason
       FROM ingest_providers
       ORDER BY name`,
  );
  return rows.map(rowToConfig);
}

function rowToConfig(r: RowDataPacket): ProviderConfigRow {
  return {
    name: String(r.name),
    displayName: String(r.display_name),
    freeQuota: String(r.free_quota),
    enabled: Boolean(r.enabled),
    apiKey: r.api_key == null ? null : String(r.api_key),
    rateLimitPerMin: r.rate_limit_per_min == null ? null : Number(r.rate_limit_per_min),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
    lastErrorAt: r.last_error_at ? new Date(r.last_error_at) : null,
    lastErrorReason: r.last_error_reason == null ? null : String(r.last_error_reason),
    autoReenableAt: r.auto_reenable_at ? new Date(r.auto_reenable_at) : null,
    autoDisabledReason: r.auto_disabled_reason == null ? null : String(r.auto_disabled_reason),
  };
}

export async function getProviderConfig(pool: Pool, name: string): Promise<ProviderConfigRow | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT name, display_name, free_quota, enabled, api_key,
            rate_limit_per_min, last_used_at, last_error_at, last_error_reason,
            auto_reenable_at, auto_disabled_reason
       FROM ingest_providers WHERE name = ? LIMIT 1`,
    [name],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  if (!r) return null;
  return rowToConfig(r);
}

/** Persist admin changes. Whitelist of updatable fields: enabled, api_key,
 *  auto_reenable_at, auto_disabled_reason. Display name + free quota are
 *  code-managed (catalog). */
export interface ProviderConfigUpdate {
  enabled?: boolean;
  apiKey?: string | null;
  autoReenableAt?: Date | null;
  autoDisabledReason?: string | null;
}

export async function updateProviderConfig(
  pool: Pool,
  name: string,
  patch: ProviderConfigUpdate,
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  if (patch.apiKey !== undefined) {
    sets.push('api_key = ?');
    args.push(patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : null);
  }
  if (patch.autoReenableAt !== undefined) {
    sets.push('auto_reenable_at = ?');
    args.push(patch.autoReenableAt);
  }
  if (patch.autoDisabledReason !== undefined) {
    sets.push('auto_disabled_reason = ?');
    args.push(patch.autoDisabledReason && patch.autoDisabledReason.length > 0
      ? patch.autoDisabledReason.slice(0, 255)
      : null);
  }
  if (sets.length === 0) return;
  args.push(name);
  await pool.query(
    `UPDATE ingest_providers SET ${sets.join(', ')} WHERE name = ?`,
    args,
  );
}

export async function touchProviderSuccess(pool: Pool, name: string): Promise<void> {
  await pool.query(
    `UPDATE ingest_providers SET last_used_at = CURRENT_TIMESTAMP(3), last_error_reason = NULL
     WHERE name = ?`,
    [name],
  );
}

export async function touchProviderError(pool: Pool, name: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE ingest_providers SET last_error_at = CURRENT_TIMESTAMP(3), last_error_reason = ?
     WHERE name = ?`,
    [reason.slice(0, 255), name],
  );
}

/** Per-call outcome tag from the ingest flows (backfill / random-gen). */
export interface ProviderCallOutcome {
  rateLimited?: boolean;
  errorCode?: string;
}

/** Per-provider, per-UTC-day call counter. UPSERTs into provider_call_counter
 *  so calls within the same UTC day accumulate into one row. Called from
 *  processIp() in unknownIpBackfill AFTER every provider.lookup() —
 *  successful, rate-limited, errored, or thrown. Powers the "1h/24h/7d
 *  window stats" widget on the Providers tab and the "daily quota usage"
 *  pill.
 *
 *  All bucketing happens in JS — we bind only 0/1 increments so MySQL
 *  never has to coerce a string errorCode against numeric/equality
 *  literals in WHERE-style comparison contexts (which would error with
 *  "Truncated incorrect DOUBLE value: 'timeout'"). 9 placeholders
 *  total: 1 (name) + 4 (buckets for VALUES) + 4 (buckets for UPDATE). */
export async function touchProviderCalled(
  pool: Pool,
  name: string,
  outcome: ProviderCallOutcome,
): Promise<void> {
  const rateLimited = outcome.rateLimited === true;
  const errorCode = outcome.errorCode ?? null;
  const is429 = rateLimited ? 1 : 0;
  const isTimeout = errorCode === 'timeout' ? 1 : 0;
  const isNetwork = errorCode === 'network' ? 1 : 0;
  // "other" = had an errorCode but it wasn't 429/timeout/network — e.g.
  // 'http_500', 'no_country', 'unauthorized'.
  const isOther = !rateLimited && errorCode != null && errorCode !== 'timeout' && errorCode !== 'network' ? 1 : 0;
  await pool.query(
    `INSERT INTO provider_call_counter
       (provider_name, day_utc, calls_total, calls_429, calls_timeout,
        calls_network_err, calls_other_err, last_called_at)
     VALUES (?, UTC_DATE(), 1, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE
       calls_total        = calls_total + 1,
       calls_429          = calls_429 + ?,
       calls_timeout      = calls_timeout + ?,
       calls_network_err  = calls_network_err + ?,
       calls_other_err    = calls_other_err + ?,
       last_called_at     = NOW(3)`,
    [
      // INSERT VALUES (5 placeholders):
      name, is429, isTimeout, isNetwork, isOther,
      // ON DUPLICATE KEY UPDATE (4 placeholders, in order):
      is429, isTimeout, isNetwork, isOther,
    ],
  );
}

/** Build provider instances for the backfill job, reading enabled
 *  + api_key from the DB. Disabled providers are skipped entirely. */
export function buildProvidersFromConfig(configs: ProviderConfigRow[]): IpGeoProvider[] {
  const out: IpGeoProvider[] = [];
  for (const c of configs) {
    if (!c.enabled) continue;
    switch (c.name) {
      case 'ip-api':
        out.push(new IpApiProvider());
        break;
      case 'iplocate':
        // Provider abstains on its own if apiKey is null — but skipping
        // here avoids the per-call null check.
        if (c.apiKey) out.push(new IplocateProvider({ apiKey: c.apiKey }));
        break;
      case 'ipinfo':
        if (c.apiKey) out.push(new IpinfoProvider({ token: c.apiKey }));
        break;
      case 'freeipapi':
        out.push(new FreeIpApiProvider());
        break;
      case 'ipapi-co':
        out.push(new IpapiCoProvider());
        break;
      default:
        // Unknown name — log via warn, don't fail the whole job.
        // eslint-disable-next-line no-console
        console.warn?.(`[ingestProviders] unknown provider name: ${c.name}`);
    }
  }
  return out;
}

// ─── Last-backfill per-provider aggregate ─────────────────────────────────
//
// BackfillSummary.providers only lives in memory until the POST handler
// serializes it to the backfill_summary flash cookie (which is gone after
// one refresh). Persist the latest run's per-provider counts to settings
// so the unknown-ips dashboard can show "this provider failed N times in
// the last run" across sessions — without a DB migration.

const LAST_BACKFILL_KEY = 'last_backfill_provider_stats';

export interface LastBackfillProviderEntry {
  ok: number;
  failed: number;
  abstained: number;
  rateLimited: number;
}

export type LastBackfillProviderStats = Record<string, LastBackfillProviderEntry>;

interface LastBackfillEnvelope {
  runAt: string; // ISO timestamp
  providers: LastBackfillProviderStats;
}

export async function saveLastBackfillProviderStats(
  pool: Pool,
  providers: BackfillSummary['providers'],
  runAt: Date,
): Promise<void> {
  const env: LastBackfillEnvelope = {
    runAt: runAt.toISOString(),
    providers,
  };
  await setSetting(pool, LAST_BACKFILL_KEY, JSON.stringify(env));
}

export async function loadLastBackfillProviderStats(
  pool: Pool,
): Promise<{ runAt: Date | null; providers: LastBackfillProviderStats }> {
  const raw = await getSetting(pool, LAST_BACKFILL_KEY);
  if (!raw) return { runAt: null, providers: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<LastBackfillEnvelope>;
    if (!parsed || typeof parsed !== 'object' || !parsed.providers) {
      return { runAt: null, providers: {} };
    }
    return {
      runAt: parsed.runAt ? new Date(parsed.runAt) : null,
      providers: parsed.providers as LastBackfillProviderStats,
    };
  } catch {
    return { runAt: null, providers: {} };
  }
}

// Local type-only import — keeps BackfillSummary type usable here without
// a circular import (unknownIpBackfill imports from this module).
type BackfillSummary = {
  providers: Record<string, LastBackfillProviderEntry>;
};