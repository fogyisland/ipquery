-- SPDX-License-Identifier: MIT
-- Add two ingest providers: ip.sb and ip9.com.cn.
--
-- Migration 028 left the fan-out with ip-api and ipinfo. Two is the
-- minimum a majority can work with, so a single 429 made a round
-- undecidable — the backfill spent its quota and wrote nothing.
--
-- Two providers cover the two halves of the library. ip.sb
-- (api.ip.sb) is a global English source with ASN data: free, no key,
-- 100 req/min with a 5 req/s burst ceiling. ip9 (ip9.com.cn) answers
-- Chinese addresses down to the district, in Chinese, at 60 req/min —
-- precision the English sources do not have. Neither is authoritative
-- alone; the consensus still decides.
--
-- ON DUPLICATE KEY UPDATE keeps this an idempotent re-run without
-- resetting an operator's choice: if the row already exists (someone
-- added it by hand, or the migration is replayed) the enabled flag and
-- any key stay exactly as they are.

INSERT INTO ingest_providers (name, display_name, free_quota) VALUES
  ('ip-sb', 'IP.SB',       '100 req/min (5 req/s), no key (HTTPS)'),
  ('ip9',   'IP9.COM.CN',  '60 req/min, no key (HTTPS), Chinese results')
ON DUPLICATE KEY UPDATE name = name;
