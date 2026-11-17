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
exports.reloadMigrationManifest = reloadMigrationManifest;
exports.loadMigrationManifestFrom = loadMigrationManifestFrom;
exports.listMigrationEntries = listMigrationEntries;
exports.getAppliedVersions = getAppliedVersions;
exports.runMigrations = runMigrations;
exports.buildSchemaReference = buildSchemaReference;
exports.getSchemaReport = getSchemaReport;
exports.getSchemaReportFrom = getSchemaReportFrom;
exports.migrationStatus = migrationStatus;
exports.listMigrationFiles = listMigrationFiles;
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
/**
 * The migration SQL that ships with this build, inlined at build time.
 *
 * The keys are the file names exactly as the runner matches them, so
 * `listMigrationEntries` can classify the SQL without touching the file
 * system: the question the console asks is "what does this build expect
 * the database to look like", and a runtime directory listing answers a
 * different one — "what happens to sit in the output folder". A release
 * bundle that shipped only `dist/` would otherwise find no SQL at all and
 * report every migration as pending.
 *
 * Read from the deployment at startup rather than compiled in, so a bundle
 * and the database it upgrades always agree on the same step list. The
 * files still travel with `dist/` — `scripts/copy-schema.js` copies them —
 * but the runner no longer depends on the source tree being present.
 *
 * A missing entry classifies as `data` / not lock-prone, which is the safe
 * direction: the console then never invents a lock warning it cannot
 * justify. The `MIGRATION_FILES` order below is the order steps apply in.
 */
