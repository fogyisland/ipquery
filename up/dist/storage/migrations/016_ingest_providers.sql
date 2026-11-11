-- SPDX-License-Identifier: MIT
-- ingest_providers: admin-tunable configuration for the IP-geolocation
-- providers that the /admin/unknown-ips backfill fan-out consults.
--
-- Why a table (vs. env-only or a code list):
--  - Lets the admin toggle a provider on/off and rotate its API key from
--    the admin UI without a server restart.
--  - Lets us surface per-provider quota + last-used info to the admin so
--    they can see "ipinfo has been throttled 12× today".
--  - Keeps a stable row per provider so analytics queries (e.g. "which
--    provider has the best hit rate") don't have to JOIN a code list.
--
-- `name` is the stable identifier and primary key — adding a new
-- provider requires a code change AND a row insert, never just one.

CREATE TABLE IF NOT EXISTS ingest_providers (
  name VARCHAR(32) PRIMARY KEY,
  -- Display label + free-tier blurb shown on /admin/unknown-ips. Not
  -- editable from the UI today; lives in code (see CATALOG in
  -- src/storage/ingestProviders.ts) and seeded by INSERT below.
  display_name VARCHAR(64) NOT NULL,
  free_quota VARCHAR(128) NOT NULL,
  -- Whether the backfill job should consult this provider. Disabling
  -- skips the call entirely — useful when the admin knows the key is
  -- expired or quota is exhausted.
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  -- Optional bearer / api-key. NULL for key-less providers. Stored in
  -- plaintext for now because the app's threat model treats DB access as
  -- already-trusted (admin can see all keys anyway). If we ever expose
  -- this to non-admin roles, switch to AES-GCM with a KMS-wrapped key.
  api_key VARCHAR(255) NULL,
  -- Soft override for the per-provider rate limiter. NULL = use the
  -- provider class's default (45/min for ip-api, etc.).
  rate_limit_per_min INT UNSIGNED NULL,
  -- Bookkeeping for the admin dashboard. NOT used to gate requests.
  last_used_at DATETIME(3) NULL,
  last_error_at DATETIME(3) NULL,
  last_error_reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the five providers we know about today. If the catalog grows,
-- add a new INSERT in the migration that follows this one. The admin
-- UI only flips enabled / api_key from here on.
INSERT IGNORE INTO ingest_providers (name, display_name, free_quota) VALUES
  ('ip-api',     'IP-API',         '45 req/min, no key (HTTP only)'),
  ('iplocate',   'IPLocate.io',    '1,000 req/day, key required (HTTPS)'),
  ('ipinfo',     'IPinfo.io',      '50,000 req/month, key required (HTTPS)'),
  ('freeipapi',  'FreeIPAPI',      '60 req/min, no key (HTTPS)'),
  ('ipapi-co',   'ipapi.co',       '30,000 req/month, no key (HTTPS)');