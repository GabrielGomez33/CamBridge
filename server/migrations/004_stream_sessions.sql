-- Durability backstop for streaming links so a server restart / deploy does not
-- invalidate active links. In-memory remains the hot path; this is loaded on
-- boot and written on create / delete only. Live peer state is NOT persisted.
CREATE TABLE IF NOT EXISTS stream_sessions (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  passcode       VARCHAR(16)  NOT NULL,
  title          VARCHAR(120) NOT NULL DEFAULT '',
  owner_user_id  INT          NULL,
  created_at     BIGINT       NOT NULL,  -- epoch ms (matches Date.now())
  KEY idx_stream_sessions_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
