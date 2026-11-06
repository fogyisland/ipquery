-- SPDX-License-Identifier: MIT
--
-- Live ETL progress: per-run counters that the pipeline updates while
-- the run is in flight, so the admin UI can render progress bars and
-- percentages without polling per-file stage rows.
--
-- download_bytes_done / total  : current and final byte counts of all
--   in-flight downloads (Content-Length-known at HEAD time, sum of
--   completed file sizes once each file lands).
-- insert_rows_done            : rows successfully INSERTed (or
--   ON-DUPLICATE updated) across all sources so far. We only UPDATE
--   the column once the run finishes — see pipeline.ts notes on why
--   in-flight reporting uses batchCount instead. Stored here as the
--   cumulative count for the run-detail page.

SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'etl_runs'
     AND COLUMN_NAME  = 'download_bytes_done'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE etl_runs ADD COLUMN download_bytes_done BIGINT UNSIGNED NULL AFTER ip2region_built_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'etl_runs'
     AND COLUMN_NAME  = 'download_bytes_total'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE etl_runs ADD COLUMN download_bytes_total BIGINT UNSIGNED NULL AFTER download_bytes_done',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'etl_runs'
     AND COLUMN_NAME  = 'insert_rows_done'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE etl_runs ADD COLUMN insert_rows_done BIGINT UNSIGNED NULL AFTER download_bytes_total',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'etl_runs'
     AND COLUMN_NAME  = 'insert_rows_total'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE etl_runs ADD COLUMN insert_rows_total BIGINT UNSIGNED NULL AFTER insert_rows_done',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'etl_runs'
     AND COLUMN_NAME  = 'current_stage'
);
SET @sql := IF(@col = 0,
  "ALTER TABLE etl_runs ADD COLUMN current_stage ENUM('download','parse','insert','swap','done') NULL AFTER insert_rows_total",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'etl_runs'
     AND COLUMN_NAME  = 'progress_updated_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE etl_runs ADD COLUMN progress_updated_at DATETIME(3) NULL AFTER current_stage',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
