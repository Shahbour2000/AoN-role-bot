import type { DemotionPolicy } from '@aon/core';
import { audit } from './audit.js';
import type { Db } from './db.js';

export const ROLE_KINDS = [
  'president', 'vice_president', 'minister_defense', 'minister_foreign', 'minister_economy', 'congress', 'government_role',
  'citizen', 'party_member', 'party_leader', 'party_role', 'unit_member', 'unit_leader', 'alliance_member', 'alliance_leader',
] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export interface GuildConfig {
  guildId: string; name: string;
  communityType: 'country' | 'party' | 'military_unit' | 'alliance' | 'general';
  language: 'en' | 'ar';
  countryId: string | null; partyId: string | null; unitId: string | null; allianceId: string | null;
  modules: { government: boolean; party: boolean; unit: boolean; alliance: boolean; ranks: boolean };
  demotion: DemotionPolicy;
  requireStaffApproval: boolean; linkMode: 'direct' | 'staff_approval'; unitLeaderReplacesMember: boolean;
  autoSyncEnabled: boolean; syncIntervalMinutes: number; nextSyncAt: Date | null;
}
export interface RoleMapping { id: string; guildId: string; kind: RoleKind; gameRef: string; discordRoleId: string }

interface GuildRow {
  guild_id: string; name: string; community_type: GuildConfig['communityType']; language: 'en' | 'ar';
  country_id: string | null; party_id: string | null; unit_id: string | null; alliance_id: string | null;
  modules: GuildConfig['modules']; require_staff_approval: boolean; demotion_mode: 'never' | 'immediate' | 'grace';
  demotion_grace_days: number; sync_interval_minutes: number; auto_sync_enabled: boolean; next_sync_at: Date | null;
  unit_leader_replaces_member: boolean;
}

export async function ensureGuild(db: Db, guildId: string, name: string): Promise<void> {
  await db.query('INSERT INTO guilds (guild_id, name) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET name = EXCLUDED.name', [guildId, name]);
}

export async function getGuildConfig(db: Db, guildId: string): Promise<GuildConfig | null> {
  const { rows } = await db.query<GuildRow>('SELECT * FROM guilds WHERE guild_id=$1', [guildId]);
  const g = rows[0];
  if (!g) return null;
  return {
    guildId: g.guild_id, name: g.name, communityType: g.community_type, language: g.language,
    countryId: g.country_id, partyId: g.party_id, unitId: g.unit_id, allianceId: g.alliance_id,
    modules: g.modules, requireStaffApproval: g.require_staff_approval, linkMode: g.require_staff_approval ? 'staff_approval' : 'direct', unitLeaderReplacesMember: g.unit_leader_replaces_member, autoSyncEnabled: g.auto_sync_enabled, syncIntervalMinutes: g.sync_interval_minutes, nextSyncAt: g.next_sync_at,
    demotion: g.demotion_mode === 'grace' ? { mode: 'grace', graceDays: g.demotion_grace_days } : { mode: g.demotion_mode },
  };
}

export async function listRoleMappings(db: Db, guildId: string): Promise<RoleMapping[]> {
  const { rows } = await db.query<{ id: string; guild_id: string; kind: RoleKind; game_ref: string; discord_role_id: string }>('SELECT * FROM role_mappings WHERE guild_id=$1 ORDER BY kind, game_ref', [guildId]);
  return rows.map((r) => ({ id: r.id, guildId: r.guild_id, kind: r.kind, gameRef: r.game_ref, discordRoleId: r.discord_role_id }));
}

export type SetMappingResult = { ok: true } | { ok: false; code: 'INVALID_KIND' | 'GAME_REF_REQUIRED' | 'DISCORD_ROLE_INVALID' | 'ROLE_CONFLICT' };
/** Mapping kinds whose game value (raw role string) is mandatory: the game decides what the value is. */
export const KINDS_NEEDING_GAME_VALUE: readonly string[] = ['government_role', 'party_role'];

