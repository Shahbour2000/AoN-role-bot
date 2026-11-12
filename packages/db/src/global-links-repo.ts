import { audit } from './audit.js';
import type { Db } from './db.js';

/**
 * GLOBAL identity: one Discord account <-> one game account across every server (unique partial indexes in migration 0009).
 * Per-server `account_links` rows keep the per-server sync state and are created from the global link on the member's first
 * explicit use of the bot in that server (the bot has no privileged member-join intent).
 */
export type GlobalMethod = 'company_verified' | 'admin_forced' | 'staff_approved' | 'legacy_unverified';
export interface GlobalLink { id: string; discordUserId: string; playerId: string; username: string | null; method: GlobalMethod; verifiedAt: Date }
interface Row { id: string; discord_user_id: string; player_id: string; player_username: string | null; method: GlobalMethod; verified_at: Date }
const map = (r: Row): GlobalLink => ({ id: r.id, discordUserId: r.discord_user_id, playerId: r.player_id, username: r.player_username, method: r.method, verifiedAt: r.verified_at });

/** Only a company-verified link is proof of ownership. Every other method (legacy self-claim, staff approval, forced) can be displaced by a real proof. */
export const isProof = (m: GlobalMethod): boolean => m === 'company_verified';

export async function getGlobalLinkForUser(db: Db, discordUserId: string): Promise<GlobalLink | null> {
  const { rows } = await db.query<Row>(`SELECT * FROM global_links WHERE status='active' AND discord_user_id=$1`, [discordUserId]);
  return rows[0] ? map(rows[0]) : null;
}
export async function getGlobalLinkForPlayer(db: Db, playerId: string): Promise<GlobalLink | null> {
  const { rows } = await db.query<Row>(`SELECT * FROM global_links WHERE status='active' AND player_id=$1`, [playerId]);
  return rows[0] ? map(rows[0]) : null;
}

export type EnsureResult = { status: 'created' | 'exists'; linkId: string } | { status: 'no_global_link' };
/** Makes the member's global link usable in this server (idempotent). Called only on an explicit user action in that server. */
export async function ensureGuildLink(db: Db, a: { guildId: string; discordUserId: string }): Promise<EnsureResult> {
  return db.tx(async (t) => ensureGuildLinkTx(t, a));
}
export async function ensureGuildLinkTx(t: Db, a: { guildId: string; discordUserId: string }): Promise<EnsureResult> {
  const g = (await t.query<Row>(`SELECT * FROM global_links WHERE status='active' AND discord_user_id=$1 FOR SHARE`, [a.discordUserId])).rows[0];
  if (!g) return { status: 'no_global_link' };
  const mine = (await t.query<{ id: string; player_id: string }>(`SELECT id, player_id FROM account_links WHERE guild_id=$1 AND discord_user_id=$2 AND status IN ('verified','admin_linked')`, [a.guildId, a.discordUserId])).rows[0];
  if (mine && mine.player_id === g.player_id) return { status: 'exists', linkId: mine.id };
  if (mine) await t.query(`UPDATE account_links SET status='unlinked', reason='replaced by the global link', reviewed_at=now() WHERE id=$1`, [mine.id]);
  await t.query(`UPDATE account_links SET status='rejected', reason='superseded by the global link', conflict=false WHERE guild_id=$1 AND status='pending' AND (discord_user_id=$2 OR player_id=$3)`, [a.guildId, a.discordUserId, g.player_id]);
  const { rows } = await t.query<{ id: string }>(
    `INSERT INTO account_links (guild_id, discord_user_id, player_id, player_username, status, method, reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,$4,'verified','global_link',NULL,now()) RETURNING id`, [a.guildId, a.discordUserId, g.player_id, g.player_username]);
  await audit(t, { guildId: a.guildId, actor: a.discordUserId, action: 'link.global_materialized', target: g.player_id, details: { globalMethod: g.method } });
  return { status: 'created', linkId: rows[0]!.id };
}

export interface GlobalUnlinkResult { discordUserId: string; playerId: string; method: GlobalMethod; guilds: { guildId: string; managedRoleIds: string[] }[] }
/** Ends a global link and every per-server link that came from it. Returns the roles the bot granted, per server, so the caller can take them off. */
export async function unlinkGlobalTx(t: Db, a: { by: { discordUserId: string } | { playerId: string }; actorId: string; action: string; reason?: string; auditGuildId: string }): Promise<GlobalUnlinkResult | null> {
  const g = ('discordUserId' in a.by
    ? (await t.query<Row>(`SELECT * FROM global_links WHERE status='active' AND discord_user_id=$1 FOR UPDATE`, [a.by.discordUserId]))
    : (await t.query<Row>(`SELECT * FROM global_links WHERE status='active' AND player_id=$1 FOR UPDATE`, [a.by.playerId]))).rows[0];
  if (!g) return null;
  await t.query(`UPDATE global_links SET status='unlinked', unlinked_at=now(), unlinked_by=$2, unlink_reason=$3 WHERE id=$1`, [g.id, a.actorId, a.reason ?? null]);
  const { rows } = await t.query<{ guild_id: string; managed_role_ids: string[] }>(
    `WITH target AS (SELECT id, guild_id, managed_role_ids FROM account_links WHERE discord_user_id=$1 AND player_id=$2 AND status IN ('verified','admin_linked','pending') FOR UPDATE)
     UPDATE account_links l SET status='unlinked', reviewed_by=$3, reviewed_at=now(), managed_role_ids='{}' FROM target WHERE l.id=target.id
     RETURNING l.guild_id AS guild_id, target.managed_role_ids AS managed_role_ids`, [g.discord_user_id, g.player_id, a.actorId]);
  await audit(t, { guildId: a.auditGuildId, actor: a.actorId, action: a.action, target: g.player_id, details: { discordUserId: g.discord_user_id, method: g.method, guilds: rows.map((r) => r.guild_id), reason: a.reason ?? null } });
  for (const r of rows) if (r.guild_id !== a.auditGuildId) await audit(t, { guildId: r.guild_id, actor: a.actorId, action: a.action, target: g.player_id, details: { discordUserId: g.discord_user_id, global: true } });
  return { discordUserId: g.discord_user_id, playerId: g.player_id, method: g.method, guilds: rows.map((r) => ({ guildId: r.guild_id, managedRoleIds: r.managed_role_ids })) };
}
/** Self-service: the member removes their own global link (every server). Audited. */
export async function unlinkGlobalSelf(db: Db, a: { discordUserId: string; guildId: string }): Promise<GlobalUnlinkResult | null> {
  return db.tx((t) => unlinkGlobalTx(t, { by: { discordUserId: a.discordUserId }, actorId: a.discordUserId, action: 'link.unlinked_self_global', auditGuildId: a.guildId }));
}
/**
 * OPERATOR recovery (lost account, hijacked claim): ends the global link of a game account. Deliberately NOT reachable from any server
 * administrator's command or the dashboard: it affects every server, so it runs from the host (scripts/recover-link.ts). A reason is mandatory.
 */
export async function recoverGlobalLink(db: Db, a: { playerId: string; operator: string; reason: string }): Promise<GlobalUnlinkResult | null> {
  if (!a.reason.trim()) throw new Error('a reason is required');
  return db.tx((t) => unlinkGlobalTx(t, { by: { playerId: a.playerId }, actorId: `operator:${a.operator}`, action: 'link.recovered', reason: a.reason, auditGuildId: '*' }));
}
