import { expect } from "vitest";
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import type { Db } from '../src/index.js';
import { createPgDb, migrate } from '../src/index.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adapt(pg: any, inTx = false): Db {
  return {
    async query(sql, params) {
      if (params === undefined) { const res = await pg.exec(sql); return { rows: (res[res.length - 1]?.rows ?? []) as never }; }
      return { rows: (await pg.query(sql, params)).rows as never };
    },
    async tx(fn) {
      if (inTx) return fn(adapt(pg, true)); // already inside a transaction
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return pg.transaction(async (tx: any) => fn(adapt(tx, true)));
    },
  };
}

/**
 * Backend selection: PGlite by default; set TEST_DATABASE_URL (a superuser URL) to run the SAME tests on a real
 * PostgreSQL server. Each call gets its own freshly created database, so tests never share state.
 */
let dbCounter = 0;
/** An EMPTY database (no migrations applied), on the same backend selection as freshDb. */
export async function emptyDb(): Promise<Db> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) return adapt(new PGlite());
  const admin = createPgDb(url, { max: 1 });
  const name = `aon_t_${process.pid}_${Date.now()}_${dbCounter++}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const u = new URL(url); u.pathname = `/${name}`;
  return createPgDb(u.toString(), { max: 4 });
}
export async function freshDb(): Promise<Db> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    const db = adapt(new PGlite());
    await migrate(db, MIGRATIONS_DIR);
    return db;
  }
  const admin = createPgDb(url, { max: 1 });
  const name = `aon_t_${process.pid}_${Date.now()}_${dbCounter++}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const u = new URL(url); u.pathname = `/${name}`;
  const db = createPgDb(u.toString(), { max: 4 });
  await migrate(db, MIGRATIONS_DIR);
  return db;
}
export async function addGuild(db: Db, id: string) {
  await db.query('INSERT INTO guilds (guild_id, name) VALUES ($1,$2)', [id, `Guild ${id}`]);
}
export const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };
