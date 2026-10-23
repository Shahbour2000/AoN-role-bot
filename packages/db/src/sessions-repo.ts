import type { Db } from './db.js';

export interface SessionRow { tokenHash: string; discordUserId: string; username: string; avatar: string | null; accessTokenEnc: string; csrfToken: string; expiresAt: Date }

export async function createSessionRow(db: Db, s: Omit<SessionRow, 'expiresAt'> & { ttlMs: number; now: Date }): Promise<void> {
  await db.query(`INSERT INTO dashboard_sessions (token_hash, discord_user_id, username, avatar, access_token_enc, csrf_token, created_at, expires_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [s.tokenHash, s.discordUserId, s.username, s.avatar, s.accessTokenEnc, s.csrfToken, s.now.toISOString(), new Date(s.now.getTime() + s.ttlMs).toISOString()]);
}
export async function getSessionRow(db: Db, tokenHash: string, now: Date): Promise<SessionRow | null> {
  const { rows } = await db.query<{ token_hash: string; discord_user_id: string; username: string; avatar: string | null; access_token_enc: string; csrf_token: string; expires_at: Date }>(
    'SELECT * FROM dashboard_sessions WHERE token_hash=$1 AND expires_at > $2::timestamptz', [tokenHash, now.toISOString()]);
  const r = rows[0];
  return r ? { tokenHash: r.token_hash, discordUserId: r.discord_user_id, username: r.username, avatar: r.avatar, accessTokenEnc: r.access_token_enc, csrfToken: r.csrf_token, expiresAt: r.expires_at } : null;
}
export async function deleteSessionRow(db: Db, tokenHash: string): Promise<void> { await db.query('DELETE FROM dashboard_sessions WHERE token_hash=$1', [tokenHash]); }
export async function purgeExpiredSessions(db: Db, now: Date): Promise<number> {
  return (await db.query('DELETE FROM dashboard_sessions WHERE expires_at <= $1::timestamptz RETURNING 1', [now.toISOString()])).rows.length;
}
