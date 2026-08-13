CREATE TABLE IF NOT EXISTS ip_ranges (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  start_ip BINARY(16) NOT NULL,
  end_ip   BINARY(16) NOT NULL,
  country_code CHAR(2) NULL,
  country_name VARCHAR(64) NULL,
  region      VARCHAR(64) NULL,
  city        VARCHAR(128) NULL,
  postal_code VARCHAR(32) NULL,
  latitude    DECIMAL(9,6) NULL,
  longitude   DECIMAL(9,6) NULL,
  timezone    VARCHAR(64) NULL,
  isp         VARCHAR(128) NULL,
  asn         INT UNSIGNED NULL,
  asn_org     VARCHAR(128) NULL,
  country_source VARCHAR(16) NULL,
  city_source    VARCHAR(16) NULL,
  isp_source     VARCHAR(16) NULL,
  asn_source     VARCHAR(16) NULL,
  geo_source     VARCHAR(16) NULL,
  INDEX idx_start_end (start_ip, end_ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ip_ranges_new LIKE ip_ranges;

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
