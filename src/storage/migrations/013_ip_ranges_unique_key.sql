-- SPDX-License-Identifier: MIT
-- Adds a UNIQUE KEY on (start_ip, end_ip) so the streaming upsert path in
-- the ETL can dedupe rows from multiple DB-IP files (city / country / asn)
-- via INSERT ... ON DUPLICATE KEY UPDATE without ever materialising the
-- full row set in JS memory.
--
-- Assumption: both tables already have unique (start_ip, end_ip) rows. The
-- ETL TRUNCATEs ip_ranges_new every run and the in-memory merger output
-- (used before streaming was added) was already unique by construction.
--
-- The ALTER bumps tmp_table_size for this session because building a 7M+
-- row unique index via COPY otherwise spills past the default 16 MB tmp
-- table and OOMs mysqld.

SET SESSION tmp_table_size = 1024 * 1024 * 256;
SET SESSION max_heap_table_size = 1024 * 1024 * 256;

ALTER TABLE ip_ranges
  ADD UNIQUE KEY uniq_start_end (start_ip, end_ip),
  ALGORITHM=COPY, LOCK=SHARED;

ALTER TABLE ip_ranges_new
  ADD UNIQUE KEY uniq_start_end (start_ip, end_ip),
  ALGORITHM=COPY, LOCK=SHARED;