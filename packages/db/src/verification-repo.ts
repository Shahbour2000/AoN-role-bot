import { randomUUID } from 'node:crypto';
import { generateVerificationCode, hashVerificationCode, VERIFICATION } from '@aon/core';
import { audit } from './audit.js';
import type { Db } from './db.js';
import { ensureGuildLinkTx, isProof, unlinkGlobalTx, type GlobalMethod, type GlobalUnlinkResult } from './global-links-repo.js';

export type AttemptStatus = 'pending' | 'verified' | 'expired' | 'cancelled' | 'locked' | 'superseded';
export interface Attempt { id: string; guildId: string; discordUserId: string; playerId: string; playerUsername: string | null; codeHash: string; status: AttemptStatus; createdAt: Date; expiresAt: Date; checkCount: number; lastCheckAt: Date | null; lastResult: string | null }
interface Row { id: string; guild_id: string; discord_user_id: string; player_id: string; player_username: string | null; code_hash: string; status: AttemptStatus; created_at: Date; expires_at: Date; check_count: number; last_check_at: Date | null; last_result: string | null }
const map = (r: Row): Attempt => ({ id: r.id, guildId: r.guild_id, discordUserId: r.discord_user_id, playerId: r.player_id, playerUsername: r.player_username, codeHash: r.code_hash, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, checkCount: r.check_count, lastCheckAt: r.last_check_at, lastResult: r.last_result });
const isUnique = (e: unknown) => /unique|duplicate/i.test(e instanceof Error ? e.message : '');

export type CreateResult =
  | { ok: true; attemptId: string; code: string; expiresAt: Date }
  | { ok: false; code: 'ALREADY_LINKED_SELF' | 'USER_LINKED_OTHER' | 'PLAYER_LINKED_OTHER' | 'RATE_LIMITED'; existingPlayerId?: string };

