-- SPDX-License-Identifier: MIT
-- Adds a `range_size` BIGINT UNSIGNED column so the lookup query can
-- ORDER BY a real numeric expression. The legacy ORDER BY (end_ip -
-- start_ip) returns 0 for every BINARY(16) row because MySQL's binary
-- arithmetic on BINARY produces a BINARY result that compares equal to
-- every other zero-padded BINARY — effectively a no-op sort. The bug was
-- hidden when the only data came from a single source with uniformly
-- small ranges; mixing city / country / asn slices introduced larger
-- ranges that intermittently surfaced above the smaller correct match.

SET SESSION tmp_table_size = 1024 * 1024 * 256;
SET SESSION max_heap_table_size = 1024 * 1024 * 256;

ALTER TABLE ip_ranges
  ADD COLUMN range_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD INDEX idx_range_size (range_size),
  ALGORITHM=COPY, LOCK=SHARED;

ALTER TABLE ip_ranges_new
  ADD COLUMN range_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD INDEX idx_range_size (range_size),
  ALGORITHM=COPY, LOCK=SHARED;