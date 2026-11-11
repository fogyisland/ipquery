-- SPDX-License-Identifier: MIT
CREATE TABLE IF NOT EXISTS query_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip VARBINARY(16) NOT NULL,
  ip_text VARCHAR(45) NOT NULL,
  status ENUM('hit','miss','invalid') NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  api_key_id BIGINT UNSIGNED NULL,
  session_id CHAR(32) NULL,
  remote_addr VARBINARY(16) NULL,
  user_agent VARCHAR(255) NULL,
  INDEX idx_user_ts (user_id, ts),
  INDEX idx_ts (ts),
  INDEX idx_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