/** Opens (or replaces) the member's verification attempt. The plaintext code exists only in the returned value: the database gets its hash. */
export async function createAttempt(db: Db, a: { guildId: string; discordUserId: string; playerId: string; username: string | null; now?: Date; rand?: (max: number) => number }): Promise<CreateResult> {
  const now = a.now ?? new Date();
  try {
    return await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`verify:${a.discordUserId}`]);      // one opener per member at a time
      const mine = (await t.query<{ player_id: string }>(`SELECT player_id FROM global_links WHERE status='active' AND discord_user_id=$1`, [a.discordUserId])).rows[0];
      if (mine) return { ok: false, code: mine.player_id === a.playerId ? 'ALREADY_LINKED_SELF' : 'USER_LINKED_OTHER', existingPlayerId: mine.player_id } as const;
      const owner = (await t.query<{ method: GlobalMethod }>(`SELECT method FROM global_links WHERE status='active' AND player_id=$1`, [a.playerId])).rows[0];
      if (owner && isProof(owner.method)) return { ok: false, code: 'PLAYER_LINKED_OTHER' } as const;      // a proven link is never displaced here
      const since = new Date(now.getTime() - 24 * 3_600_000);
      const n = Number((await t.query<{ n: string }>('SELECT count(*)::text AS n FROM verification_attempts WHERE discord_user_id=$1 AND created_at > $2', [a.discordUserId, since])).rows[0]!.n);
      if (n >= VERIFICATION.maxAttemptsPerDay) return { ok: false, code: 'RATE_LIMITED' } as const;
      await t.query(`UPDATE verification_attempts SET status='superseded', closed_at=$2, close_reason='replaced by a new attempt' WHERE discord_user_id=$1 AND status='pending'`, [a.discordUserId, now]);
      const id = randomUUID(); const code = generateVerificationCode(a.rand); const expiresAt = new Date(now.getTime() + VERIFICATION.ttlMs);
      await t.query(`INSERT INTO verification_attempts (id, guild_id, discord_user_id, player_id, player_username, code_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.guildId, a.discordUserId, a.playerId, a.username, hashVerificationCode(id, code), now, expiresAt]);
      await audit(t, { guildId: a.guildId, actor: a.discordUserId, action: 'verification.opened', target: a.playerId, details: { attemptId: id } });
      return { ok: true, attemptId: id, code, expiresAt } as const;
    });
  } catch (e) { if (isUnique(e)) return { ok: false, code: 'RATE_LIMITED' }; throw e; }
}

export async function getAttempt(db: Db, id: string): Promise<Attempt | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query<Row>('SELECT * FROM verification_attempts WHERE id=$1', [id]);
  return rows[0] ? map(rows[0]) : null;
}
export async function getPendingAttemptForUser(db: Db, discordUserId: string, now: Date = new Date()): Promise<Attempt | null> {
  const { rows } = await db.query<Row>(`SELECT * FROM verification_attempts WHERE discord_user_id=$1 AND status='pending' AND expires_at > $2`, [discordUserId, now]);
  return rows[0] ? map(rows[0]) : null;
}

export type CheckGate = { ok: true; attempt: Attempt } | { ok: false; code: 'NOT_FOUND' | 'NOT_PENDING' | 'EXPIRED' | 'LOCKED' | 'TOO_SOON'; retryAfterMs?: number };
/** Gate in front of every game-API check: owner only, still pending, not expired, within the check limit and the minimum interval. Counts the check. */
export async function beginCheck(db: Db, a: { attemptId: string; discordUserId: string; now?: Date }): Promise<CheckGate> {
  const now = a.now ?? new Date();
  if (!/^[0-9a-f-]{36}$/i.test(a.attemptId)) return { ok: false, code: 'NOT_FOUND' };
  return db.tx(async (t) => {
    const r = (await t.query<Row>('SELECT * FROM verification_attempts WHERE id=$1 AND discord_user_id=$2 FOR UPDATE', [a.attemptId, a.discordUserId])).rows[0];   // somebody else's id is simply "not found"
    if (!r) return { ok: false, code: 'NOT_FOUND' } as const;
    if (r.status !== 'pending') return { ok: false, code: 'NOT_PENDING' } as const;
    if (r.expires_at.getTime() <= now.getTime()) {
      await t.query(`UPDATE verification_attempts SET status='expired', closed_at=$2, close_reason='expired' WHERE id=$1`, [r.id, now]);
      await audit(t, { guildId: r.guild_id, actor: r.discord_user_id, action: 'verification.expired', target: r.player_id, details: { attemptId: r.id } });
      return { ok: false, code: 'EXPIRED' } as const;
    }
    if (r.check_count >= VERIFICATION.maxChecks) {
      await t.query(`UPDATE verification_attempts SET status='locked', closed_at=$2, close_reason='too many checks' WHERE id=$1`, [r.id, now]);
      await audit(t, { guildId: r.guild_id, actor: r.discord_user_id, action: 'verification.locked', target: r.player_id, details: { attemptId: r.id } });
      return { ok: false, code: 'LOCKED' } as const;
    }
    if (r.last_check_at && now.getTime() - r.last_check_at.getTime() < VERIFICATION.minCheckIntervalMs) return { ok: false, code: 'TOO_SOON', retryAfterMs: VERIFICATION.minCheckIntervalMs - (now.getTime() - r.last_check_at.getTime()) } as const;
    await t.query('UPDATE verification_attempts SET check_count=check_count+1, last_check_at=$2 WHERE id=$1', [r.id, now]);
    return { ok: true, attempt: map({ ...r, check_count: r.check_count + 1, last_check_at: now }) } as const;
  });
}
/** Records why a check did not verify; an API outage does not use up one of the member's checks. */
export async function endCheck(db: Db, attemptId: string, result: 'code_not_found' | 'api_down' | 'player_missing' | 'incomplete_data'): Promise<void> {
  await db.query(`UPDATE verification_attempts SET last_result=$2, check_count = CASE WHEN $2 IN ('api_down','incomplete_data') THEN GREATEST(check_count-1,0) ELSE check_count END WHERE id=$1 AND status='pending'`, [attemptId, result]);
}

export async function cancelAttempt(db: Db, a: { attemptId: string; discordUserId: string; now?: Date }): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(a.attemptId)) return false;
  return db.tx(async (t) => {
    const { rows } = await t.query<{ guild_id: string; player_id: string }>(`UPDATE verification_attempts SET status='cancelled', closed_at=$3, close_reason='closed by the member' WHERE id=$1 AND discord_user_id=$2 AND status='pending' RETURNING guild_id, player_id`, [a.attemptId, a.discordUserId, a.now ?? new Date()]);
    if (rows[0]) await audit(t, { guildId: rows[0].guild_id, actor: a.discordUserId, action: 'verification.cancelled', target: rows[0].player_id, details: { attemptId: a.attemptId } });
    return rows.length > 0;
  });
}

export type CompleteResult =
  | { ok: true; linkId: string; alreadyLinked: boolean; displaced: GlobalUnlinkResult | null }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_PENDING' | 'EXPIRED' | 'USER_LINKED_OTHER' | 'PLAYER_LINKED_OTHER' };
/**
 * Called ONLY after the game API showed the attempt's code in a company of the attempt's player. One transaction: locks the attempt, the
 * global rows of both identities, creates the global link and this server's link, closes the attempt. Concurrent attempts for the same
 * Discord user or game account can never both succeed (partial unique indexes decide; the loser gets a clean refusal).
 */
export async function completeVerification(db: Db, a: { attemptId: string; discordUserId: string; companyId: string | null; now?: Date }): Promise<CompleteResult> {
  const now = a.now ?? new Date();
  try {
    return await db.tx(async (t): Promise<CompleteResult> => {
      const at = (await t.query<Row>('SELECT * FROM verification_attempts WHERE id=$1 AND discord_user_id=$2 FOR UPDATE', [a.attemptId, a.discordUserId])).rows[0];
      if (!at) return { ok: false, code: 'NOT_FOUND' };
      if (at.status !== 'pending') return { ok: false, code: 'NOT_PENDING' };
      if (at.expires_at.getTime() <= now.getTime()) return { ok: false, code: 'EXPIRED' };
      const globals = (await t.query<{ id: string; discord_user_id: string; player_id: string; method: GlobalMethod }>(
        `SELECT id, discord_user_id, player_id, method FROM global_links WHERE status='active' AND (discord_user_id=$1 OR player_id=$2) FOR UPDATE`, [at.discord_user_id, at.player_id])).rows;
      const exact = globals.find((g) => g.discord_user_id === at.discord_user_id && g.player_id === at.player_id);
      let displaced: GlobalUnlinkResult | null = null;
      if (!exact) {
        if (globals.some((g) => g.discord_user_id === at.discord_user_id)) return { ok: false, code: 'USER_LINKED_OTHER' };
        const other = globals.find((g) => g.player_id === at.player_id);
        if (other) {
          if (isProof(other.method)) return { ok: false, code: 'PLAYER_LINKED_OTHER' };
          // A real proof of ownership replaces an unproven link (legacy claim / staff approval / forced link). Audited; the caller strips their roles.
          displaced = await unlinkGlobalTx(t, { by: { playerId: at.player_id }, actorId: at.discord_user_id, action: 'link.displaced_by_verification', reason: `verified by company name (attempt ${at.id})`, auditGuildId: at.guild_id });
        }
        await t.query(`INSERT INTO global_links (discord_user_id, player_id, player_username, method, verified_in_guild, attempt_id) VALUES ($1,$2,$3,'company_verified',$4,$5)`, [at.discord_user_id, at.player_id, at.player_username, at.guild_id, at.id]);
      }
      const g = await ensureGuildLinkTx(t, { guildId: at.guild_id, discordUserId: at.discord_user_id });
      await t.query(`UPDATE verification_attempts SET status='verified', closed_at=$2, close_reason='verified', last_result='verified', company_id=$3, displaced_legacy=$4 WHERE id=$1`, [at.id, now, a.companyId, displaced !== null]);
      await audit(t, { guildId: at.guild_id, actor: at.discord_user_id, action: 'verification.verified', target: at.player_id, details: { attemptId: at.id, companyId: a.companyId, alreadyLinked: !!exact, displacedUser: displaced?.discordUserId ?? null } });
      return { ok: true, linkId: g.status === 'no_global_link' ? '' : g.linkId, alreadyLinked: !!exact, displaced };
    });
  } catch (e) {
    if (!isUnique(e)) throw e;
    return { ok: false, code: 'PLAYER_LINKED_OTHER' };       // a concurrent verification took the account first
  }
}

export interface VerificationStats { last30d: Record<AttemptStatus, number>; linkedMembers: { total: number; byMethod: Record<string, number> }; recent: { id: string; discordUserId: string; playerId: string; playerUsername: string | null; status: AttemptStatus; createdAt: Date; checkCount: number; lastResult: string | null }[] }
export async function verificationStats(db: Db, guildId: string, now: Date = new Date()): Promise<VerificationStats> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const st = await db.query<{ status: AttemptStatus; n: string }>('SELECT status, count(*)::text AS n FROM verification_attempts WHERE guild_id=$1 AND created_at > $2 GROUP BY status', [guildId, since]);
  const last30d: Record<AttemptStatus, number> = { pending: 0, verified: 0, expired: 0, cancelled: 0, locked: 0, superseded: 0 };
  for (const r of st.rows) last30d[r.status] = Number(r.n);
  const lm = await db.query<{ method: string; n: string }>(`SELECT g.method, count(*)::text AS n FROM account_links a JOIN global_links g ON g.status='active' AND g.discord_user_id=a.discord_user_id AND g.player_id=a.player_id WHERE a.guild_id=$1 AND a.status IN ('verified','admin_linked') GROUP BY g.method`, [guildId]);
  const byMethod: Record<string, number> = {}; let total = 0;
  for (const r of lm.rows) { byMethod[r.method] = Number(r.n); total += Number(r.n); }
  const rec = await db.query<Row>('SELECT * FROM verification_attempts WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 20', [guildId]);
  return { last30d, linkedMembers: { total, byMethod }, recent: rec.rows.map((r) => ({ id: r.id, discordUserId: r.discord_user_id, playerId: r.player_id, playerUsername: r.player_username, status: r.status, createdAt: r.created_at, checkCount: r.check_count, lastResult: r.last_result })) };
}
