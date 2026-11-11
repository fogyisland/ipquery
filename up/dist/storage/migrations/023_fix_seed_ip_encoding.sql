-- SPDX-License-Identifier: MIT
--
-- Repairs the seeded rows written by migration 012.
--
-- migration 012 stored each seeded IPv4 address as UNHEX('08080808') —
-- four bytes, left-aligned inside the BINARY(16) column. Every runtime
-- path (parseIp() in src/ip.ts, the DB-IP and MaxMind parsers, and
-- findRange()'s query parameter) stores an IPv4 address as sixteen
-- bytes with the address in the LAST four positions.
--
-- MySQL compares the zero-padded values, so the left-aligned form
-- sorted BELOW the right-aligned form and no query could ever match
-- it. Every seeded IP was unreachable through /lookup: 8.8.8.8 was in
-- the seed data and still returned "not found".
--
-- migration 012 itself has been corrected for fresh installs. This
-- migration fixes databases that already ran it. On a fresh install
-- migration 012 inserted the correct bytes, so the UPDATE below finds
-- nothing to change and the migration is a no-op.
--
-- The rewrite is targeted at rows whose country_source is 'seed' AND
-- whose bytes sit in the first four positions with twelve zero bytes
-- behind them — exactly the buggy left-aligned encoding. ETL and
-- backfill rows are written by parseIp() and are never in that form,
-- and they are excluded by the country_source filter regardless.
--
-- The seed rows' range_size is left alone. findRange() now ranks a
-- real ETL row above a seed row explicitly (see the country_source
-- check in src/storage/mysql.ts), because range_size alone cannot
-- express the priority: a seed row is a single address (range_size 0)
-- and would otherwise beat every real range covering it.
--
-- A sentinel range_size was tried and rejected — 2^64-1 is the widest
-- value a BIGINT UNSIGNED holds, and mysql2 returns BIGINTs as
-- JavaScript numbers, so it comes back as 1.8446744073709552e19 and
-- BigInt() of that is 2^64 rather than 2^64-1. Ranking by source
-- avoids depending on a value that cannot survive the round trip.

SET SESSION tmp_table_size = 1024 * 1024 * 256;
SET SESSION max_heap_table_size = 1024 * 1024 * 256;

UPDATE ip_ranges
   SET start_ip = CONCAT(REPEAT(UNHEX('00'), 12), SUBSTRING(start_ip, 1, 4)),
       end_ip   = CONCAT(REPEAT(UNHEX('00'), 12), SUBSTRING(end_ip,   1, 4))
 WHERE country_source = 'seed'
   AND start_ip = CONCAT(SUBSTRING(start_ip, 1, 4), REPEAT(UNHEX('00'), 12));
