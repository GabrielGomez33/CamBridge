import type { RowDataPacket } from 'mysql2';
import { DB } from './db';

// Durability backstop for streaming links. Only metadata is stored — never live
// peer state. Writes are best-effort: a DB outage degrades to in-memory only.

export interface PersistedSession {
  id: string;
  passcode: string;
  title: string;
  ownerUserId: number | null;
  createdAt: number;
}

export async function insertSession(s: PersistedSession): Promise<void> {
  await DB.query(
    `INSERT INTO stream_sessions (id, passcode, title, owner_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [s.id, s.passcode, s.title, s.ownerUserId, s.createdAt]
  );
}

export async function deleteSession(id: string): Promise<void> {
  await DB.query('DELETE FROM stream_sessions WHERE id = ?', [id]);
}

/** Load links created after `minCreatedAt` (i.e. still within the absolute cap). */
export async function loadSessions(minCreatedAt: number): Promise<PersistedSession[]> {
  const [rows] = await DB.query<RowDataPacket[]>(
    'SELECT id, passcode, title, owner_user_id, created_at FROM stream_sessions WHERE created_at > ?',
    [minCreatedAt]
  );
  return rows.map((r) => ({
    id: r.id as string,
    passcode: r.passcode as string,
    title: r.title as string,
    ownerUserId: (r.owner_user_id as number | null) ?? null,
    createdAt: Number(r.created_at),
  }));
}

/** Best-effort purge of links past the absolute cap. */
export async function purgeExpired(minCreatedAt: number): Promise<void> {
  await DB.query('DELETE FROM stream_sessions WHERE created_at <= ?', [minCreatedAt]);
}
