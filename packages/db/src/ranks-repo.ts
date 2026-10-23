import { DEFAULT_RANKS, validateLadder, type LadderIssue, type RankDefinition } from '@aon/core';
import { audit } from './audit.js';
import type { Db } from './db.js';

export async function getLadder(db: Db, guildId: string): Promise<RankDefinition[]> {
  const { rows } = await db.query<{ key: string; rank_order: number; name_en: string; name_ar: string; min_damage: string; discord_role_id: string | null; enabled: boolean }>(
    'SELECT key, rank_order, name_en, name_ar, min_damage, discord_role_id, enabled FROM military_ranks WHERE guild_id = $1 ORDER BY rank_order', [guildId]);
  return rows.map((r) => ({ key: r.key, order: r.rank_order, nameEn: r.name_en, nameAr: r.name_ar, minDamage: Number(r.min_damage), discordRoleId: r.discord_role_id, enabled: r.enabled }));
}

/** `code` is set for refusals that are not about ladder validity: a sync is running (ranks cannot be deleted mid-run) or a role is already a mapped office. */
export type SaveLadderResult = { ok: true } | { ok: false; issues: LadderIssue[]; code?: 'SYNC_RUNNING' | 'ROLE_CONFLICT'; roleIds?: string[] };

/**
 * Backend-authoritative save: validate with the shared core rules, then replace the whole ladder
 * in ONE transaction (DB trigger re-checks the invariant at commit). Rejected input changes nothing.
 */
export async function saveLadder(db: Db, guildId: string, ranks: readonly RankDefinition[], actor: string | null, opts: { allowEqualThresholds?: boolean } = {}): Promise<SaveLadderResult> {
  const v = validateLadder(ranks, opts);
  if (!v.ok) {
    await audit(db, { guildId, actor, action: 'ranks.update_rejected', details: { issues: v.issues.map((i) => i.code) } });
    return v;
  }
  const before = await getLadder(db, guildId);
  const removed = before.filter((b) => !ranks.some((r) => r.key === b.key));
  // Deleting ranks while a synchronization is running could leave a member half-processed: refuse until it finishes.
  if (removed.length && (await db.query(`SELECT 1 FROM sync_jobs WHERE guild_id=$1 AND status IN ('queued','running')`, [guildId])).rows.length) {
    await audit(db, { guildId, actor, action: 'ranks.update_rejected', details: { reason: 'sync_running' } });
    return { ok: false, issues: [], code: 'SYNC_RUNNING' };
  }
  // A Discord role cannot be a rank role and a mapped office/membership role at the same time.
  const wanted = ranks.map((r) => r.discordRoleId).filter((x): x is string => x !== null);
  if (wanted.length) {
    const clash = (await db.query<{ discord_role_id: string }>('SELECT DISTINCT discord_role_id FROM role_mappings WHERE guild_id=$1 AND discord_role_id = ANY($2::text[])', [guildId, wanted])).rows.map((x) => x.discord_role_id);
    if (clash.length) { await audit(db, { guildId, actor, action: 'ranks.update_rejected', details: { reason: 'role_conflict', roleIds: clash } }); return { ok: false, issues: [], code: 'ROLE_CONFLICT', roleIds: clash }; }
  }
  await db.tx(async (t) => {
    await t.query('DELETE FROM military_ranks WHERE guild_id = $1', [guildId]);
    for (const r of ranks) {
      await t.query('INSERT INTO military_ranks (guild_id, key, rank_order, name_en, name_ar, min_damage, discord_role_id, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [guildId, r.key, r.order, r.nameEn, r.nameAr, r.minDamage, r.discordRoleId, r.enabled]);
    }
    // Roles the bot used to manage for ranks but no longer does (rank deleted, or its role changed) are remembered so the next
    // complete sync strips them from members; roles that are managed again are forgotten.
    const stillRank = new Set(wanted);
    for (const b of before) {
      const next = ranks.find((r) => r.key === b.key);
      if (b.discordRoleId && b.enabled && !stillRank.has(b.discordRoleId) && (!next || next.discordRoleId !== b.discordRoleId)) {
        await t.query('INSERT INTO retired_rank_roles (guild_id, discord_role_id) VALUES ($1,$2) ON CONFLICT (guild_id, discord_role_id) DO UPDATE SET retired_at = now()', [guildId, b.discordRoleId]);
      }
    }
    if (wanted.length) await t.query('DELETE FROM retired_rank_roles WHERE guild_id=$1 AND discord_role_id = ANY($2::text[])', [guildId, wanted]);
    await audit(t, { guildId, actor, action: 'ranks.update', details: { before: before.map((b) => [b.key, b.minDamage, b.enabled]), after: ranks.map((a) => [a.key, a.minDamage, a.enabled]), removed: removed.map((x) => x.key) } });
  });
  return { ok: true };
}

export async function seedDefaultLadder(db: Db, guildId: string) {
  return saveLadder(db, guildId, DEFAULT_RANKS, null);
}

/** Seed used when a guild first installs the bot (no Discord roles mapped yet). */
export const DEFAULT_LADDER_SEED: readonly RankDefinition[] = DEFAULT_RANKS;
