-- SPDX-License-Identifier: MIT
-- Custom HTTP providers: lets admins register an arbitrary IP-info
-- endpoint at runtime via /admin/unknown-ips without touching TS code.
-- Shape: URL template with {ip}/{apiKey} placeholders + dot-path field
-- mapping. is_custom=1 dispatches to GenericHttpProvider; is_custom=0
-- keeps using the hard-coded Provider classes (existing 5).
ALTER TABLE ingest_providers
  ADD COLUMN is_custom TINYINT(1) NOT NULL DEFAULT 0 AFTER display_name,
  ADD COLUMN custom_url_template VARCHAR(512) NULL AFTER is_custom,
  ADD COLUMN custom_method ENUM('GET','POST') NOT NULL DEFAULT 'GET' AFTER custom_url_template,
  ADD COLUMN custom_request_body TEXT NULL AFTER custom_method,
  ADD COLUMN custom_response_format ENUM('json','text') NOT NULL DEFAULT 'json' AFTER custom_request_body,
  ADD COLUMN custom_country_path VARCHAR(128) NULL AFTER custom_response_format,
  ADD COLUMN custom_city_path VARCHAR(128) NULL AFTER custom_country_path,
  ADD COLUMN custom_asn_path VARCHAR(128) NULL AFTER custom_city_path,
  ADD COLUMN custom_timeout_ms INT UNSIGNED NULL AFTER custom_asn_path,
  ADD COLUMN custom_rate_limit_per_min INT UNSIGNED NULL AFTER custom_timeout_ms,
  ADD INDEX idx_custom (is_custom);
