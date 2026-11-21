-- SPDX-License-Identifier: MIT
-- Export jobs for the .ipq range export (/admin/ranges).
--
-- A library-sized export writes around two gigabytes, and it takes long
-- enough that a proxy in front of the server times the request out. The
-- export therefore runs detached from the request that asked for it, and
-- this table is what both the page and a later operator read to find out
-- whether it finished.
--
-- The list used to be a Map inside the route module. A restart emptied it
-- while the files stayed on disk, so a link that had worked stopped
-- working and the page could no longer say what had been exported. A row
-- survives the restart.
--
-- filename holds the name of the written file, not a path: the install's
-- data directory can move between runs, and a path stored here would then
-- point nowhere. The path is rebuilt from the data directory on read.
CREATE TABLE IF NOT EXISTS range_exports (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL DEFAULT '',
  country_code VARCHAR(8) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(255) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  INDEX idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
