-- CamBridge users — trimmed from the proven mirror-server shape (auth core only).
CREATE TABLE IF NOT EXISTS users (
  id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(50)  NOT NULL UNIQUE,
  email           VARCHAR(100) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
  account_locked  TINYINT(1)   NOT NULL DEFAULT 0,
  locked_until    TIMESTAMP    NULL DEFAULT NULL,
  role            VARCHAR(20)  NOT NULL DEFAULT 'user',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login      TIMESTAMP    NULL DEFAULT NULL,
  last_active     TIMESTAMP    NULL DEFAULT NULL,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