export async function addRoleMapping(db: Db, a: { guildId: string; kind: string; gameRef?: string; discordRoleId: string; actor: string | null }): Promise<SetMappingResult> {
  if (!(ROLE_KINDS as readonly string[]).includes(a.kind)) return { ok: false, code: 'INVALID_KIND' };
  const ref = a.gameRef?.trim() ?? '';
  if (KINDS_NEEDING_GAME_VALUE.includes(a.kind) && !ref) return { ok: false, code: 'GAME_REF_REQUIRED' };
  if (!/^\d{5,25}$/.test(a.discordRoleId)) return { ok: false, code: 'DISCORD_ROLE_INVALID' };
  // A Discord role is either a military-rank role or a mapped office/membership role, never both.
  if ((await db.query('SELECT 1 FROM military_ranks WHERE guild_id=$1 AND discord_role_id=$2', [a.guildId, a.discordRoleId])).rows.length) return { ok: false, code: 'ROLE_CONFLICT' };
  await db.tx(async (t) => {
    await t.query('INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [a.guildId, a.kind, ref, a.discordRoleId]);
    await t.query('DELETE FROM retired_rank_roles WHERE guild_id=$1 AND discord_role_id=$2', [a.guildId, a.discordRoleId]);     // re-used: no longer a leftover
    await audit(t, { guildId: a.guildId, actor: a.actor, action: 'mapping.added', target: a.kind, details: { gameRef: ref, discordRoleId: a.discordRoleId } });
  });
  return { ok: true };
}

export async function removeRoleMapping(db: Db, a: { guildId: string; mappingId: string; actor: string | null }): Promise<boolean> {
  return db.tx(async (t) => {
    const { rows } = await t.query<{ kind: string }>('DELETE FROM role_mappings WHERE id=$1 AND guild_id=$2 RETURNING kind', [a.mappingId, a.guildId]);
    if (rows[0]) await audit(t, { guildId: a.guildId, actor: a.actor, action: 'mapping.removed', target: rows[0].kind, details: { mappingId: a.mappingId } });
    return rows.length > 0;
  });
}

export const SYNC_INTERVALS_MINUTES = [180, 360, 720, 1440] as const;
const MIN_RESCHEDULE_DELAY_MS = 5 * 60_000;

/**
 * Updates guild settings. Schedule rules (all inside ONE transaction, so there is never a second schedule):
 *  - disabling auto-sync clears next_sync_at;
 *  - enabling, or changing the interval while enabled, re-anchors next_sync_at to
 *    max(last scheduled run + interval, now + 5 min)  (never a burst of immediate runs, never a lost schedule);
 *  - any other change leaves next_sync_at untouched.
 */
export async function updateGuildSettings(db: Db, guildId: string, patch: Partial<Pick<GuildRow, 'country_id' | 'party_id' | 'unit_id' | 'alliance_id' | 'language' | 'community_type' | 'demotion_mode' | 'demotion_grace_days' | 'auto_sync_enabled' | 'sync_interval_minutes' | 'require_staff_approval' | 'unit_leader_replaces_member'>> & { modules?: GuildConfig['modules'] }, actor: string | null, now: Date = new Date()): Promise<void> {
  const allowed = ['country_id', 'party_id', 'unit_id', 'alliance_id', 'language', 'community_type', 'demotion_mode', 'demotion_grace_days', 'auto_sync_enabled', 'sync_interval_minutes', 'require_staff_approval', 'unit_leader_replaces_member', 'modules'] as const; // whitelist: never interpolate caller keys
  const sets: string[] = []; const vals: unknown[] = [guildId];
  for (const k of allowed) if (k in patch) { vals.push(k === 'modules' ? JSON.stringify(patch[k]) : patch[k]); sets.push(`${k}=$${vals.length}${k === 'modules' ? '::jsonb' : ''}`); }
  if (!sets.length) return;
  await db.tx(async (t) => {
    if ('auto_sync_enabled' in patch || 'sync_interval_minutes' in patch) {
      const cur = (await t.query<{ auto_sync_enabled: boolean; sync_interval_minutes: number }>('SELECT auto_sync_enabled, sync_interval_minutes FROM guilds WHERE guild_id=$1 FOR UPDATE', [guildId])).rows[0];
      if (cur) {
        const enabled = patch.auto_sync_enabled ?? cur.auto_sync_enabled;
        const interval = patch.sync_interval_minutes ?? cur.sync_interval_minutes;
        if (!enabled) { sets.push('next_sync_at=NULL'); }
        else if (!cur.auto_sync_enabled || interval !== cur.sync_interval_minutes) {
          const last = (await t.query<{ created_at: Date }>(`SELECT created_at FROM sync_jobs WHERE guild_id=$1 AND kind='scheduled' ORDER BY created_at DESC LIMIT 1`, [guildId])).rows[0]?.created_at;
          const base = last ? new Date(last).getTime() : now.getTime();
          const next = new Date(Math.max(base + interval * 60_000, now.getTime() + MIN_RESCHEDULE_DELAY_MS));
          vals.push(next.toISOString()); sets.push(`next_sync_at=$${vals.length}::timestamptz`);
        }
      }
    }
    await t.query(`UPDATE guilds SET ${sets.join(', ')}, updated_at=now() WHERE guild_id=$1`, vals);
    await audit(t, { guildId, actor, action: 'settings.updated', details: { keys: Object.keys(patch) } });
  });
}

// ---- links used by sync -------------------------------------------------------------------------
export interface ActiveLink { id: string; discordUserId: string; playerId: string; lastDamage: number | null; rankBelowSince: Date | null }

export async function listActiveLinks(db: Db, guildId: string): Promise<ActiveLink[]> {
  const { rows } = await db.query<{ id: string; discord_user_id: string; player_id: string; last_damage: string | null; rank_below_since: Date | null }>(
    `SELECT id, discord_user_id, player_id, last_damage, rank_below_since FROM account_links WHERE guild_id=$1 AND status IN ('verified','admin_linked') ORDER BY requested_at`, [guildId]);
  return rows.map((r) => ({ id: r.id, discordUserId: r.discord_user_id, playerId: r.player_id, lastDamage: r.last_damage === null ? null : Number(r.last_damage), rankBelowSince: r.rank_below_since }));
}
export async function getActiveLinkForUser(db: Db, guildId: string, discordUserId: string): Promise<ActiveLink | null> {
  return (await listActiveLinks(db, guildId)).find((l) => l.discordUserId === discordUserId) ?? null;
}
export async function recordLinkSync(db: Db, a: { linkId: string; guildId: string; damage: number | null; managedRoleIds: string[]; rankBelowSince: Date | null; /** current in-game name (display only; the stable player id is what links) */ username?: string | null }): Promise<void> {
  await db.query(`UPDATE account_links SET last_synced_at=now(), last_damage=COALESCE($3, last_damage), managed_role_ids=$4, rank_below_since=$5, player_username=COALESCE($6, player_username) WHERE id=$1 AND guild_id=$2`,
    [a.linkId, a.guildId, a.damage, a.managedRoleIds, a.rankBelowSince, a.username ?? null]);
}

// ---- sync jobs ----------------------------------------------------------------------------------
export type StartJob = { ok: true; jobId: string } | { ok: false; code: 'ALREADY_RUNNING' };
export async function startSyncJob(db: Db, a: { guildId: string; kind: 'all' | 'scheduled'; requestedBy: string | null }): Promise<StartJob> {
  try {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO sync_jobs (guild_id, kind, status, requested_by, started_at) VALUES ($1,$2,'running',$3,now()) RETURNING id`, [a.guildId, a.kind, a.requestedBy]);
    return { ok: true, jobId: rows[0]!.id };
  } catch (e) {
    if (/unique|duplicate/i.test(e instanceof Error ? e.message : '')) return { ok: false, code: 'ALREADY_RUNNING' };
    throw e;
  }
}
export async function updateJobProgress(db: Db, jobId: string, guildId: string, counts: Record<string, number>): Promise<void> {
  await db.query(`UPDATE sync_jobs SET counts=$3::jsonb WHERE id=$1 AND guild_id=$2 AND status='running'`, [jobId, guildId, JSON.stringify(counts)]);
}
export async function finishSyncJob(db: Db, jobId: string, guildId: string, status: 'succeeded' | 'failed' | 'cancelled', counts: Record<string, number>, error?: string, details: Record<string, unknown> = {}): Promise<void> {
  await db.query(`UPDATE sync_jobs SET status=$3, counts=$4::jsonb, error=$5, details=$6::jsonb, finished_at=now() WHERE id=$1 AND guild_id=$2`, [jobId, guildId, status, JSON.stringify(counts), error ?? null, JSON.stringify(details)]);
}
export async function cancelSyncJob(db: Db, guildId: string, actor: string | null): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(`UPDATE sync_jobs SET status='cancelled', finished_at=now() WHERE guild_id=$1 AND status='running' RETURNING id`, [guildId]);
  if (rows[0]) await audit(db, { guildId, actor, action: 'sync.cancelled', details: { jobId: rows[0].id } });
  return rows.length > 0;
}
export async function isJobRunning(db: Db, jobId: string): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM sync_jobs WHERE id=$1 AND status='running'`, [jobId])).rows.length > 0;
}
export async function recoverStaleJobs(db: Db, now: Date = new Date()): Promise<number> {
  // After a crash/restart no job can still be running. Mark them failed so new ones can start, and make any
  // auto-sync guild whose scheduled run was interrupted due again right away (the claim had already advanced its schedule).
  const { rows } = await db.query<{ guild_id: string; kind: string }>(`UPDATE sync_jobs SET status='failed', error='interrupted by restart', finished_at=now() WHERE status IN ('running','queued') RETURNING guild_id, kind`);
  const interrupted = [...new Set(rows.filter((r) => r.kind === 'scheduled').map((r) => r.guild_id))];
  for (const g of interrupted) await db.query(`UPDATE guilds SET next_sync_at = $2::timestamptz WHERE guild_id=$1 AND auto_sync_enabled`, [g, now.toISOString()]);
  return rows.length;
}

