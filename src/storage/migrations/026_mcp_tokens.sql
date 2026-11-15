-- SPDX-License-Identifier: MIT
-- MCP tokens authenticate an AI client to the MCP server. They are
-- deliberately a separate entity from api_keys: an MCP token can read
-- operational data (queue depths, query logs, user emails), so it needs
-- an administrator's approval before it works. api_keys stay self-serve.
--
-- status: pending  -> approved | rejected
--         approved -> revoked
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  token_prefix CHAR(12) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  scope VARCHAR(16) NOT NULL DEFAULT 'lookup',
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  decided_by BIGINT UNSIGNED NULL,
  decision_note VARCHAR(255) NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_user (user_id),
  INDEX idx_status (status),
  INDEX idx_active (status, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
