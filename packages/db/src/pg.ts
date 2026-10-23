import pg from 'pg';
import type { Db } from './db.js';

/**
 * Production adapter over node-postgres.
 * - `query` without params uses the simple protocol (needed for multi-statement migrations).
 * - `tx` pins one connection for BEGIN..COMMIT; nested `tx` joins the outer transaction.
 */
export function createPgDb(connectionString: string, opts: { max?: number; ssl?: boolean } = {}): Db & { close(): Promise<void>; ping(): Promise<boolean> } {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 5, ...(opts.ssl ? { ssl: { rejectUnauthorized: true } } : {}), statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => undefined); // idle-client errors must not crash the process

  const wrap = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }, inTx: boolean): Db => ({
    async query(sql, params) { return { rows: (await q.query(sql, params)).rows as never }; },
    async tx(fn) {
      if (inTx) return fn(wrap(q, true));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client, true));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally { client.release(); }
    },
  });
  return {
    ...wrap(pool, false),
    close: () => pool.end(),
    ping: async () => { try { await pool.query('SELECT 1'); return true; } catch { return false; } },
  };
}
