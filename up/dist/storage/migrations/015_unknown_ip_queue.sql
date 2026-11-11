-- SPDX-License-Identifier: MIT
-- unknown_ip_queue: tracks IPs that /lookup couldn't resolve so we can
-- backfill them from external providers instead of dropping the signal.
--
-- processed_at NULL + merged_run_id NULL = pending backfill.
-- The "covered by ip_ranges" check lives in nextBatch() (NOT EXISTS), not
-- here, so an IP can stay queued across multiple ETL windows even if a
-- range happens to disappear; the backfill job is the only place that
-- transitions rows out of "pending".

CREATE TABLE IF NOT EXISTS unknown_ip_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ip VARBINARY(16) NOT NULL,
  ip_text VARCHAR(45) NOT NULL,
  query_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_by_user_id BIGINT UNSIGNED NULL,
  source ENUM('auto_miss','manual_submit') NOT NULL DEFAULT 'auto_miss',
  -- Backfill outcome
  processed_at DATETIME(3) NULL,
  merged_run_id BIGINT UNSIGNED NULL,
  -- Why we couldn't merge, if we couldn't (e.g. "no_consensus").
  -- NULL means "we haven't tried yet" OR "we successfully merged".
  last_attempt_reason TEXT NULL,
  UNIQUE KEY uk_ip (ip),
  INDEX idx_pending_priority (query_count, last_seen_at),
  INDEX idx_processed_at (processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;