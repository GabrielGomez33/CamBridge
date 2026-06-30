import mysql from 'mysql2/promise';
import { config } from './config';

// Connection pool — mirrors the proven mirror-server pool configuration.
export const DB = mysql.createPool({
  host: config.db.host,
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  waitForConnections: true,
  connectionLimit: config.db.poolSize,
  queueLimit: 100,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
  maxIdle: 10,
  idleTimeout: 60_000,
});

/** True if the database is reachable (used by /health and startup). */
export async function dbHealthy(): Promise<boolean> {
  try {
    const conn = await DB.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch {
    return false;
  }
}
