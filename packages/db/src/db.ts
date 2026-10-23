/** Minimal driver-agnostic interface (implemented for `pg` in production and PGlite in tests). */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs fn inside BEGIN/COMMIT; rolls back on throw. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}
