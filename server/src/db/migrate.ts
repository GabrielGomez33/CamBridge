import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DB } from '../db';
import { logger } from '../logger';
import { config } from '../config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Tiny forward-only migration runner. Applies each `*.sql` file in order exactly
 * once, tracking applied files in `schema_migrations`. Files are namespaced by
 * purpose: `core.*` always run; `auth.*` run ONLY when accounts are enabled (so
 * a persistence-only deployment never creates the auth tables / their FKs).
 */
export async function runMigrations(): Promise<void> {
  await DB.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name VARCHAR(191) NOT NULL PRIMARY KEY,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const [rows] = await DB.query<import('mysql2').RowDataPacket[]>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name as string));

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => config.authEnabled || !f.startsWith('auth.'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Strip `--` line comments BEFORE splitting on `;` — a comment may itself
    // contain a semicolon, which would otherwise chop it into invalid SQL.
    const statements = sql
      .split('\n')
      .map((line) => {
        const i = line.indexOf('--');
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const conn = await DB.getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of statements) await conn.query(stmt);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      await conn.commit();
      logger.info({ migration: file, statements: statements.length }, 'migration applied');
    } catch (err) {
      await conn.rollback();
      logger.error({ err, migration: file }, 'migration failed');
      throw err;
    } finally {
      conn.release();
    }
  }
}
