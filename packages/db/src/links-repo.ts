import { audit } from './audit.js';
import type { Db } from './db.js';

export type LinkStatus = 'pending' | 'verified' | 'admin_linked' | 'rejected' | 'unlinked';
export interface LinkRow { id: string; guild_id: string; discord_user_id: string; player_id: string; status: LinkStatus; conflict: boolean; method: string }

export type ClaimResult =
  | { ok: true; linkId: string; conflict: boolean; /** true when the link is active immediately (direct mode) */ direct: boolean }
  | { ok: false; code: 'ALREADY_LINKED_SELF' | 'PLAYER_ALREADY_LINKED' | 'DUPLICATE_PENDING' };

/**
 * /link. Two modes (per guild, `direct` is decided by the caller from the guild setting):
 *  - staff mode (default for existing guilds): creates a PENDING claim; no roles until a moderator approves;
 *  - direct mode (default for new guilds): the link is active immediately, method `self_direct`.
 * Neither mode PROVES ownership of the game account (the game API is read-only): see docs/LINKING.md. A stronger verification
 * can later be added as a new `method` value without changing this table or the sync engine.
 */
async function claimLinkTx(db: Db, a: { guildId: string; discordUserId: string; playerId: string; username: string | null; direct?: boolean }): Promise<ClaimResult> {
  return db.tx(async (t) => {
    const { rows: active } = await t.query<LinkRow>(
      `SELECT * FROM account_links WHERE guild_id=$1 AND status IN ('verified','admin_linked') AND (discord_user_id=$2 OR player_id=$3)`, [a.guildId, a.discordUserId, a.playerId]);
    if (active.some((r) => r.discord_user_id === a.discordUserId)) return { ok: false, code: 'ALREADY_LINKED_SELF' } as const;
    if (active.some((r) => r.player_id === a.playerId)) return { ok: false, code: 'PLAYER_ALREADY_LINKED' } as const;

    if (a.direct) {
      // A pending claim by the same user (left over from staff mode) is superseded; rival pending claims on the player are rejected.
      await t.query(`UPDATE account_links SET status='rejected', reason='superseded by direct link', conflict=false WHERE guild_id=$1 AND status='pending' AND (player_id=$2 OR discord_user_id=$3)`, [a.guildId, a.playerId, a.discordUserId]);
      const { rows } = await t.query<{ id: string }>(
        `INSERT INTO account_links (guild_id, discord_user_id, player_id, player_username, status, method, reviewed_by, reviewed_at)
         VALUES ($1,$2,$3,$4,'verified','self_direct',$2,now()) RETURNING id`, [a.guildId, a.discordUserId, a.playerId, a.username]);
      await audit(t, { guildId: a.guildId, actor: a.discordUserId, action: 'link.direct', target: a.playerId, details: { ownershipProven: false } });
      return { ok: true, linkId: rows[0]!.id, conflict: false, direct: true } as const;
    }
    const { rows: dup } = await t.query(`SELECT 1 FROM account_links WHERE guild_id=$1 AND discord_user_id=$2 AND player_id=$3 AND status='pending'`, [a.guildId, a.discordUserId, a.playerId]);
    if (dup.length) return { ok: false, code: 'DUPLICATE_PENDING' } as const;

    // Competing pending claims on the same player are flagged for staff review (both sides).
    const { rows: rivals } = await t.query<{ id: string }>(`SELECT id FROM account_links WHERE guild_id=$1 AND player_id=$2 AND status='pending'`, [a.guildId, a.playerId]);
    const conflict = rivals.length > 0;
    if (conflict) await t.query(`UPDATE account_links SET conflict=true WHERE guild_id=$1 AND player_id=$2 AND status='pending'`, [a.guildId, a.playerId]);

    const { rows } = await t.query<{ id: string }>(
      `INSERT INTO account_links (guild_id, discord_user_id, player_id, player_username, status, method, conflict)
       VALUES ($1,$2,$3,$4,'pending','self_claim',$5) RETURNING id`, [a.guildId, a.discordUserId, a.playerId, a.username, conflict]);
    await audit(t, { guildId: a.guildId, actor: a.discordUserId, action: 'link.claimed', target: a.playerId, details: { conflict } });
    return { ok: true, linkId: rows[0]!.id, conflict, direct: false } as const;
  });
}

