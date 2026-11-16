-- SPDX-License-Identifier: MIT
-- Slow the random-IP ingest to twenty runs an hour, one IP per run.
--
-- The old defaults (every 60s, ten IPs per run) were 600 addresses an hour,
-- each asking EVERY provider — 2,400 provider calls an hour in total. The
-- free tiers are measured per calendar minute and the queue-driven backfill
-- needs the same quota for its votes, so the random generator was draining
-- it before the backfill that actually needs several opinions got a turn.
--
-- Two changes make the same job cost a fraction:
--   * one IP per run (the generator now rotates providers instead of
--     fanning out to all of them), and
--   * one run every three minutes.
--
-- The values below are the new defaults. An operator who has deliberately
-- tuned these keeps their choice: the WHERE clause only touches rows still
-- holding the OLD defaults.

UPDATE settings SET v = '180'
 WHERE k = 'random_gen_interval_sec' AND v = '60';

UPDATE settings SET v = '1'
 WHERE k = 'random_gen_batch_size' AND v = '10';