const MIGRATION_SQL = new Map([
    ["001_ip_ranges.sql", "-- SPDX-License-Identifier: MIT\n\nCREATE TABLE IF NOT EXISTS ip_ranges (\n  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,\n  start_ip BINARY(16) NOT NULL,\n  end_ip   BINARY(16) NOT NULL,\n  country_code CHAR(2) NULL,\n  country_name VARCHAR(64) NULL,\n  region      VARCHAR(64) NULL,\n  city        VARCHAR(128) NULL,\n  postal_code VARCHAR(32) NULL,\n  latitude    DECIMAL(9,6) NULL,\n  longitude   DECIMAL(9,6) NULL,\n  timezone    VARCHAR(64) NULL,\n  isp         VARCHAR(128) NULL,\n  asn         INT UNSIGNED NULL,\n  asn_org     VARCHAR(128) NULL,\n  country_source VARCHAR(16) NULL,\n  city_source    VARCHAR(16) NULL,\n  isp_source     VARCHAR(16) NULL,\n  asn_source     VARCHAR(16) NULL,\n  geo_source     VARCHAR(16) NULL,\n  INDEX idx_start_end (start_ip, end_ip)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n\nCREATE TABLE IF NOT EXISTS ip_ranges_new LIKE ip_ranges;\n"],
    ["002_etl_runs.sql", "-- SPDX-License-Identifier: MIT\n\nCREATE TABLE IF NOT EXISTS etl_runs (\n  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,\n  started_at  DATETIME(3) NOT NULL,\n  finished_at DATETIME(3) NULL,\n  status ENUM('running','success','failed') NOT NULL,\n  maxmind_records INT UNSIGNED NULL,\n  ip2region_records INT UNSIGNED NULL,\n  dbip_records INT UNSIGNED NULL,\n  merged_records INT UNSIGNED NULL,\n  error_message TEXT NULL,\n  maxmind_built_at DATETIME NULL,\n  ip2region_built_at DATETIME NULL,\n  dbip_built_at DATETIME NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n"],
    ["003_users.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS users (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  password_hash VARCHAR(255) NOT NULL,\n  display_name VARCHAR(64) NOT NULL,\n  role ENUM('user','admin') NOT NULL DEFAULT 'user',\n  email_verified TINYINT(1) NOT NULL DEFAULT 0,\n  is_disabled TINYINT(1) NOT NULL DEFAULT 0,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  last_login_at DATETIME(3) NULL,\n  INDEX idx_role_created (role, created_at)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["004_api_keys.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS api_keys (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  user_id BIGINT UNSIGNED NOT NULL,\n  label VARCHAR(64) NOT NULL,\n  key_hash CHAR(64) NOT NULL UNIQUE,\n  key_prefix CHAR(8) NOT NULL,\n  last_used_at DATETIME(3) NULL,\n  revoked_at DATETIME(3) NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_user (user_id),\n  INDEX idx_active (user_id, revoked_at)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["005_sessions.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS sessions (\n  id CHAR(32) NOT NULL PRIMARY KEY,\n  user_id BIGINT UNSIGNED NOT NULL,\n  expires_at DATETIME(3) NOT NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_user (user_id),\n  INDEX idx_expires (expires_at)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["006_email_verifications.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS email_verifications (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  user_id BIGINT UNSIGNED NOT NULL,\n  token_hash CHAR(64) NOT NULL UNIQUE,\n  expires_at DATETIME(3) NOT NULL,\n  consumed_at DATETIME(3) NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_user (user_id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["007_password_resets.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS password_resets (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  user_id BIGINT UNSIGNED NOT NULL,\n  token_hash CHAR(64) NOT NULL UNIQUE,\n  expires_at DATETIME(3) NOT NULL,\n  consumed_at DATETIME(3) NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_user (user_id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["008_query_log.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS query_log (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  ip VARBINARY(16) NOT NULL,\n  ip_text VARCHAR(45) NOT NULL,\n  status ENUM('hit','miss','invalid') NOT NULL,\n  user_id BIGINT UNSIGNED NULL,\n  api_key_id BIGINT UNSIGNED NULL,\n  session_id CHAR(32) NULL,\n  remote_addr VARBINARY(16) NULL,\n  user_agent VARCHAR(255) NULL,\n  INDEX idx_user_ts (user_id, ts),\n  INDEX idx_ts (ts),\n  INDEX idx_ip (ip)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["010_admin_audit_log.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE IF NOT EXISTS admin_audit_log (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  actor_user_id BIGINT UNSIGNED NOT NULL,\n  actor_email VARCHAR(255) NOT NULL,\n  action VARCHAR(64) NOT NULL,\n  target_type VARCHAR(32) NULL,\n  target_id BIGINT UNSIGNED NULL,\n  metadata JSON NULL,\n  ip VARCHAR(45) NULL,\n  user_agent VARCHAR(255) NULL,\n  status_code SMALLINT UNSIGNED NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_actor_created (actor_user_id, created_at),\n  INDEX idx_target (target_type, target_id),\n  INDEX idx_action_created (action, created_at)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["011_settings.sql", "-- SPDX-License-Identifier: MIT\nCREATE TABLE settings (\n  k VARCHAR(64) PRIMARY KEY,\n  v TEXT NOT NULL,\n  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["012_seed_ip_ranges.sql", "-- SPDX-License-Identifier: MIT\n\n-- Adds the UNIQUE index used by the optional demo-data loader.\n--\n-- This migration used to insert 50 hand-picked rows (Google DNS,\n-- Cloudflare, RFC 1918, …) so that /lookup would answer something\n-- before the first ETL run. That was wrong for a production\n-- deployment: a fresh database ended up with 50 demo rows that LOOK\n-- like real coverage. An operator who skipped the seed step still got\n-- them, because the seed was part of `migrate`, not part of an\n-- explicit choice. A /lookup hit on 8.8.8.8 said \"Mountain View\" while\n-- every other address came back \"not found\" — a database that reads\n-- as populated but is not.\n--\n-- The demo rows are now opt-in:\n--   - production: nothing. Run `node dist/cli.js update` to load the\n--     real DB-IP library.\n--   - development: `node dist/cli.js seed:demo` loads them explicitly.\n--\n-- The 50 rows themselves live in src/storage/seed/demo-ranges.sql and\n-- are applied by that command, not by the migration runner. Migration\n-- 025 removes the rows that earlier versions of this migration\n-- inserted, so an upgraded database ends up in the same state as a\n-- fresh one.\n--\n-- The index stays. The demo loader inserts with INSERT IGNORE and\n-- needs row-level idempotency so re-running it is harmless. It is\n-- UNIQUE on (start_ip, end_ip, country_source) rather than on\n-- (start_ip, end_ip) because ETL rows use other source values such as\n-- 'dbip' — so the index does not constrain them, and migration 013's\n-- separate uniq_start_end key remains the one the ETL's upsert path\n-- relies on.\n\nALTER TABLE ip_ranges ADD UNIQUE INDEX uniq_seed (start_ip, end_ip, country_source);\n"],
    ["013_ip_ranges_unique_key.sql", "-- SPDX-License-Identifier: MIT\n-- Adds a UNIQUE KEY on (start_ip, end_ip) so the streaming upsert path in\n-- the ETL can dedupe rows from multiple DB-IP files (city / country / asn)\n-- via INSERT ... ON DUPLICATE KEY UPDATE without ever materialising the\n-- full row set in JS memory.\n--\n-- Assumption: both tables already have unique (start_ip, end_ip) rows. The\n-- ETL TRUNCATEs ip_ranges_new every run and the in-memory merger output\n-- (used before streaming was added) was already unique by construction.\n--\n-- The ALTER bumps tmp_table_size for this session because building a 7M+\n-- row unique index via COPY otherwise spills past the default 16 MB tmp\n-- table and OOMs mysqld.\n\nSET SESSION tmp_table_size = 1024 * 1024 * 256;\nSET SESSION max_heap_table_size = 1024 * 1024 * 256;\n\nALTER TABLE ip_ranges\n  ADD UNIQUE KEY uniq_start_end (start_ip, end_ip),\n  ALGORITHM=COPY, LOCK=SHARED;\n\nALTER TABLE ip_ranges_new\n  ADD UNIQUE KEY uniq_start_end (start_ip, end_ip),\n  ALGORITHM=COPY, LOCK=SHARED;"],
    ["014_ip_ranges_range_size.sql", "-- SPDX-License-Identifier: MIT\n-- Adds a `range_size` BIGINT UNSIGNED column so the lookup query can\n-- ORDER BY a real numeric expression. The legacy ORDER BY (end_ip -\n-- start_ip) returns 0 for every BINARY(16) row because MySQL's binary\n-- arithmetic on BINARY produces a BINARY result that compares equal to\n-- every other zero-padded BINARY — effectively a no-op sort. The bug was\n-- hidden when the only data came from a single source with uniformly\n-- small ranges; mixing city / country / asn slices introduced larger\n-- ranges that intermittently surfaced above the smaller correct match.\n\nSET SESSION tmp_table_size = 1024 * 1024 * 256;\nSET SESSION max_heap_table_size = 1024 * 1024 * 256;\n\nALTER TABLE ip_ranges\n  ADD COLUMN range_size BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  ADD INDEX idx_range_size (range_size),\n  ALGORITHM=COPY, LOCK=SHARED;\n\nALTER TABLE ip_ranges_new\n  ADD COLUMN range_size BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  ADD INDEX idx_range_size (range_size),\n  ALGORITHM=COPY, LOCK=SHARED;"],
    ["015_unknown_ip_queue.sql", "-- SPDX-License-Identifier: MIT\n-- unknown_ip_queue: tracks IPs that /lookup couldn't resolve so we can\n-- backfill them from external providers instead of dropping the signal.\n--\n-- processed_at NULL + merged_run_id NULL = pending backfill.\n-- The \"covered by ip_ranges\" check lives in nextBatch() (NOT EXISTS), not\n-- here, so an IP can stay queued across multiple ETL windows even if a\n-- range happens to disappear; the backfill job is the only place that\n-- transitions rows out of \"pending\".\n\nCREATE TABLE IF NOT EXISTS unknown_ip_queue (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  ip VARBINARY(16) NOT NULL,\n  ip_text VARCHAR(45) NOT NULL,\n  query_count INT UNSIGNED NOT NULL DEFAULT 1,\n  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  submitted_by_user_id BIGINT UNSIGNED NULL,\n  source ENUM('auto_miss','manual_submit') NOT NULL DEFAULT 'auto_miss',\n  -- Backfill outcome\n  processed_at DATETIME(3) NULL,\n  merged_run_id BIGINT UNSIGNED NULL,\n  -- Why we couldn't merge, if we couldn't (e.g. \"no_consensus\").\n  -- NULL means \"we haven't tried yet\" OR \"we successfully merged\".\n  last_attempt_reason TEXT NULL,\n  UNIQUE KEY uk_ip (ip),\n  INDEX idx_pending_priority (query_count, last_seen_at),\n  INDEX idx_processed_at (processed_at)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"],
    ["016_ingest_providers.sql", "-- SPDX-License-Identifier: MIT\n-- ingest_providers: admin-tunable configuration for the IP-geolocation\n-- providers that the /admin/unknown-ips backfill fan-out consults.\n--\n-- Why a table (vs. env-only or a code list):\n--  - Lets the admin toggle a provider on/off and rotate its API key from\n--    the admin UI without a server restart.\n--  - Lets us surface per-provider quota + last-used info to the admin so\n--    they can see \"ipinfo has been throttled 12× today\".\n--  - Keeps a stable row per provider so analytics queries (e.g. \"which\n--    provider has the best hit rate\") don't have to JOIN a code list.\n--\n-- `name` is the stable identifier and primary key — adding a new\n-- provider requires a code change AND a row insert, never just one.\n\nCREATE TABLE IF NOT EXISTS ingest_providers (\n  name VARCHAR(32) PRIMARY KEY,\n  -- Display label + free-tier blurb shown on /admin/unknown-ips. Not\n  -- editable from the UI today; lives in code (see CATALOG in\n  -- src/storage/ingestProviders.ts) and seeded by INSERT below.\n  display_name VARCHAR(64) NOT NULL,\n  free_quota VARCHAR(128) NOT NULL,\n  -- Whether the backfill job should consult this provider. Disabling\n  -- skips the call entirely — useful when the admin knows the key is\n  -- expired or quota is exhausted.\n  enabled TINYINT(1) NOT NULL DEFAULT 1,\n  -- Optional bearer / api-key. NULL for key-less providers. Stored in\n  -- plaintext for now because the app's threat model treats DB access as\n  -- already-trusted (admin can see all keys anyway). If we ever expose\n  -- this to non-admin roles, switch to AES-GCM with a KMS-wrapped key.\n  api_key VARCHAR(255) NULL,\n  -- Soft override for the per-provider rate limiter. NULL = use the\n  -- provider class's default (45/min for ip-api, etc.).\n  rate_limit_per_min INT UNSIGNED NULL,\n  -- Bookkeeping for the admin dashboard. NOT used to gate requests.\n  last_used_at DATETIME(3) NULL,\n  last_error_at DATETIME(3) NULL,\n  last_error_reason VARCHAR(255) NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n-- Seed the five providers we know about today. If the catalog grows,\n-- add a new INSERT in the migration that follows this one. The admin\n-- UI only flips enabled / api_key from here on.\nINSERT IGNORE INTO ingest_providers (name, display_name, free_quota) VALUES\n  ('ip-api',     'IP-API',         '45 req/min, no key (HTTP only)'),\n  ('iplocate',   'IPLocate.io',    '1,000 req/day, key required (HTTPS)'),\n  ('ipinfo',     'IPinfo.io',      '50,000 req/month, key required (HTTPS)'),\n  ('freeipapi',  'FreeIPAPI',      '60 req/min, no key (HTTPS)'),\n  ('ipapi-co',   'ipapi.co',       '30,000 req/month, no key (HTTPS)');"],
    ["017_provider_error_log.sql", "-- SPDX-License-Identifier: MIT\n-- provider_error_log: per-failure audit trail for the IP-geolocation\n-- providers. One row per failed lookup attempt during backfill or random\n-- generation. The admin UI's \"Failure Logs\" tab reads from this table\n-- with optional filters (provider, error code, time range).\n--\n-- Why a separate log and not just the ingest_providers row counters:\n--   - Per-IP context: which IP triggered the failure (operators want to\n--     replay or skip specific IPs).\n--   - Distinguishes \"transient 429\" from \"permanent 401 unauthorized\"\n--     so the circuit breaker can decide whether to disable the provider.\n--   - Keeps the hot ingest_providers table small (latest-only state).\n--\n-- Volume expectation: bounded by backfill batch size * providers per day.\n-- 100 IPs * 3 providers * 24 runs/day = ~7k rows/day worst case. We\n-- rotate rows older than 30 days via a daily cleanup (run separately,\n-- not part of this migration). Indexes target the admin's filter UI.\n\nCREATE TABLE IF NOT EXISTS provider_error_log (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  provider_name VARCHAR(32) NOT NULL,\n  ip_text VARCHAR(45) NOT NULL,\n  -- 'auto' = unknown_ip_queue backfill, 'manual' = POST /generate,\n  -- 'random' = random-gen runner. Operators use this to tell\n  -- whether an error came from background work or a one-shot.\n  mode ENUM('auto','manual','random') NOT NULL,\n  -- HTTP status (e.g. 429, 401, 504) or 'timeout' or 'network'.\n  -- VARCHAR(16) so non-numeric reasons fit without enum churn.\n  error_code VARCHAR(16) NOT NULL,\n  -- Short reason from the provider (e.g. \"rate limited (3x)\").\n  reason VARCHAR(255) NOT NULL,\n  -- Truncated raw response body. NULL when not captured (timeout). Useful\n  -- for debugging provider-specific responses without re-running.\n  raw_response VARCHAR(512) NULL,\n  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  -- Retry counter inside the same IP run (1..3). 1 = first attempt.\n  -- > 1 means the failure was retried with the same provider.\n  retry_count TINYINT UNSIGNED NOT NULL DEFAULT 1,\n  -- What the backfill decided to do with this error:\n  --   'logged'       — recorded only, no special action\n  --   'abstained'    — provider skipped this IP (no record)\n  --   'auto_disabled'— provider toggled off due to 429 (circuit breaker)\n  INDEX idx_provider_ts (provider_name, ts),\n  INDEX idx_ts (ts),\n  INDEX idx_error_code (error_code, ts)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n-- Circuit-breaker settings. The breaker consults:\n--   - cb_enabled: master switch (1 = enforce, 0 = bypass)\n--   - cb_failure_threshold: failure rate percentage (0-100) over the\n--     sliding window below. If exceeded → auto-disable provider.\n--   - cb_window_minutes: sliding-window length for the failure rate.\n--   - cb_cooldown_minutes: how long the provider stays disabled before\n--     the next attempt re-enables it.\n-- All keys are read by `getCircuitBreakerConfig()` and written by the\n-- admin POST handler. Defaults match the user's \"auto-disable on 429\"\n-- behavior already shipped via disableRateLimitedProviders().\nINSERT INTO settings (k, v) VALUES\n  ('cb_enabled', '1'),\n  ('cb_failure_threshold', '50'),\n  ('cb_window_minutes', '10'),\n  ('cb_cooldown_minutes', '15')\nON DUPLICATE KEY UPDATE k = k;"],
    ["018_random_probe_log.sql", "-- SPDX-License-Identifier: MIT\n-- random_probe_log: per-IP audit trail for the API ingest flows. One row\n-- per (ip, runMode) — captures both successful consensus AND every other\n-- outcome (no_consensus, no_country, all_abstained). The admin UI's\n-- \"Recent Probes\" table on the Overview tab reads from here so operators\n-- can answer \"what did the last tick actually do, per IP, per provider?\"\n--\n-- Why a separate log instead of extending provider_error_log:\n--   - provider_error_log is failure-only — recording successful\n--     consensus there would dilute the failure audit trail.\n--   - random_probe_log captures the FULL provider response for each IP\n--     (countryCode/city/asn/durationMs/rawResponse/errorCode/rateLimited)\n--     in one row's providers_json blob. That makes the row self-contained:\n--     a single SELECT gives you everything you need to debug why a\n--     consensus vote succeeded or failed.\n--   - mode column disambiguates the trigger source (auto=queue backfill,\n--     manual=POST /generate button, random=continuous runner).\n--\n-- Volume expectation:\n--   - mode=random: ~10 IPs/min * 60 * 24 = ~14k rows/day (worst case)\n--   - mode=manual: bursty from admin button; usually 10-20 rows per click\n--   - mode=auto: bounded by queue depth; usually <500/day\n--   Total ~20k rows/day worst case. No rotation in v1 — add a daily\n--   cleanup later if volume becomes a concern.\n\nCREATE TABLE IF NOT EXISTS random_probe_log (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  ip_text VARCHAR(45) NOT NULL,\n  ip_binary VARBINARY(16) NOT NULL,\n  -- Trigger source. Mirrors provider_error_log.mode convention.\n  mode ENUM('auto','manual','random') NOT NULL,\n  -- Consensus outcome kind. Same enum as IpOutcome.kind:\n  --   'merged'         → /32 (or /128) inserted into ip_ranges\n  --   'no_consensus'   → providers disagreed on country\n  --   'no_country'     → at least one provider agreed but no country code\n  --   'all_abstained'  → every provider skipped (key missing, etc.)\n  outcome ENUM('merged','no_consensus','no_country','all_abstained') NOT NULL,\n  -- Consensus fields (NULL when outcome != 'merged').\n  consensus_country VARCHAR(8) NULL,\n  consensus_city VARCHAR(64) NULL,\n  consensus_asn INT UNSIGNED NULL,\n  -- ip_ranges.id when outcome='merged'. NULL otherwise.\n  merged_run_id BIGINT UNSIGNED NULL,\n  -- JSON array of PerProviderDetail objects. Each object has:\n  --   { provider, countryCode, city, asn, rateLimited, errorCode,\n  --     durationMs, rawResponse }\n  -- The per-provider responses are the most useful debugging data\n  -- (\"why did this IP merge as US when ipapi.co said CN?\").\n  providers_json TEXT NOT NULL,\n  -- UUID grouping probes from the same run/tick. Lets the UI show\n  -- \"10 IPs processed at 2026-08-29 12:34:56 UTC\" as a group.\n  batch_id CHAR(36) NULL,\n  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_ts (ts),\n  INDEX idx_outcome_ts (outcome, ts),\n  INDEX idx_batch (batch_id),\n  INDEX idx_ip_binary (ip_binary)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n-- Continuous random-IP ingest scheduler settings. Read by\n-- registerRandomGenRunner (interval/batch), and by the new\n-- /admin/unknown-ips/scheduler POST handler. Defaults match the values\n-- previously hardcoded in the runner (intervalMs=60_000, count=10).\nINSERT INTO settings (k, v) VALUES\n  ('random_gen_interval_sec', '60'),\n  ('random_gen_batch_size', '10'),\n  ('random_gen_cooldown_minutes', '15'),\n  ('random_gen_cb_linkage', '1')\nON DUPLICATE KEY UPDATE k = k;"],
    ["019_etl_run_stages.sql", "-- SPDX-License-Identifier: MIT\n--\n-- etl_run_stages side tables — per-file/per-stage breakdown for each\n-- etl_runs row. Why split into four tables instead of packing everything\n-- into etl_runs:\n--   1. The legacy etl_runs row is one summary line per run. Operators need\n--      per-file/per-stage detail (which file failed, how many rows were\n--      skipped because of bad IPs vs missing columns, etc.) to triage\n--      without grepping server logs.\n--   2. Stage cardinality is variable: download has 3 attempts (city/country/asn),\n--      parse has N files that were present, insert has N files, swap has 1.\n--      A row-per-stage layout maps cleanly to FK cascades.\n--   3. Each stage has a distinct shape (download carries bytes/URL/month,\n--      parse carries skip counters, insert carries upsert counts, swap\n--      carries a status). Splitting them keeps the columns narrow and\n--      the INSERTs small.\n--\n-- All four tables FK to etl_runs(id) ON DELETE CASCADE so removing a\n-- test run wipes its stage detail. Indexes target the admin run-detail\n-- page's \"list every stage row for this run_id\" query.\n\nCREATE TABLE IF NOT EXISTS etl_run_downloads (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  run_id BIGINT UNSIGNED NOT NULL,\n  source ENUM('dbip-city','dbip-country','dbip-asn') NOT NULL,\n  dest_name VARCHAR(64) NOT NULL,\n  source_url VARCHAR(255) NULL,\n  month CHAR(7) NULL,\n  status ENUM('success','failed','missing','skipped') NOT NULL,\n  bytes BIGINT UNSIGNED NULL,\n  duration_ms INT UNSIGNED NULL,\n  retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,\n  error_message VARCHAR(512) NULL,\n  started_at DATETIME(3) NOT NULL,\n  finished_at DATETIME(3) NULL,\n  INDEX idx_run (run_id),\n  CONSTRAINT fk_etl_dl_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\nCREATE TABLE IF NOT EXISTS etl_run_parses (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  run_id BIGINT UNSIGNED NOT NULL,\n  source ENUM('dbip-city','dbip-country','dbip-asn') NOT NULL,\n  dest_name VARCHAR(64) NOT NULL,\n  rows_emitted BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_skipped_short BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_skipped_header BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_skipped_unparseable_ip BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_skipped_missing_col BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_skipped_nan_asn BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_skipped_other BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  gunzip_errors INT UNSIGNED NOT NULL DEFAULT 0,\n  started_at DATETIME(3) NOT NULL,\n  finished_at DATETIME(3) NULL,\n  duration_ms INT UNSIGNED NULL,\n  INDEX idx_run (run_id),\n  CONSTRAINT fk_etl_ps_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\nCREATE TABLE IF NOT EXISTS etl_run_inserts (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  run_id BIGINT UNSIGNED NOT NULL,\n  source ENUM('dbip-city','dbip-country','dbip-asn') NOT NULL,\n  dest_name VARCHAR(64) NOT NULL,\n  rows_attempted BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_inserted BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  rows_duplicates BIGINT UNSIGNED NOT NULL DEFAULT 0,\n  batch_count INT UNSIGNED NOT NULL DEFAULT 0,\n  duration_ms INT UNSIGNED NULL,\n  started_at DATETIME(3) NOT NULL,\n  finished_at DATETIME(3) NULL,\n  INDEX idx_run (run_id),\n  CONSTRAINT fk_etl_in_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\nCREATE TABLE IF NOT EXISTS etl_run_swaps (\n  run_id BIGINT UNSIGNED PRIMARY KEY,\n  status ENUM('success','failed') NOT NULL,\n  duration_ms INT UNSIGNED NULL,\n  error_message VARCHAR(512) NULL,\n  started_at DATETIME(3) NOT NULL,\n  finished_at DATETIME(3) NULL,\n  CONSTRAINT fk_etl_sw_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"],
    ["020_provider_call_counter.sql", "-- SPDX-License-Identifier: MIT\n-- provider_call_counter: per-provider, per-UTC-day call counter. Powers\n-- the new \"1h/24h/7d window stats\" on the Providers tab and the \"daily\n-- quota usage\" pill. UPSERTed from touchProviderCalled in the\n-- backfill / random-gen flows. PK (provider_name, day_utc) so a single\n-- row accumulates all calls per UTC day. Volume: ~30k rows/day worst\n-- case (batch=100 × 60s interval × 5 providers). Index on day_utc for\n-- the admin UI's windowed aggregates.\nCREATE TABLE IF NOT EXISTS provider_call_counter (\n  provider_name VARCHAR(32) NOT NULL,\n  day_utc DATE NOT NULL,\n  calls_total INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_429 INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_timeout INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_network_err INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_other_err INT UNSIGNED NOT NULL DEFAULT 0,\n  last_called_at DATETIME(3) NULL,\n  PRIMARY KEY (provider_name, day_utc),\n  INDEX idx_day (day_utc)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\n-- Auto-re-enable timestamp for the circuit breaker. When\n-- disableRateLimitedProviders() flips a provider to enabled=0 it ALSO\n-- sets auto_reenable_at = NOW() + cb_cooldown_minutes. The new\n-- reapProviders() helper in randomIpGeneratorRunner.ts flips it back\n-- to enabled=1 once auto_reenable_at <= NOW(). This finally makes\n-- cb_cooldown_minutes (previously dead code) a real runtime setting.\n--\n-- Both columns are added by ONE ALTER TABLE. Every ALTER TABLE is an\n-- implicit commit on the server and the metadata write is durable,\n-- which costs about a second per statement on a slow disk. Two\n-- statements meant two seconds; one statement means one.\n--\n-- The ALTER is idempotent via INFORMATION_SCHEMA: if a prior partial run\n-- left these columns in place but the INSERT into schema_migrations rolled\n-- back, re-running adds exactly the columns that are still missing and\n-- no-ops on the rest. (MySQL 5.7 does not support `ADD COLUMN IF NOT\n-- EXISTS`, only 8.0.29+ does, so the column list is assembled as text\n-- and run through a prepared statement.)\nSET @parts := CONCAT_WS(', ',\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'ingest_providers'\n         AND COLUMN_NAME  = 'auto_reenable_at'),\n     NULL,\n     'ADD COLUMN auto_reenable_at DATETIME(3) NULL AFTER last_error_reason'),\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'ingest_providers'\n         AND COLUMN_NAME  = 'auto_disabled_reason'),\n     NULL,\n     'ADD COLUMN auto_disabled_reason VARCHAR(255) NULL AFTER auto_reenable_at')\n);\nSET @sql := IF(@parts = '', 'SELECT 1', CONCAT('ALTER TABLE ingest_providers ', @parts));\nPREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;\n"],
    ["021_custom_providers.sql", "-- SPDX-License-Identifier: MIT\n-- Custom HTTP providers: lets admins register an arbitrary IP-info\n-- endpoint at runtime via /admin/unknown-ips without touching TS code.\n-- Shape: URL template with {ip}/{apiKey} placeholders + dot-path field\n-- mapping. is_custom=1 dispatches to GenericHttpProvider; is_custom=0\n-- keeps using the hard-coded Provider classes (existing 5).\nALTER TABLE ingest_providers\n  ADD COLUMN is_custom TINYINT(1) NOT NULL DEFAULT 0 AFTER display_name,\n  ADD COLUMN custom_url_template VARCHAR(512) NULL AFTER is_custom,\n  ADD COLUMN custom_method ENUM('GET','POST') NOT NULL DEFAULT 'GET' AFTER custom_url_template,\n  ADD COLUMN custom_request_body TEXT NULL AFTER custom_method,\n  ADD COLUMN custom_response_format ENUM('json','text') NOT NULL DEFAULT 'json' AFTER custom_request_body,\n  ADD COLUMN custom_country_path VARCHAR(128) NULL AFTER custom_response_format,\n  ADD COLUMN custom_city_path VARCHAR(128) NULL AFTER custom_country_path,\n  ADD COLUMN custom_asn_path VARCHAR(128) NULL AFTER custom_city_path,\n  ADD COLUMN custom_timeout_ms INT UNSIGNED NULL AFTER custom_asn_path,\n  ADD COLUMN custom_rate_limit_per_min INT UNSIGNED NULL AFTER custom_timeout_ms,\n  ADD INDEX idx_custom (is_custom);\n"],
    ["022_etl_run_progress.sql", "-- SPDX-License-Identifier: MIT\n--\n-- Live ETL progress: per-run counters that the pipeline updates while\n-- the run is in flight, so the admin UI can render progress bars and\n-- percentages without polling per-file stage rows.\n--\n-- download_bytes_done / total  : current and final byte counts of all\n--   in-flight downloads (Content-Length-known at HEAD time, sum of\n--   completed file sizes once each file lands).\n-- insert_rows_done            : rows successfully INSERTed (or\n--   ON DUPLICATE updated) across all sources so far. We only UPDATE\n--   the column once the run finishes — see pipeline.ts notes on why\n--   in-flight reporting uses batchCount instead. Stored here as the\n--   cumulative count for the run-detail page.\n--\n-- All six columns live on etl_runs and are added by ONE ALTER TABLE.\n--\n-- Why one statement instead of six: every ALTER TABLE is an implicit\n-- commit on the server, and the metadata write is durable — on a\n-- machine with a slow disk that costs about a second per statement.\n-- Six separate ALTERs made a fresh database spend ~9.5s here, which is\n-- most of why the E2E setup hook used to time out. Adding the columns\n-- in a single ALTER cuts that to ~1.5s.\n--\n-- Why not \"ADD COLUMN IF NOT EXISTS\": that syntax only exists in\n-- MySQL 8.0.29+. This project targets MySQL 5.7, so the columns are\n-- added through a prepared statement whose text is assembled from\n-- INFORMATION_SCHEMA. That keeps the migration idempotent — if a\n-- partial run left some columns in place but the INSERT into\n-- schema_migrations rolled back, re-running adds exactly the columns\n-- that are still missing and no-ops on the rest.\nSET @parts := CONCAT_WS(', ',\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'etl_runs'\n         AND COLUMN_NAME  = 'download_bytes_done'),\n     NULL,\n     'ADD COLUMN download_bytes_done BIGINT UNSIGNED NULL AFTER ip2region_built_at'),\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'etl_runs'\n         AND COLUMN_NAME  = 'download_bytes_total'),\n     NULL,\n     'ADD COLUMN download_bytes_total BIGINT UNSIGNED NULL AFTER download_bytes_done'),\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'etl_runs'\n         AND COLUMN_NAME  = 'insert_rows_done'),\n     NULL,\n     'ADD COLUMN insert_rows_done BIGINT UNSIGNED NULL AFTER download_bytes_total'),\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'etl_runs'\n         AND COLUMN_NAME  = 'insert_rows_total'),\n     NULL,\n     'ADD COLUMN insert_rows_total BIGINT UNSIGNED NULL AFTER insert_rows_done'),\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'etl_runs'\n         AND COLUMN_NAME  = 'current_stage'),\n     NULL,\n     \"ADD COLUMN current_stage ENUM('download','parse','insert','swap','done') NULL AFTER insert_rows_total\"),\n  IF(EXISTS(\n      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n       WHERE TABLE_SCHEMA = DATABASE()\n         AND TABLE_NAME   = 'etl_runs'\n         AND COLUMN_NAME  = 'progress_updated_at'),\n     NULL,\n     'ADD COLUMN progress_updated_at DATETIME(3) NULL AFTER current_stage')\n);\nSET @sql := IF(@parts = '', 'SELECT 1', CONCAT('ALTER TABLE etl_runs ', @parts));\nPREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;\n"],
    ["023_fix_seed_ip_encoding.sql", "-- SPDX-License-Identifier: MIT\n--\n-- Repairs the seeded rows written by migration 012.\n--\n-- migration 012 stored each seeded IPv4 address as UNHEX('08080808') —\n-- four bytes, left-aligned inside the BINARY(16) column. Every runtime\n-- path (parseIp() in src/ip.ts, the DB-IP and MaxMind parsers, and\n-- findRange()'s query parameter) stores an IPv4 address as sixteen\n-- bytes with the address in the LAST four positions.\n--\n-- MySQL compares the zero-padded values, so the left-aligned form\n-- sorted BELOW the right-aligned form and no query could ever match\n-- it. Every seeded IP was unreachable through /lookup: 8.8.8.8 was in\n-- the seed data and still returned \"not found\".\n--\n-- migration 012 itself has been corrected for fresh installs. This\n-- migration fixes databases that already ran it. On a fresh install\n-- migration 012 inserted the correct bytes, so the UPDATE below finds\n-- nothing to change and the migration is a no-op.\n--\n-- The rewrite is targeted at rows whose country_source is 'seed' AND\n-- whose bytes sit in the first four positions with twelve zero bytes\n-- behind them — exactly the buggy left-aligned encoding. ETL and\n-- backfill rows are written by parseIp() and are never in that form,\n-- and they are excluded by the country_source filter regardless.\n--\n-- The seed rows' range_size is left alone. findRange() now ranks a\n-- real ETL row above a seed row explicitly (see the country_source\n-- check in src/storage/mysql.ts), because range_size alone cannot\n-- express the priority: a seed row is a single address (range_size 0)\n-- and would otherwise beat every real range covering it.\n--\n-- A sentinel range_size was tried and rejected — 2^64-1 is the widest\n-- value a BIGINT UNSIGNED holds, and mysql2 returns BIGINTs as\n-- JavaScript numbers, so it comes back as 1.8446744073709552e19 and\n-- BigInt() of that is 2^64 rather than 2^64-1. Ranking by source\n-- avoids depending on a value that cannot survive the round trip.\n\nSET SESSION tmp_table_size = 1024 * 1024 * 256;\nSET SESSION max_heap_table_size = 1024 * 1024 * 256;\n\nUPDATE ip_ranges\n   SET start_ip = CONCAT(REPEAT(UNHEX('00'), 12), SUBSTRING(start_ip, 1, 4)),\n       end_ip   = CONCAT(REPEAT(UNHEX('00'), 12), SUBSTRING(end_ip,   1, 4))\n WHERE country_source = 'seed'\n   AND start_ip = CONCAT(SUBSTRING(start_ip, 1, 4), REPEAT(UNHEX('00'), 12));\n"],
    ["024_provider_call_counter_minute.sql", "-- SPDX-License-Identifier: MIT\n--\n-- Per-minute provider call counters.\n--\n-- provider_call_counter (migration 020) buckets calls by UTC DAY:\n--\n--   PRIMARY KEY (provider_name, day_utc)\n--\n-- A circuit-breaker window configured in minutes (the default is 10)\n-- therefore rounds up to a whole day, so a breaker meant to react to a\n-- 10-minute burst of failures actually reads 24 hours of history. One\n-- bad afternoon disables a provider for a whole day, and a provider\n-- that recovered an hour ago stays disabled until the next UTC\n-- midnight. The setting is documented in minutes; the query silently\n-- operated in days.\n--\n-- This table adds minute resolution: PRIMARY KEY (provider_name,\n-- minute_utc) where minute_utc is a DATETIME truncated to the minute.\n-- The circuit breaker reads from it for windows under a day and keeps\n-- using provider_call_counter for longer windows (where day buckets\n-- are already the right granularity and this table would be large).\n--\n-- The table stays small: 5 providers x 1440 minutes x 24 = at most\n-- ~172k rows if every provider is called every minute of every day.\n-- Rows older than the longest window the breaker can be configured\n-- for are pruned by the existing retention job; the INSERT below is\n-- idempotent so pruning is safe to run at any time.\n\nCREATE TABLE IF NOT EXISTS provider_call_counter_minute (\n  provider_name       VARCHAR(32)  NOT NULL,\n  minute_utc          DATETIME     NOT NULL,\n  calls_total         INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_429           INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_timeout       INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_network_err   INT UNSIGNED NOT NULL DEFAULT 0,\n  calls_other_err     INT UNSIGNED NOT NULL DEFAULT 0,\n  PRIMARY KEY (provider_name, minute_utc)\n) ENGINE = InnoDB\n  DEFAULT CHARSET = utf8mb4\n  COLLATE = utf8mb4_unicode_ci;\n"],
    ["025_remove_seed_data.sql", "-- SPDX-License-Identifier: MIT\n--\n-- Removes the demo rows that migration 012 used to insert.\n--\n-- Migration 012 originally loaded 50 hand-picked rows (Google DNS,\n-- Cloudflare, RFC 1918, …) as part of `migrate`. Every database —\n-- production included — therefore carried those rows whether the\n-- operator wanted them or not, because the seed was a migration\n-- rather than a choice. A database that skipped seeding still\n-- answered /lookup for 8.8.8.8, which reads as \"populated\" when it\n-- holds nothing but 50 demo addresses.\n--\n-- Migration 012 no longer inserts anything; the demo rows are opt-in\n-- via `node dist/cli.js seed:demo`. This migration brings databases\n-- that already ran the old 012 into the same state a fresh install\n-- reaches.\n--\n-- The DELETE is scoped to country_source = 'seed'. That value was\n-- written only by the demo loader, so it cannot match:\n--   - ETL rows, which carry 'dbip', 'dbip-country' or 'dbip-asn'\n--   - unknown-IP backfill rows, which carry 'multi-provider'\n--   - anything a user added by hand\n--\n-- The WHERE clause is deliberately narrow. A broader delete — say by\n-- range or by IP set — would risk touching real rows that happen to\n-- share a start_ip with a demo row.\n\nDELETE FROM ip_ranges WHERE country_source = 'seed';\n"],
    ["026_mcp_tokens.sql", "-- SPDX-License-Identifier: MIT\n-- MCP tokens authenticate an AI client to the MCP server. They are\n-- deliberately a separate entity from api_keys: an MCP token can read\n-- operational data (queue depths, query logs, user emails), so it needs\n-- an administrator's approval before it works. api_keys stay self-serve.\n--\n-- status: pending  -> approved | rejected\n--         approved -> revoked\nCREATE TABLE IF NOT EXISTS mcp_tokens (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  user_id BIGINT UNSIGNED NOT NULL,\n  label VARCHAR(64) NOT NULL,\n  token_hash CHAR(64) NOT NULL UNIQUE,\n  token_prefix CHAR(12) NOT NULL,\n  status VARCHAR(16) NOT NULL DEFAULT 'pending',\n  scope VARCHAR(16) NOT NULL DEFAULT 'lookup',\n  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  decided_at DATETIME(3) NULL,\n  decided_by BIGINT UNSIGNED NULL,\n  decision_note VARCHAR(255) NULL,\n  last_used_at DATETIME(3) NULL,\n  revoked_at DATETIME(3) NULL,\n  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n  INDEX idx_user (user_id),\n  INDEX idx_status (status),\n  INDEX idx_active (status, revoked_at)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["027_multi_source_etl.sql", "-- Expand the three ETL stage tables to the seven file-level source labels.\n-- The INFORMATION_SCHEMA guard keeps this migration idempotent on MySQL 5.7,\n-- where CREATE TABLE IF NOT EXISTS and dynamic ALTER are the supported tools.\nSET @new_sources := \"'dbip-city','dbip-country','dbip-asn','metowolf-cn','runishiwo-cn','runishiwo-v6','sapics-user'\";\n\nSET @sql := IF(EXISTS(\n    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_downloads'\n       AND COLUMN_NAME = 'source'\n       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'\n       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),\n  'SELECT 1',\n  CONCAT('ALTER TABLE etl_run_downloads MODIFY COLUMN source ENUM(', @new_sources, ') NOT NULL'));\nPREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;\n\nSET @sql := IF(EXISTS(\n    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_parses'\n       AND COLUMN_NAME = 'source'\n       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'\n       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),\n  'SELECT 1',\n  CONCAT('ALTER TABLE etl_run_parses MODIFY COLUMN source ENUM(', @new_sources, ') NOT NULL'));\nPREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;\n\nSET @sql := IF(EXISTS(\n    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS\n     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_inserts'\n       AND COLUMN_NAME = 'source'\n       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'\n       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),\n  'SELECT 1',\n  CONCAT('ALTER TABLE etl_run_inserts MODIFY COLUMN source ENUM(', @new_sources, ') NOT NULL'));\nPREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;\n\nCREATE TABLE IF NOT EXISTS etl_run_dedupe (\n  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,\n  run_id BIGINT UNSIGNED NOT NULL,\n  input_rows BIGINT UNSIGNED NOT NULL,\n  contained BIGINT UNSIGNED NOT NULL,\n  exact_duplicates BIGINT UNSIGNED NOT NULL,\n  partial_overlaps BIGINT UNSIGNED NOT NULL,\n  emitted BIGINT UNSIGNED NOT NULL,\n  duration_ms INT UNSIGNED NULL,\n  started_at DATETIME(3) NOT NULL,\n  finished_at DATETIME(3) NULL,\n  INDEX idx_run (run_id),\n  CONSTRAINT fk_etl_dd_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n"],
    ["028_retire_dead_providers.sql", "-- SPDX-License-Identifier: MIT\n-- Retire two ingest providers that never answered.\n--\n-- `ipapi.co`, `freeipapi.com` and `iplocate.io` were part of the original\n-- five-provider fan-out (migration 016). Measured against the addresses in\n-- this library their success rate was effectively zero, so the votes in\n-- every round went to providers that never answered: the backfill spent\n-- its quota and wrote nothing. What remains — ip-api and ipinfo — is the\n-- pair that actually responds.\n--\n-- Removing them from the seed alone would not be enough. An install that\n-- has been running since 016 already carries their rows, and\n-- `buildProvidersFromConfig` turns any enabled row into a live provider —\n-- so the rows have to go too.\n--\n-- Scoped to the three names: any custom provider an operator added, and\n-- the two providers that do answer, are untouched.\n\nDELETE FROM provider_call_counter\n WHERE provider_name IN ('ipapi-co', 'freeipapi', 'iplocate');\n\nDELETE FROM provider_call_counter_minute\n WHERE provider_name IN ('ipapi-co', 'freeipapi', 'iplocate');\n\nDELETE FROM provider_error_log\n WHERE provider_name IN ('ipapi-co', 'freeipapi', 'iplocate');\n\nDELETE FROM ingest_providers\n WHERE name IN ('ipapi-co', 'freeipapi', 'iplocate');\n"],
    ["029_add_ip_sb_provider.sql", "-- SPDX-License-Identifier: MIT\n-- Add two ingest providers: ip.sb and ip9.com.cn.\n--\n-- Migration 028 left the fan-out with ip-api and ipinfo. Two is the\n-- minimum a majority can work with, so a single 429 made a round\n-- undecidable — the backfill spent its quota and wrote nothing.\n--\n-- Two providers cover the two halves of the library. ip.sb\n-- (api.ip.sb) is a global English source with ASN data: free, no key,\n-- 100 req/min with a 5 req/s burst ceiling. ip9 (ip9.com.cn) answers\n-- Chinese addresses down to the district, in Chinese, at 60 req/min —\n-- precision the English sources do not have. Neither is authoritative\n-- alone; the consensus still decides.\n--\n-- ON DUPLICATE KEY UPDATE keeps this an idempotent re-run without\n-- resetting an operator's choice: if the row already exists (someone\n-- added it by hand, or the migration is replayed) the enabled flag and\n-- any key stay exactly as they are.\n\nINSERT INTO ingest_providers (name, display_name, free_quota) VALUES\n  ('ip-sb', 'IP.SB',       '100 req/min (5 req/s), no key (HTTPS)'),\n  ('ip9',   'IP9.COM.CN',  '60 req/min, no key (HTTPS), Chinese results')\nON DUPLICATE KEY UPDATE name = name;\n"],
    ["030_random_gen_cadence.sql", "-- SPDX-License-Identifier: MIT\n-- Slow the random-IP ingest to twenty runs an hour, one IP per run.\n--\n-- The old defaults (every 60s, ten IPs per run) were 600 addresses an hour,\n-- each asking EVERY provider — 2,400 provider calls an hour in total. The\n-- free tiers are measured per calendar minute and the queue-driven backfill\n-- needs the same quota for its votes, so the random generator was draining\n-- it before the backfill that actually needs several opinions got a turn.\n--\n-- Two changes make the same job cost a fraction:\n--   * one IP per run (the generator now rotates providers instead of\n--     fanning out to all of them), and\n--   * one run every three minutes.\n--\n-- The values below are the new defaults. An operator who has deliberately\n-- tuned these keeps their choice: the WHERE clause only touches rows still\n-- holding the OLD defaults.\n\nUPDATE settings SET v = '180'\n WHERE k = 'random_gen_interval_sec' AND v = '60';\n\nUPDATE settings SET v = '1'\n WHERE k = 'random_gen_batch_size' AND v = '10';\n"],
    ["031_retire_ipinfo.sql", "-- SPDX-License-Identifier: MIT\n-- Retire ipinfo.io as an ingest provider.\n--\n-- It was originally kept: unlike the three removed in migration 028 it does\n-- answer. But it requires an API key on every call, and an install without\n-- one gets an abstention from it every round — a provider that looks enabled\n-- and contributes nothing. The three that remain need no key at all.\n--\n-- This is a separate migration rather than an edit to 028 because 028 had\n-- already been applied here: a migration that has run is history, and\n-- rewriting it means the change silently never reaches any install that\n-- applied the old version. That is exactly what happened — the row survived\n-- a \"database already up to date\".\n--\n-- Scoped to the one name. A custom provider an operator added stays.\n\nDELETE FROM provider_call_counter\n WHERE provider_name = 'ipinfo';\n\nDELETE FROM provider_call_counter_minute\n WHERE provider_name = 'ipinfo';\n\nDELETE FROM provider_error_log\n WHERE provider_name = 'ipinfo';\n\nDELETE FROM ingest_providers\n WHERE name = 'ipinfo';\n"],
]);
/** Every migration file this build ships, in the order it applies. Loaded
 *  from the deployment at startup; see `loadMigrationManifest`. */
let MIGRATION_FILES = [
    "001_ip_ranges.sql",
    "002_etl_runs.sql",
    "003_users.sql",
    "004_api_keys.sql",
    "005_sessions.sql",
    "006_email_verifications.sql",
    "007_password_resets.sql",
    "008_query_log.sql",
    "010_admin_audit_log.sql",
    "011_settings.sql",
    "012_seed_ip_ranges.sql",
    "013_ip_ranges_unique_key.sql",
    "014_ip_ranges_range_size.sql",
    "015_unknown_ip_queue.sql",
    "016_ingest_providers.sql",
    "017_provider_error_log.sql",
    "018_random_probe_log.sql",
    "019_etl_run_stages.sql",
    "020_provider_call_counter.sql",
    "021_custom_providers.sql",
    "022_etl_run_progress.sql",
    "023_fix_seed_ip_encoding.sql",
    "024_provider_call_counter_minute.sql",
    "025_remove_seed_data.sql",
    "026_mcp_tokens.sql",
    "027_multi_source_etl.sql",
    "028_retire_dead_providers.sql",
    "029_add_ip_sb_provider.sql",
    "030_random_gen_cadence.sql",
    "031_retire_ipinfo.sql",
];
const MIGRATION_FILE_RE = /^(\d{3})_(.+)\.sql$/;
/**
 * DDL that changes an EXISTING table, so MySQL has to rebuild it. Adding a
 * column, dropping one, redefining one — all of them copy the rows.
 *
 * `CREATE TABLE` is deliberately absent: a brand-new table has nothing to
 * rebuild and nothing to lock, so a migration that only adds tables is
 * cheap even on a large install.
 */
const TABLE_REBUILDING_DDL = /(?:ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX|DROP\s+INDEX)/i;
/**
 * The DDL that changes tables rather than rows.
 *
 * `CREATE TABLE` counts here even though it takes no lock: the operator
 * wants to know whether a pending step touches the schema at all, and a
 * step that adds `etl_run_dedupe` is not the same class of change as one
 * that rewrites `settings`.
 */
/** `ALTER TABLE x ADD|DROP|MODIFY|CHANGE COLUMN …` is what forces MySQL to
 *  rebuild the table. An ALTER that only adds an index is not one. */
const COLUMN_DDL = /(?:ADD|DROP|MODIFY|CHANGE)\s+(?:COLUMN\s+)?[A-Za-z_]/i;
const SCHEMA_DDL = /(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|(?:CREATE|DROP)\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX)/i;
function classify(sql) {
    return {
        kind: SCHEMA_DDL.test(sql) ? "schema" : "data",
        takesTableLock: TABLE_REBUILDING_DDL.test(sql) && COLUMN_DDL.test(sql),
    };
}
/** Every migration that ships with this build, in the order it applies. */
/**
 * Read the migration SQL out of the deployment and fill `MIGRATION_SQL` /
 * `MIGRATION_FILES`.
 *
 * Called once at module load and again by `reloadMigrationManifest()` when
 * a test needs to prove the report survives a deployment that shipped no
 * SQL. Failures are not fatal: an unreadable directory leaves the manifest
 * empty, `listMigrationEntries()` returns nothing, and the report says
 * "nothing to check" — which is honest — rather than throwing from a
 * health endpoint.
 */
async function loadMigrationManifest(migrationsDir) {
    let files;
    try {
        const entries = await fs.readdir(migrationsDir);
        files = entries.filter((f) => MIGRATION_FILE_RE.test(f)).sort();
    }
    catch {
        files = [];
    }
    const sql = new Map();
    for (const file of files) {
        try {
            sql.set(file, await fs.readFile(path.join(migrationsDir, file), "utf8"));
        }
        catch {
            // A file that vanished between the listing and the read is treated
            // as absent: `listMigrationEntries` classifies it as `data`, which is
            // the conservative answer.
        }
    }
    MIGRATION_SQL.clear();
    for (const [file, text] of sql)
        MIGRATION_SQL.set(file, text);
    MIGRATION_FILES = files;
}
/** Re-read the manifest. Only tests need this — the production path loads
 *  the manifest once at startup and the files never change under it. */
async function reloadMigrationManifest() {
    await loadMigrationManifest(path.join(__dirname));
}
/** Load the manifest from an explicit directory. Test-only: it lets a test
 *  point at a directory with no migrations in it. */
async function loadMigrationManifestFrom(migrationsDir) {
    await loadMigrationManifest(migrationsDir);
}
function listMigrationEntries() {
    return MIGRATION_FILES.map((file) => {
        const match = MIGRATION_FILE_RE.exec(file);
        const version = match?.[1] ?? file.slice(0, 3);
        const name = match?.[2] ?? file;
        return { version, name, file, ...classify(MIGRATION_SQL.get(file) ?? "") };
    });
}
void loadMigrationManifest(path.join(__dirname));
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;
async function getAppliedVersions(pool) {
    await pool.query(SCHEMA_MIGRATIONS_DDL);
    const [rows] = await pool.query("SELECT version FROM schema_migrations");
    return new Set(rows.map((r) => String(r.version)));
}
async function runMigrations(pool) {
    const files = MIGRATION_FILES;
    const applied = await getAppliedVersions(pool);
    const newlyApplied = [];
    const skipped = [];
    for (const file of files) {
        const version = file.slice(0, 3);
        if (applied.has(version)) {
            skipped.push(version);
            continue;
        }
        const sql = MIGRATION_SQL.get(file);
        if (typeof sql !== "string") {
            throw new Error(`migration ${version} is missing from this build: ${file}`);
        }
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query(sql);
            await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
            await conn.commit();
            newlyApplied.push(version);
        }
        catch (err) {
            await conn.rollback();
            // Wrap the driver error so the message names the migration, but
            // KEEP the driver's `code` on the wrapper.
            //
            // The code is what tells the boot path whether this is "the
            // database is unreachable" (degrade and serve the wizard) or "the
            // database is reachable but the schema is broken" (a real failure
            // that must surface). A plain `new Error(message)` drops it, so
            // every migration failure would look like an unreachable database
            // and the server would quietly degrade instead of reporting the
            // actual problem.
            const driverCode = err.code;
            const wrapped = new Error(`migration ${version} failed: ${err.message}`);
            if (typeof driverCode === "string") {
                wrapped.code = driverCode;
            }
            wrapped.cause = err;
            throw wrapped;
        }
        finally {
            conn.release();
        }
    }
    return { applied: newlyApplied, skipped };
}
/**
 * Derive the reference from the migration SQL.
 *
 * Covers what this project actually writes:
 *   · `CREATE TABLE x ( … )` — the column list is every `name TYPE`
 *     declaration at the top level of the body, minus table options and
 *     constraints.
 *   · `ALTER TABLE x ADD COLUMN name …` — appended to whatever x already
 *     had.
 *   · `CREATE TABLE x LIKE y` — copies y's columns, which is what the ETL's
 *     scratch table does.
 *
 * Deliberately NOT a full SQL parser. A declaration it cannot recognise is
 * skipped rather than guessed, which only ever makes the reference narrower
 * — and a narrower reference reports less drift, never more.
 */
function buildSchemaReference(entries) {
    const columns = new Map();
    const likeSources = new Map();
    const drops = [];
    for (const entry of entries) {
        const sql = MIGRATION_SQL.get(entry.file) ?? empty;
        // Prose mentions DDL too: a comment can say a table lock is taken or
        // quote a statement it is about to build. Comments go first, or the
        // reference picks up table names that were never created.
        const code = stripSqlComments(sql);
        for (const m of code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+LIKE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
            likeSources.set(m[1].toLowerCase(), m[2].toLowerCase());
        }
        for (const m of code.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?:ENGINE|;|$)/gi)) {
            columns.set(m[1].toLowerCase(), new Set(parseColumnList(m[2] ?? empty)));
        }
        // ALTER TABLE is matched WITHOUT a trailing semicolon. Migration 020,
        // 022 and 027 build their ALTER as a CONCAT whose parts are quoted ADD
        // COLUMN fragments, and the ALTER keyword only appears at the END of
        // that CONCAT — the columns were written 1,600 characters earlier.
        // Reading only what follows the keyword therefore found nothing, and
        // the reference lost every column those migrations add.
        //
        // The statement is taken to END at the next semicolon and to START at
        // the previous one. That is not quite the statement 022 runs — it runs
        // the CONCAT of two halves — but it is the smallest span that contains
        // both halves, and nothing else in this project writes an ALTER whose
        // parts are separated by a semicolon.
        for (const m of code.matchAll(/ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
            const table = m[1].toLowerCase();
            const body = code;
            const known = columns.get(table) ?? new Set();
            for (const c of body.matchAll(/ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
                const column = c[1];
                // 022's CONCAT names the table as its first argument:
                // CONCAT('ALTER TABLE etl_runs ', @parts). `etl_runs` there is the
                // table, not a column of itself.
                if (column.toLowerCase() === table)
                    continue;
                known.add(column);
            }
            for (const c of body.matchAll(/DROP\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
                drops.push([table, c[1].toLowerCase()]);
            }
            columns.set(table, known);
        }
    }
    // A DROP COLUMN anywhere in the migration history ends the column. The
    // name is recorded rather than applied in order, because a drop may be
    // written before the CREATE that re-adds it in a later migration — and
    // the reference has to describe the FINAL state, not the order of steps.
    for (const [table, column] of drops) {
        const known = columns.get(table);
        if (known)
            known.delete(column);
    }
    // Resolve CREATE TABLE x LIKE y last, so a copy always sees the final
    // column list of its source.
    for (const [name, source] of likeSources) {
        const from = columns.get(source);
        if (from)
            columns.set(name, new Set(from));
    }
    const tables = new Map();
    for (const [table, cols] of columns)
        tables.set(table, [...cols].sort());
    return { tables };
}
const empty = "";
/** Line comments and block comments. */
function stripSqlComments(sql) {
    return sql.replace(/--[^\n]*/g, empty).replace(/\/\*[\s\S]*?\*\//g, empty);
}
/** Column declarations inside a CREATE TABLE body. */
function parseColumnList(body) {
    const columns = [];
    for (const raw of body.split(",")) {
        const line = raw.trim();
        if (line === empty)
            continue;
        if (/^(PRIMARY\s+KEY|UNIQUE|INDEX|KEY|CONSTRAINT|FOREIGN\s+KEY|FULLTEXT|SPATIAL|CHECK)\b/i.test(line))
            continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(line);
        if (m && m[1])
            columns.push(m[1]);
    }
    return columns;
}
/**
 * Compare the live structure against the reference.
 *
 * Reads INFORMATION_SCHEMA rather than SHOW CREATE TABLE: the latter is one
 * statement per table and returns a string that would need re-parsing.
 */
async function readDrift(pool, reference) {
    const drift = [];
    const [rows] = await pool.query("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()");
    const live = new Map();
    for (const row of rows) {
        const table = row.t.toLowerCase();
        if (!live.has(table))
            live.set(table, new Set());
        live.get(table).add(row.c.toLowerCase());
    }
    for (const [table, expected] of reference.tables) {
        const actual = live.get(table);
        if (!actual) {
            drift.push({ table, kind: "missing_table", column: null });
            continue;
        }
        for (const column of expected) {
            if (!actual.has(column.toLowerCase())) {
                drift.push({ table, kind: "missing_column", column });
            }
        }
    }
    return drift;
}
async function getSchemaReport(pool) {
    return getSchemaReportFrom(pool, buildSchemaReference(listMigrationEntries()));
}
/** The same report against an explicit reference. The console and the health
 *  check use the derived one; `scripts/schema-reference.js` uses the same
 *  builder, so the document and the check cannot disagree. */
async function getSchemaReportFrom(pool, reference) {
    const entries = listMigrationEntries();
    const latest = entries[entries.length - 1] ?? null;
    let appliedVersions;
    try {
        appliedVersions = await getAppliedVersions(pool);
    }
    catch (err) {
        return {
            applied: [],
            pending: entries.map((entry) => ({ entry, reason: "not_applied" })),
            pendingCount: entries.length,
            isCurrent: false,
            latest,
            appliedLatest: null,
            error: describeMigrationError(err),
            hasLockRisk: true,
            drift: [],
            structureError: null,
        };
    }
    const applied = entries.filter((e) => appliedVersions.has(e.version));
    const pending = entries
        .filter((e) => !appliedVersions.has(e.version))
        .map((entry) => ({ entry, reason: "not_applied" }));
    // The structure check is separate from the ledger check, and it must not
    // report a clean diff when it could not run. `isCurrent` needs BOTH: a
    // database whose ledger is complete but whose `settings` table is missing
    // a column is not in step with this code.
    let drift = [];
    let structureError = null;
    try {
        drift = await readDrift(pool, reference);
    }
    catch (err) {
        structureError = describeMigrationError(err);
    }
    return {
        applied,
        pending,
        pendingCount: pending.length,
        hasLockRisk: pending.some((p) => p.entry.takesTableLock),
        isCurrent: pending.length === 0 && drift.length === 0 && structureError === null,
        latest,
        appliedLatest: applied[applied.length - 1] ?? null,
        error: null,
        drift,
        structureError,
    };
}
/** A short reason the ledger could not be read. Mirrors `describeDbError` in
 *  `src/api/dbBootstrap.ts` without importing the web layer into storage. */
function describeMigrationError(err) {
    const code = typeof err === "object" && err !== null ? err.code : undefined;
    if (typeof code === "string") {
        if (code === "ECONNREFUSED")
            return "the server refused the connection";
        if (code === "ER_ACCESS_DENIED_ERROR")
            return "the credentials were rejected";
        if (code === "ER_BAD_DB_ERROR")
            return "that database does not exist";
        if (code === "ETIMEDOUT")
            return "the connection timed out";
        if (code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH")
            return "the host is unreachable";
    }
    return err instanceof Error ? err.message : "unknown error";
}
async function migrationStatus(pool) {
    const allVersions = MIGRATION_FILES.map((f) => f.slice(0, 3));
    const applied = await getAppliedVersions(pool);
    return {
        applied: allVersions.filter((v) => applied.has(v)),
        pending: allVersions.filter((v) => !applied.has(v)),
    };
}
async function listMigrationFiles() {
    return [...MIGRATION_FILES];
}
//# sourceMappingURL=runner.js.map