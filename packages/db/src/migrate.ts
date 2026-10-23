import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

export interface MigrationResult { applied: string[]; alreadyApplied: string[] }

/**
 * Applies pending migrations in order, each in its own transaction.
 * - Forward-only: there is no reset, drop or "accept data loss" path.
 * - Tamper-evident: an already-applied migration whose file changed aborts startup.
 */
export async function migrate(db: Db, dir: string): Promise<MigrationResult> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const done = new Map((await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    const prev = done.get(f);
    if (prev !== undefined) {
      if (prev !== sum) throw new Error(`Migration ${f} was modified after being applied. Add a new migration instead.`);
      result.alreadyApplied.push(f);
      continue;
    }
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
    });
    result.applied.push(f);
  }
  return result;
}
