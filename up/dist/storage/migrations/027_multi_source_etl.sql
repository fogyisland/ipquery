-- Expand the three ETL stage tables to the seven file-level source labels.
-- The INFORMATION_SCHEMA guard keeps this migration idempotent on MySQL 5.7,
-- where CREATE TABLE IF NOT EXISTS and dynamic ALTER are the supported tools.
SET @new_sources := "'dbip-city','dbip-country','dbip-asn','metowolf-cn','runishiwo-cn','runishiwo-v6','sapics-user'";

SET @sql := IF(EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_downloads'
       AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'
       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),
  'SELECT 1',
  CONCAT('ALTER TABLE etl_run_downloads MODIFY COLUMN source ENUM(', @new_sources, ') NOT NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_parses'
       AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'
       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),
  'SELECT 1',
  CONCAT('ALTER TABLE etl_run_parses MODIFY COLUMN source ENUM(', @new_sources, ') NOT NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(EXISTS(
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'etl_run_inserts'
       AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE LIKE '%metowolf-cn%' AND COLUMN_TYPE LIKE '%runishiwo-cn%'
       AND COLUMN_TYPE LIKE '%runishiwo-v6%' AND COLUMN_TYPE LIKE '%sapics-user%'),
  'SELECT 1',
  CONCAT('ALTER TABLE etl_run_inserts MODIFY COLUMN source ENUM(', @new_sources, ') NOT NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS etl_run_dedupe (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  input_rows BIGINT UNSIGNED NOT NULL,
  contained BIGINT UNSIGNED NOT NULL,
  exact_duplicates BIGINT UNSIGNED NOT NULL,
  partial_overlaps BIGINT UNSIGNED NOT NULL,
  emitted BIGINT UNSIGNED NOT NULL,
  duration_ms INT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  INDEX idx_run (run_id),
  CONSTRAINT fk_etl_dd_run FOREIGN KEY (run_id) REFERENCES etl_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