// ---- scheduler ----------------------------------------------------------------------------------
/**
 * Atomically CLAIMS every due guild (auto-sync on, next_sync_at <= now, no sync currently running) by advancing its
 * next_sync_at by one interval in the same statement. Two workers can never claim the same guild for the same slot
 * (the second one re-checks the row after the first commits). Manual syncs do not move the schedule.
 */
export async function claimDueGuilds(db: Db, now: Date): Promise<string[]> {
  const { rows } = await db.query<{ guild_id: string }>(
    `UPDATE guilds g SET next_sync_at = $1::timestamptz + (g.sync_interval_minutes * interval '1 minute')
     WHERE g.auto_sync_enabled AND g.next_sync_at <= $1::timestamptz
       AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.guild_id=g.guild_id AND j.kind IN ('all','scheduled') AND j.status IN ('queued','running'))
     RETURNING g.guild_id`, [now.toISOString()]);
  return rows.map((r) => r.guild_id).sort();
}
/** A scheduled run that could not complete is retried soon instead of waiting a whole interval. */
export async function scheduleRetry(db: Db, guildId: string, now: Date, delayMs = 30 * 60_000): Promise<void> {
  await db.query(`UPDATE guilds SET next_sync_at = LEAST(next_sync_at, $2::timestamptz) WHERE guild_id=$1 AND auto_sync_enabled`, [guildId, new Date(now.getTime() + delayMs).toISOString()]);
}
export interface SyncStatus {
  enabled: boolean; intervalMinutes: number; nextSyncAt: Date | null; running: boolean;
  lastSuccess: JobRow | null; lastJob: JobRow | null;
}
export async function getSyncStatus(db: Db, guildId: string): Promise<SyncStatus | null> {
  const g = await getGuildConfig(db, guildId);
  if (!g) return null;
  const { rows } = await db.query<{ id: string; kind: string; status: string; requested_by: string | null; counts: Record<string, number>; details: Record<string, unknown>; error: string | null; created_at: Date; finished_at: Date | null }>(
    `SELECT id, kind, status, requested_by, counts, details, error, created_at, finished_at FROM sync_jobs WHERE guild_id=$1 AND kind IN ('all','scheduled') ORDER BY created_at DESC LIMIT 50`, [guildId]);
  const map = (r: (typeof rows)[number]): JobRow => ({ id: r.id, kind: r.kind, status: r.status, requestedBy: r.requested_by, counts: r.counts, details: r.details, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at });
  const jobs = rows.map(map);
  return { enabled: g.autoSyncEnabled, intervalMinutes: g.syncIntervalMinutes, nextSyncAt: g.nextSyncAt, running: jobs.some((j) => j.status === 'running' || j.status === 'queued'),
    lastSuccess: jobs.find((j) => j.status === 'succeeded') ?? null, lastJob: jobs.find((j) => j.status !== 'running' && j.status !== 'queued') ?? jobs[0] ?? null };
}
export async function listPendingLinks(db: Db, guildId: string, limit = 25): Promise<{ discordUserId: string; playerId: string; username: string | null; conflict: boolean }[]> {
  const { rows } = await db.query<{ discord_user_id: string; player_id: string; player_username: string | null; conflict: boolean }>(
    `SELECT discord_user_id, player_id, player_username, conflict FROM account_links WHERE guild_id=$1 AND status='pending' ORDER BY requested_at LIMIT $2`, [guildId, limit]);
  return rows.map((r) => ({ discordUserId: r.discord_user_id, playerId: r.player_id, username: r.player_username, conflict: r.conflict }));
}
export async function findLinkForUser(db: Db, guildId: string, discordUserId: string): Promise<{ id: string; playerId: string; username: string | null; status: string; lastSyncedAt: Date | null } | null> {
  const { rows } = await db.query<{ id: string; player_id: string; player_username: string | null; status: string; last_synced_at: Date | null }>(
    `SELECT id, player_id, player_username, status, last_synced_at FROM account_links WHERE guild_id=$1 AND discord_user_id=$2 AND status IN ('verified','admin_linked','pending') ORDER BY (status='pending'), requested_at DESC LIMIT 1`, [guildId, discordUserId]);
  const r = rows[0];
  return r ? { id: r.id, playerId: r.player_id, username: r.player_username, status: r.status, lastSyncedAt: r.last_synced_at } : null;
}

