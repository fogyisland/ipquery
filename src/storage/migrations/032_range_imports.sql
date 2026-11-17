-- SPDX-License-Identifier: MIT
-- Import jobs for the .ipq range import (/admin/ranges).
--
-- A whole-library import runs for hours. It cannot be the request that
-- started it: a browser tab closes, a proxy times the connection out, and
-- the operator is left with no idea whether the rows landed. The job is a
-- row so both the page and a later operator can see how far it got and
-- whether it finished.
--
-- rows_done is a running total updated as batches land. It is written with
-- GREATEST(rows_done, ?) so a retry cannot make the counter go backwards:
-- a bar that jumps back to 30% after reaching 80% reads as work undone.
CREATE TABLE IF NOT EXISTS range_imports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mode ENUM('merge','replace') NOT NULL DEFAULT 'replace',
  source VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  declared_rows BIGINT UNSIGNED NULL,
  rows_done BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_written BIGINT UNSIGNED NOT NULL DEFAULT 0,
  preserved BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(255) NULL,
  progress_updated_at DATETIME(3) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  INDEX idx_started (started_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