export async function claimLink(db: Db, a: { guildId: string; discordUserId: string; playerId: string; username: string | null; direct?: boolean }): Promise<ClaimResult> {
  try { return await claimLinkTx(db, a); }
  catch (e) {
    // Two members racing for the same account (or one member double-clicking): the unique indexes decide; report it as the clean refusal it is.
    if (!/unique|duplicate/i.test(e instanceof Error ? e.message : '')) throw e;
    const { rows } = await db.query<{ discord_user_id: string }>(`SELECT discord_user_id FROM account_links WHERE guild_id=$1 AND status IN ('verified','admin_linked') AND (discord_user_id=$2 OR player_id=$3)`, [a.guildId, a.discordUserId, a.playerId]);
    return { ok: false, code: rows.some((r) => r.discord_user_id === a.discordUserId) ? 'ALREADY_LINKED_SELF' : 'PLAYER_ALREADY_LINKED' };
  }
}

export type ReviewResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_PENDING' | 'PLAYER_ALREADY_LINKED' | 'USER_ALREADY_LINKED' };

/** Staff approval. Authorisation (Manage Server etc.) is enforced by the caller BEFORE this runs. */
export async function reviewLink(db: Db, a: { guildId: string; linkId: string; reviewerId: string; approve: boolean; reason?: string }): Promise<ReviewResult> {
  return db.tx(async (t) => {
    const { rows } = await t.query<LinkRow>('SELECT * FROM account_links WHERE id=$1 AND guild_id=$2 FOR UPDATE', [a.linkId, a.guildId]); // guild_id in WHERE: cross-guild ids resolve to NOT_FOUND
    const link = rows[0];
    if (!link) return { ok: false, code: 'NOT_FOUND' } as const;
    if (link.status !== 'pending') return { ok: false, code: 'NOT_PENDING' } as const;
    if (a.approve) {
      const { rows: clash } = await t.query<LinkRow>(`SELECT * FROM account_links WHERE guild_id=$1 AND status IN ('verified','admin_linked') AND (player_id=$2 OR discord_user_id=$3)`, [a.guildId, link.player_id, link.discord_user_id]);
      if (clash.some((c) => c.player_id === link.player_id)) return { ok: false, code: 'PLAYER_ALREADY_LINKED' } as const;
      if (clash.length) return { ok: false, code: 'USER_ALREADY_LINKED' } as const;
    }
    await t.query(`UPDATE account_links SET status=$1, method=CASE WHEN $1='verified' THEN 'staff_approved' ELSE method END, reviewed_by=$2, reviewed_at=now(), reason=$3, conflict=false WHERE id=$4`,
      [a.approve ? 'verified' : 'rejected', a.reviewerId, a.reason ?? null, a.linkId]);
    if (a.approve) { // competing pending claims on that player are auto-rejected
      await t.query(`UPDATE account_links SET status='rejected', reviewed_by=$1, reviewed_at=now(), reason='player linked to another user', conflict=false WHERE guild_id=$2 AND player_id=$3 AND status='pending' AND id<>$4`, [a.reviewerId, a.guildId, link.player_id, a.linkId]);
    }
    await audit(t, { guildId: a.guildId, actor: a.reviewerId, action: a.approve ? 'link.approved' : 'link.rejected', target: link.player_id, details: { linkId: a.linkId, reason: a.reason ?? null } });
    return { ok: true } as const;
  });
}

export type ForceResult = { ok: true; replaced: string[] } | { ok: false; code: 'CONFLICT_REQUIRES_REPLACE' };