// ---- dashboard read models ----------------------------------------------------------------------
export interface LinkDetail { id: string; discordUserId: string; playerId: string; username: string | null; status: string; method: string; conflict: boolean; requestedAt: Date; reviewedBy: string | null; lastSyncedAt: Date | null; lastDamage: number | null; managedRoleIds: string[] }
export async function listLinksDetailed(db: Db, guildId: string, o: { status?: string; limit?: number; offset?: number } = {}): Promise<LinkDetail[]> {
  const params: unknown[] = [guildId]; let where = 'guild_id=$1';
  if (o.status) { params.push(o.status); where += ` AND status=$${params.length}`; }
  params.push(Math.min(o.limit ?? 50, 200), o.offset ?? 0);
  const { rows } = await db.query<{ id: string; discord_user_id: string; player_id: string; player_username: string | null; status: string; method: string; conflict: boolean; requested_at: Date; reviewed_by: string | null; last_synced_at: Date | null; last_damage: string | null; managed_role_ids: string[] }>(
    `SELECT * FROM account_links WHERE ${where} ORDER BY requested_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows.map((r) => ({ id: r.id, discordUserId: r.discord_user_id, playerId: r.player_id, username: r.player_username, status: r.status, method: r.method, conflict: r.conflict, requestedAt: r.requested_at, reviewedBy: r.reviewed_by, lastSyncedAt: r.last_synced_at, lastDamage: r.last_damage === null ? null : Number(r.last_damage), managedRoleIds: r.managed_role_ids }));
}
export async function countLinksByStatus(db: Db, guildId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM account_links WHERE guild_id=$1 GROUP BY status', [guildId]);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}
export interface AuditRow { id: number; actor: string | null; action: string; target: string | null; details: unknown; createdAt: Date }
export async function listAudit(db: Db, guildId: string, o: { limit?: number; beforeId?: number } = {}): Promise<AuditRow[]> {
  const params: unknown[] = [guildId, Math.min(o.limit ?? 50, 200)]; let where = 'guild_id=$1';
  if (o.beforeId !== undefined) { params.push(o.beforeId); where += ` AND id < $${params.length}`; }
  const { rows } = await db.query<{ id: string; actor_discord_id: string | null; action: string; target: string | null; details: unknown; created_at: Date }>(
    `SELECT id::text, actor_discord_id, action, target, details, created_at FROM audit_events WHERE ${where} ORDER BY id DESC LIMIT $2`, params);
  return rows.map((r) => ({ id: Number(r.id), actor: r.actor_discord_id, action: r.action, target: r.target, details: r.details, createdAt: r.created_at }));
}
export interface JobRow { id: string; kind: string; status: string; requestedBy: string | null; counts: Record<string, number>; details: Record<string, unknown>; error: string | null; createdAt: Date; finishedAt: Date | null }
export async function listSyncJobs(db: Db, guildId: string, limit = 20): Promise<JobRow[]> {
  const { rows } = await db.query<{ id: string; kind: string; status: string; requested_by: string | null; counts: Record<string, number>; details: Record<string, unknown>; error: string | null; created_at: Date; finished_at: Date | null }>(
    'SELECT id, kind, status, requested_by, counts, details, error, created_at, finished_at FROM sync_jobs WHERE guild_id=$1 ORDER BY created_at DESC LIMIT $2', [guildId, Math.min(limit, 100)]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, requestedBy: r.requested_by, counts: r.counts, details: r.details, error: r.error, createdAt: r.created_at, finishedAt: r.finished_at }));
}
export async function guildExists(db: Db, guildId: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM guilds WHERE guild_id=$1', [guildId])).rows.length > 0;
}

// ---- retired rank roles (cleaned off members until one complete sync has run) -----------------------
export async function getRetiredRankRoles(db: Db, guildId: string): Promise<string[]> {
  return (await db.query<{ discord_role_id: string }>('SELECT discord_role_id FROM retired_rank_roles WHERE guild_id=$1 ORDER BY discord_role_id', [guildId])).rows.map((r) => r.discord_role_id);
}
/** Called after a sync that processed EVERY member: roles retired before that job started have now been cleaned. */
export async function clearRetiredRankRoles(db: Db, guildId: string, jobId: string): Promise<number> {
  return (await db.query(`DELETE FROM retired_rank_roles WHERE guild_id=$1 AND retired_at <= (SELECT started_at FROM sync_jobs WHERE id=$2) RETURNING 1`, [guildId, jobId])).rows.length;
}
export async function isSyncRunning(db: Db, guildId: string): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM sync_jobs WHERE guild_id=$1 AND status IN ('queued','running')`, [guildId])).rows.length > 0;
}
