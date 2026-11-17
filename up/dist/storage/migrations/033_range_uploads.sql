-- SPDX-License-Identifier: MIT
-- Resumable uploads for the .ipq range import.
--
-- A whole-library file is around two gigabytes. It cannot be one POST: the
-- body has to be held in memory before a line can be parsed, and a
-- connection that drops part-way costs the whole transfer. So the upload
-- arrives as chunks and is assembled on disk, and `range_upload_chunks`
-- records which byte ranges have landed — which is also what makes an
-- interrupted upload resumable.
--
-- received_bytes is recomputed from those ranges rather than summed, so a
-- repeated chunk cannot double-count.
CREATE TABLE IF NOT EXISTS range_uploads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mode ENUM('merge','replace') NOT NULL DEFAULT 'replace',
  filename VARCHAR(255) NOT NULL DEFAULT '',
  total_bytes BIGINT UNSIGNED NOT NULL,
  received_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  filepath VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'uploading',
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS range_upload_chunks (
  upload_id BIGINT UNSIGNED NOT NULL,
  `offset` BIGINT UNSIGNED NOT NULL,
  length BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (upload_id, `offset`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
