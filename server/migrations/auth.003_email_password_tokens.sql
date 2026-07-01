-- Single-use email verification tokens (plaintext token stored; short-lived).
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  token       CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_evt_user_pending (user_id, used_at, expires_at),
  KEY idx_evt_expires (expires_at),
  CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Password reset tokens. We store the SHA-256 HASH of the token, never the
-- plaintext — if the DB leaks, the emailed reset links are not usable.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL DEFAULT NULL,
  ip_address  VARCHAR(64)  NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_prt_user_pending (user_id, used_at, expires_at),
  KEY idx_prt_expires (expires_at),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staged email changes — re-verify the NEW address before it takes effect.
CREATE TABLE IF NOT EXISTS pending_email_changes (
  id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  new_email   VARCHAR(100) NOT NULL,
  token       CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pec_user_pending (user_id, used_at, expires_at),
  KEY idx_pec_expires (expires_at),
  CONSTRAINT fk_pec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
