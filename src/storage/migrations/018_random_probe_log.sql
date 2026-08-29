-- SPDX-License-Identifier: MIT
-- random_probe_log: per-IP audit trail for the API ingest flows. One row
-- per (ip, runMode) — captures both successful consensus AND every other
-- outcome (no_consensus, no_country, all_abstained). The admin UI's
-- "Recent Probes" table on the Overview tab reads from here so operators
-- can answer "what did the last tick actually do, per IP, per provider?"
--
-- Why a separate log instead of extending provider_error_log:
--   - provider_error_log is failure-only — recording successful
--     consensus there would dilute the failure audit trail.
--   - random_probe_log captures the FULL provider response for each IP
--     (countryCode/city/asn/durationMs/rawResponse/errorCode/rateLimited)
--     in one row's providers_json blob. That makes the row self-contained:
--     a single SELECT gives you everything you need to debug why a
--     consensus vote succeeded or failed.
--   - mode column disambiguates the trigger source (auto=queue backfill,
--     manual=POST /generate button, random=continuous runner).
--
-- Volume expectation:
--   - mode=random: ~10 IPs/min * 60 * 24 = ~14k rows/day (worst case)
--   - mode=manual: bursty from admin button; usually 10-20 rows per click
--   - mode=auto: bounded by queue depth; usually <500/day
--   Total ~20k rows/day worst case. No rotation in v1 — add a daily
--   cleanup later if volume becomes a concern.

CREATE TABLE IF NOT EXISTS random_probe_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ip_text VARCHAR(45) NOT NULL,
  ip_binary VARBINARY(16) NOT NULL,
  -- Trigger source. Mirrors provider_error_log.mode convention.
  mode ENUM('auto','manual','random') NOT NULL,
  -- Consensus outcome kind. Same enum as IpOutcome.kind:
  --   'merged'         → /32 (or /128) inserted into ip_ranges
  --   'no_consensus'   → providers disagreed on country
  --   'no_country'     → at least one provider agreed but no country code
  --   'all_abstained'  → every provider skipped (key missing, etc.)
  outcome ENUM('merged','no_consensus','no_country','all_abstained') NOT NULL,
  -- Consensus fields (NULL when outcome != 'merged').
  consensus_country VARCHAR(8) NULL,
  consensus_city VARCHAR(64) NULL,
  consensus_asn INT UNSIGNED NULL,
  -- ip_ranges.id when outcome='merged'. NULL otherwise.
  merged_run_id BIGINT UNSIGNED NULL,
  -- JSON array of PerProviderDetail objects. Each object has:
  --   { provider, countryCode, city, asn, rateLimited, errorCode,
  --     durationMs, rawResponse }
  -- The per-provider responses are the most useful debugging data
  -- ("why did this IP merge as US when ipapi.co said CN?").
  providers_json TEXT NOT NULL,
  -- UUID grouping probes from the same run/tick. Lets the UI show
  -- "10 IPs processed at 2026-08-29 12:34:56 UTC" as a group.
  batch_id CHAR(36) NULL,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_ts (ts),
  INDEX idx_outcome_ts (outcome, ts),
  INDEX idx_batch (batch_id),
  INDEX idx_ip_binary (ip_binary)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Continuous random-IP ingest scheduler settings. Read by
-- registerRandomGenRunner (interval/batch), and by the new
-- /admin/unknown-ips/scheduler POST handler. Defaults match the values
-- previously hardcoded in the runner (intervalMs=60_000, count=10).
INSERT INTO settings (k, v) VALUES
  ('random_gen_interval_sec', '60'),
  ('random_gen_batch_size', '10'),
  ('random_gen_cooldown_minutes', '15'),
  ('random_gen_cb_linkage', '1')
ON DUPLICATE KEY UPDATE k = k;