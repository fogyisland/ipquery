-- SPDX-License-Identifier: MIT
-- provider_error_log: per-failure audit trail for the IP-geolocation
-- providers. One row per failed lookup attempt during backfill or random
-- generation. The admin UI's "Failure Logs" tab reads from this table
-- with optional filters (provider, error code, time range).
--
-- Why a separate log and not just the ingest_providers row counters:
--   - Per-IP context: which IP triggered the failure (operators want to
--     replay or skip specific IPs).
--   - Distinguishes "transient 429" from "permanent 401 unauthorized"
--     so the circuit breaker can decide whether to disable the provider.
--   - Keeps the hot ingest_providers table small (latest-only state).
--
-- Volume expectation: bounded by backfill batch size * providers per day.
-- 100 IPs * 3 providers * 24 runs/day = ~7k rows/day worst case. We
-- rotate rows older than 30 days via a daily cleanup (run separately,
-- not part of this migration). Indexes target the admin's filter UI.

CREATE TABLE IF NOT EXISTS provider_error_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_name VARCHAR(32) NOT NULL,
  ip_text VARCHAR(45) NOT NULL,
  -- 'auto' = unknown_ip_queue backfill, 'manual' = POST /generate,
  -- 'random' = random-gen runner. Operators use this to tell
  -- whether an error came from background work or a one-shot.
  mode ENUM('auto','manual','random') NOT NULL,
  -- HTTP status (e.g. 429, 401, 504) or 'timeout' or 'network'.
  -- VARCHAR(16) so non-numeric reasons fit without enum churn.
  error_code VARCHAR(16) NOT NULL,
  -- Short reason from the provider (e.g. "rate limited (3x)").
  reason VARCHAR(255) NOT NULL,
  -- Truncated raw response body. NULL when not captured (timeout). Useful
  -- for debugging provider-specific responses without re-running.
  raw_response VARCHAR(512) NULL,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Retry counter inside the same IP run (1..3). 1 = first attempt.
  -- > 1 means the failure was retried with the same provider.
  retry_count TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- What the backfill decided to do with this error:
  --   'logged'       — recorded only, no special action
  --   'abstained'    — provider skipped this IP (no record)
  --   'auto_disabled'— provider toggled off due to 429 (circuit breaker)
  INDEX idx_provider_ts (provider_name, ts),
  INDEX idx_ts (ts),
  INDEX idx_error_code (error_code, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Circuit-breaker settings. The breaker consults:
--   - cb_enabled: master switch (1 = enforce, 0 = bypass)
--   - cb_failure_threshold: failure rate percentage (0-100) over the
--     sliding window below. If exceeded → auto-disable provider.
--   - cb_window_minutes: sliding-window length for the failure rate.
--   - cb_cooldown_minutes: how long the provider stays disabled before
--     the next attempt re-enables it.
-- All keys are read by `getCircuitBreakerConfig()` and written by the
-- admin POST handler. Defaults match the user's "auto-disable on 429"
-- behavior already shipped via disableRateLimitedProviders().
INSERT INTO settings (k, v) VALUES
  ('cb_enabled', '1'),
  ('cb_failure_threshold', '50'),
  ('cb_window_minutes', '10'),
  ('cb_cooldown_minutes', '15')
ON DUPLICATE KEY UPDATE k = k;