/** /force link. By default refuses to displace an existing active link; `replace` unlinks them (audited, reversible via audit). */
export async function forceLink(db: Db, a: { guildId: string; adminId: string; discordUserId: string; playerId: string; username: string | null; reason?: string; replace?: boolean }): Promise<ForceResult> {
  return db.tx(async (t) => {
    const { rows: existing } = await t.query<LinkRow>(`SELECT * FROM account_links WHERE guild_id=$1 AND status IN ('verified','admin_linked') AND (player_id=$2 OR discord_user_id=$3) FOR UPDATE`, [a.guildId, a.playerId, a.discordUserId]);
    if (existing.length && !a.replace) return { ok: false, code: 'CONFLICT_REQUIRES_REPLACE' } as const;
    for (const e of existing) {
      await t.query(`UPDATE account_links SET status='unlinked', reviewed_by=$1, reviewed_at=now(), reason='replaced by admin link' WHERE id=$2`, [a.adminId, e.id]);
      await audit(t, { guildId: a.guildId, actor: a.adminId, action: 'link.unlinked_by_replace', target: e.player_id, details: { discordUserId: e.discord_user_id } });
    }
    await t.query(`UPDATE account_links SET status='rejected', reason='superseded by admin link', conflict=false WHERE guild_id=$1 AND status='pending' AND (player_id=$2 OR discord_user_id=$3)`, [a.guildId, a.playerId, a.discordUserId]);
    await t.query(`INSERT INTO account_links (guild_id, discord_user_id, player_id, player_username, status, method, reviewed_by, reviewed_at, reason)
                   VALUES ($1,$2,$3,$4,'admin_linked','admin_forced',$5,now(),$6)`, [a.guildId, a.discordUserId, a.playerId, a.username, a.adminId, a.reason ?? null]);
    await audit(t, { guildId: a.guildId, actor: a.adminId, action: 'link.admin_linked', target: a.playerId, details: { discordUserId: a.discordUserId, reason: a.reason ?? null, replaced: existing.length } });
    return { ok: true, replaced: existing.map((e) => e.player_id) } as const;
  });
}

export async function unlink(db: Db, a: { guildId: string; actorId: string; discordUserId: string }): Promise<boolean> {
  return db.tx(async (t) => {
    const { rows } = await t.query<LinkRow>(`UPDATE account_links SET status='unlinked', reviewed_by=$3, reviewed_at=now() WHERE guild_id=$1 AND discord_user_id=$2 AND status IN ('verified','admin_linked','pending') RETURNING *`, [a.guildId, a.discordUserId, a.actorId]);
    for (const r of rows) await audit(t, { guildId: a.guildId, actor: a.actorId, action: 'link.unlinked', target: r.player_id });
    return rows.length > 0;
  });
}

export interface UnlinkedLink { discordUserId: string; playerId: string; status: string; managedRoleIds: string[] }
/**
 * Unlinks a member (self-service or by a moderator) and returns what was removed, including the roles the bot had granted
 * (`managedRoleIds`), so the caller can take them off the member. A failure of any kind elsewhere NEVER reaches this function:
 * links are only ever removed by an explicit unlink / replace action.
 */
export async function unlinkWithRoles(db: Db, a: { guildId: string; actorId: string; discordUserId: string; action?: string }): Promise<UnlinkedLink[]> {
  return db.tx(async (t) => {
    // Read the roles BEFORE clearing them (RETURNING would otherwise hand back the already-cleared value).
    const { rows } = await t.query<{ player_id: string; status: string; managed_role_ids: string[] }>(
      `WITH target AS (SELECT id, status, managed_role_ids FROM account_links WHERE guild_id=$1 AND discord_user_id=$2 AND status IN ('verified','admin_linked','pending') FOR UPDATE)
       UPDATE account_links l SET status='unlinked', reviewed_by=$3, reviewed_at=now(), managed_role_ids='{}' FROM target WHERE l.id = target.id
       RETURNING l.player_id, target.status AS status, target.managed_role_ids AS managed_role_ids`, [a.guildId, a.discordUserId, a.actorId]);
    for (const r of rows) await audit(t, { guildId: a.guildId, actor: a.actorId, action: a.action ?? 'link.unlinked', target: r.player_id, details: { discordUserId: a.discordUserId } });
    return rows.map((r) => ({ discordUserId: a.discordUserId, playerId: r.player_id, status: r.status, managedRoleIds: r.managed_role_ids }));
  });
}

export async function listLinks(db: Db, guildId: string, status?: LinkStatus): Promise<LinkRow[]> {
  const { rows } = await db.query<LinkRow>(`SELECT * FROM account_links WHERE guild_id=$1 ${status ? 'AND status=$2' : ''} ORDER BY requested_at DESC`, status ? [guildId, status] : [guildId]);
  return rows;
}
