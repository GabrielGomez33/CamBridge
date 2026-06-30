-- Server-side sessions backing every JWT. A token is only valid while its
-- session row is present, unexpired, and not revoked (logout flips revoked=1).
CREATE TABLE IF NOT EXISTS user_sessions (
  id                  INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL,
  session_id          CHAR(64)     NOT NULL UNIQUE,
  user_agent          VARCHAR(255) NULL,
  ip_address          VARCHAR(64)  NULL,
  device_fingerprint  VARCHAR(255) NULL,
  expires_at          DATETIME     NOT NULL,
  revoked             TINYINT(1)   NOT NULL DEFAULT 0,
  revoked_at          DATETIME     NULL DEFAULT NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_sessions (user_id, revoked, expires_at),
  CONSTRAINT fk_user_sessions FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
