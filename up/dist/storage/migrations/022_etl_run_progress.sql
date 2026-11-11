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
--   ON DUPLICATE updated) across all sources so far. We only UPDATE
--   the column once the run finishes — see pipeline.ts notes on why
--   in-flight reporting uses batchCount instead. Stored here as the
--   cumulative count for the run-detail page.
--
-- All six columns live on etl_runs and are added by ONE ALTER TABLE.
--
-- Why one statement instead of six: every ALTER TABLE is an implicit
-- commit on the server, and the metadata write is durable — on a
-- machine with a slow disk that costs about a second per statement.
-- Six separate ALTERs made a fresh database spend ~9.5s here, which is
-- most of why the E2E setup hook used to time out. Adding the columns
-- in a single ALTER cuts that to ~1.5s.
--
-- Why not "ADD COLUMN IF NOT EXISTS": that syntax only exists in
-- MySQL 8.0.29+. This project targets MySQL 5.7, so the columns are
-- added through a prepared statement whose text is assembled from
-- INFORMATION_SCHEMA. That keeps the migration idempotent — if a
-- partial run left some columns in place but the INSERT into
-- schema_migrations rolled back, re-running adds exactly the columns
-- that are still missing and no-ops on the rest.
SET @parts := CONCAT_WS(', ',
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'etl_runs'
         AND COLUMN_NAME  = 'download_bytes_done'),
     NULL,
     'ADD COLUMN download_bytes_done BIGINT UNSIGNED NULL AFTER ip2region_built_at'),
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'etl_runs'
         AND COLUMN_NAME  = 'download_bytes_total'),
     NULL,
     'ADD COLUMN download_bytes_total BIGINT UNSIGNED NULL AFTER download_bytes_done'),
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'etl_runs'
         AND COLUMN_NAME  = 'insert_rows_done'),
     NULL,
     'ADD COLUMN insert_rows_done BIGINT UNSIGNED NULL AFTER download_bytes_total'),
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'etl_runs'
         AND COLUMN_NAME  = 'insert_rows_total'),
     NULL,
     'ADD COLUMN insert_rows_total BIGINT UNSIGNED NULL AFTER insert_rows_done'),
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'etl_runs'
         AND COLUMN_NAME  = 'current_stage'),
     NULL,
     "ADD COLUMN current_stage ENUM('download','parse','insert','swap','done') NULL AFTER insert_rows_total"),
  IF(EXISTS(
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'etl_runs'
         AND COLUMN_NAME  = 'progress_updated_at'),
     NULL,
     'ADD COLUMN progress_updated_at DATETIME(3) NULL AFTER current_stage')
);
SET @sql := IF(@parts = '', 'SELECT 1', CONCAT('ALTER TABLE etl_runs ', @parts));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
