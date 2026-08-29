-- SPDX-License-Identifier: MIT
--
-- etl_run_stages side tables — per-file/per-stage breakdown for each
-- etl_runs row. Why split into four tables instead of packing everything
-- into etl_runs:
--   1. The legacy etl_runs row is one summary line per run. Operators need
--      per-file/per-stage detail (which file failed, how many rows were
--      skipped because of bad IPs vs missing columns, etc.) to triage
--      without grepping server logs.
--   2. Stage cardinality is variable: download has 3 attempts (city/country/asn),
--      parse has N files that were present, insert has N files, swap has 1.
--      A row-per-stage layout maps cleanly to FK cascades.
--   3. Each stage has a distinct shape (download carries bytes/URL/month,
--      parse carries skip counters, insert carries upsert counts, swap
--      carries a status). Splitting them keeps the columns narrow and
--      the INSERTs small.
--
-- All four tables FK to etl_runs(id) ON DELETE CASCADE so removing a
-- test run wipes its stage detail. Indexes target the admin run-detail
-- page's "list every stage row for this run_id" query.

CREATE TABLE IF NOT EXISTS etl_run_downloads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  source ENUM('dbip-city','dbip-country','dbip-asn') NOT NULL,
  dest_name VARCHAR(64) NOT NULL,
  source_url VARCHAR(255) NULL,
  month CHAR(7) NULL,
  status ENUM('success','failed','missing','skipped') NOT NULL,
  bytes BIGINT UNSIGNED NULL,
  duration_ms INT UNSIGNED NULL,
  retry_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(512) NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  INDEX idx_run (run_id),
  CONSTRAINT fk_etl_dl_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS etl_run_parses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  source ENUM('dbip-city','dbip-country','dbip-asn') NOT NULL,
  dest_name VARCHAR(64) NOT NULL,
  rows_emitted BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_skipped_short BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_skipped_header BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_skipped_unparseable_ip BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_skipped_missing_col BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_skipped_nan_asn BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_skipped_other BIGINT UNSIGNED NOT NULL DEFAULT 0,
  gunzip_errors INT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  duration_ms INT UNSIGNED NULL,
  INDEX idx_run (run_id),
  CONSTRAINT fk_etl_ps_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS etl_run_inserts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  source ENUM('dbip-city','dbip-country','dbip-asn') NOT NULL,
  dest_name VARCHAR(64) NOT NULL,
  rows_attempted BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_inserted BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_duplicates BIGINT UNSIGNED NOT NULL DEFAULT 0,
  batch_count INT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms INT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  INDEX idx_run (run_id),
  CONSTRAINT fk_etl_in_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS etl_run_swaps (
  run_id BIGINT UNSIGNED PRIMARY KEY,
  status ENUM('success','failed') NOT NULL,
  duration_ms INT UNSIGNED NULL,
  error_message VARCHAR(512) NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  CONSTRAINT fk_etl_sw_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;