-- SPDX-License-Identifier: MIT
-- provider_call_counter: per-provider, per-UTC-day call counter. Powers
-- the new "1h/24h/7d window stats" on the Providers tab and the "daily
-- quota usage" pill. UPSERTed from touchProviderCalled in the
-- backfill / random-gen flows. PK (provider_name, day_utc) so a single
-- row accumulates all calls per UTC day. Volume: ~30k rows/day worst
-- case (batch=100 × 60s interval × 5 providers). Index on day_utc for
-- the admin UI's windowed aggregates.
CREATE TABLE IF NOT EXISTS provider_call_counter (
  provider_name VARCHAR(32) NOT NULL,
  day_utc DATE NOT NULL,
  calls_total INT UNSIGNED NOT NULL DEFAULT 0,
  calls_429 INT UNSIGNED NOT NULL DEFAULT 0,
  calls_timeout INT UNSIGNED NOT NULL DEFAULT 0,
  calls_network_err INT UNSIGNED NOT NULL DEFAULT 0,
  calls_other_err INT UNSIGNED NOT NULL DEFAULT 0,
  last_called_at DATETIME(3) NULL,
  PRIMARY KEY (provider_name, day_utc),
  INDEX idx_day (day_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Auto-re-enable timestamp for the circuit breaker. When
-- disableRateLimitedProviders() flips a provider to enabled=0 it ALSO
-- sets auto_reenable_at = NOW() + cb_cooldown_minutes. The new
-- reapProviders() helper in randomIpGeneratorRunner.ts flips it back
-- to enabled=1 once auto_reenable_at <= NOW(). This finally makes
-- cb_cooldown_minutes (previously dead code) a real runtime setting.
--
-- Both columns are added by ONE ALTER TABLE. Every ALTER TABLE is an
-- implicit commit on the server and the metadata write is durable,
-- which costs about a second per statement on a slow disk. Two
-- statements meant two seconds; one statement means one.
--
-- The ALTER is idempotent via INFORMATION_SCHEMA: if a prior partial run
-- left these columns in place but the INSERT into schema_migrations rolled
-- back, re-running adds exactly the columns that are still missing and
-- no-ops on the rest. (MySQL 5.7 does not support `ADD COLUMN IF NOT
-- EXISTS`, only 8.0.29+ does, so the column list is assembled as text
-- and run through a prepared statement.)
SET @parts := CONCAT_WS(', ',
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'ingest_providers'
         AND COLUMN_NAME  = 'auto_reenable_at'),
     NULL,
     'ADD COLUMN auto_reenable_at DATETIME(3) NULL AFTER last_error_reason'),
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'ingest_providers'
         AND COLUMN_NAME  = 'auto_disabled_reason'),
     NULL,
     'ADD COLUMN auto_disabled_reason VARCHAR(255) NULL AFTER auto_reenable_at')
);
SET @sql := IF(@parts = '', 'SELECT 1', CONCAT('ALTER TABLE ingest_providers ', @parts));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
