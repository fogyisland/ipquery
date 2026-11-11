-- SPDX-License-Identifier: MIT
--
-- Per-minute provider call counters.
--
-- provider_call_counter (migration 020) buckets calls by UTC DAY:
--
--   PRIMARY KEY (provider_name, day_utc)
--
-- A circuit-breaker window configured in minutes (the default is 10)
-- therefore rounds up to a whole day, so a breaker meant to react to a
-- 10-minute burst of failures actually reads 24 hours of history. One
-- bad afternoon disables a provider for a whole day, and a provider
-- that recovered an hour ago stays disabled until the next UTC
-- midnight. The setting is documented in minutes; the query silently
-- operated in days.
--
-- This table adds minute resolution: PRIMARY KEY (provider_name,
-- minute_utc) where minute_utc is a DATETIME truncated to the minute.
-- The circuit breaker reads from it for windows under a day and keeps
-- using provider_call_counter for longer windows (where day buckets
-- are already the right granularity and this table would be large).
--
-- The table stays small: 5 providers x 1440 minutes x 24 = at most
-- ~172k rows if every provider is called every minute of every day.
-- Rows older than the longest window the breaker can be configured
-- for are pruned by the existing retention job; the INSERT below is
-- idempotent so pruning is safe to run at any time.

CREATE TABLE IF NOT EXISTS provider_call_counter_minute (
  provider_name       VARCHAR(32)  NOT NULL,
  minute_utc          DATETIME     NOT NULL,
  calls_total         INT UNSIGNED NOT NULL DEFAULT 0,
  calls_429           INT UNSIGNED NOT NULL DEFAULT 0,
  calls_timeout       INT UNSIGNED NOT NULL DEFAULT 0,
  calls_network_err   INT UNSIGNED NOT NULL DEFAULT 0,
  calls_other_err     INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_name, minute_utc)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
