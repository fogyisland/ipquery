-- SPDX-License-Identifier: MIT

CREATE TABLE IF NOT EXISTS etl_runs (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  started_at  DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  status ENUM('running','success','failed') NOT NULL,
  maxmind_records INT UNSIGNED NULL,
  ip2region_records INT UNSIGNED NULL,
  dbip_records INT UNSIGNED NULL,
  merged_records INT UNSIGNED NULL,
  error_message TEXT NULL,
  maxmind_built_at DATETIME NULL,
  ip2region_built_at DATETIME NULL,
  dbip_built_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
