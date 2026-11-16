import { audit } from './audit.js';
import type { Db } from './db.js';

/** Most trusted-administrator roles one server may configure (keeps the access check and the audit trail small). */
export const MAX_ADMIN_ROLES = 10;
export interface AdminRole { roleId: string; addedBy: string | null; addedAt: Date }
export type AdminRoleResult = { ok: true } | { ok: false; code: 'GUILD_NOT_FOUND' | 'DISCORD_ROLE_INVALID' | 'TOO_MANY' };

export async function listAdminRoles(db: Db, guildId: string): Promise<AdminRole[]> {
  return (await db.query<{ discord_role_id: string; added_by: string | null; added_at: Date }>('SELECT discord_role_id, added_by, added_at FROM bot_admin_roles WHERE guild_id=$1 ORDER BY added_at, discord_role_id', [guildId]))
    .rows.map((r) => ({ roleId: r.discord_role_id, addedBy: r.added_by, addedAt: r.added_at }));
}
/** Which of these guilds have at least one trusted role (one query: used to decide where an extra Discord lookup is worth making). */
export async function guildsWithAdminRoles(db: Db, guildIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(); if (!guildIds.length) return out;
  for (const r of (await db.query<{ guild_id: string; discord_role_id: string }>('SELECT guild_id, discord_role_id FROM bot_admin_roles WHERE guild_id = ANY($1::text[])', [guildIds])).rows) out.set(r.guild_id, [...(out.get(r.guild_id) ?? []), r.discord_role_id]);
  return out;
}
/** Does the member hold any trusted role of this server? (`memberRoleIds` come from Discord, never from the client.) */
export async function hasAdminRole(db: Db, guildId: string, memberRoleIds: Iterable<string>): Promise<boolean> {
  const ids = [...memberRoleIds]; if (!ids.length) return false;
  return (await db.query('SELECT 1 FROM bot_admin_roles WHERE guild_id=$1 AND discord_role_id = ANY($2::text[]) LIMIT 1', [guildId, ids])).rows.length > 0;
}
export async function addAdminRole(db: Db, a: { guildId: string; roleId: string; actor: string | null }): Promise<AdminRoleResult> {
  if (!/^\d{5,25}$/.test(a.roleId)) return { ok: false, code: 'DISCORD_ROLE_INVALID' };
  return db.tx<AdminRoleResult>(async (t) => {
    if (!(await t.query('SELECT 1 FROM guilds WHERE guild_id=$1 FOR UPDATE', [a.guildId])).rows.length) return { ok: false, code: 'GUILD_NOT_FOUND' };      // same guild lock: the count check cannot be raced
    const cur = (await t.query<{ discord_role_id: string }>('SELECT discord_role_id FROM bot_admin_roles WHERE guild_id=$1', [a.guildId])).rows.map((r) => r.discord_role_id);
    if (cur.includes(a.roleId)) return { ok: true };                                                                                                         // idempotent
    if (cur.length >= MAX_ADMIN_ROLES) return { ok: false, code: 'TOO_MANY' };
    await t.query('INSERT INTO bot_admin_roles (guild_id, discord_role_id, added_by) VALUES ($1,$2,$3)', [a.guildId, a.roleId, a.actor]);
    await audit(t, { guildId: a.guildId, actor: a.actor, action: 'admin_role.added', target: a.roleId });
    return { ok: true };
  });
}
export async function removeAdminRole(db: Db, a: { guildId: string; roleId: string; actor: string | null }): Promise<boolean> {
  return db.tx(async (t) => {
    await t.query('SELECT 1 FROM guilds WHERE guild_id=$1 FOR UPDATE', [a.guildId]);
    const { rows } = await t.query('DELETE FROM bot_admin_roles WHERE guild_id=$1 AND discord_role_id=$2 RETURNING discord_role_id', [a.guildId, a.roleId]);
    if (rows.length) await audit(t, { guildId: a.guildId, actor: a.actor, action: 'admin_role.removed', target: a.roleId });
    return rows.length > 0;
  });
}
