import { clearRetiredRankRoles, getRetiredRankRoles, getLadder, getGuildConfig, finishSyncJob, isJobRunning, listActiveLinks, listRoleMappings, scheduleRetry, startSyncJob, updateJobProgress, audit, type Db } from '@aon/db';
import type { Fetched } from '@aon/core';
import type { CitizensIndex, GovernmentRoster } from '@aon/client';
import { syncMember, type SyncContext, type UserSyncResult } from './member-sync.js';
import type { DiscordGateway, GameData } from './ports.js';

export interface GuildSyncDeps { db: Db; game: GameData; discord: DiscordGateway; now?: () => Date; sleep?: (ms: number) => Promise<void>; log?: (m: string) => void; batchSize?: number; maxConsecutiveRateLimited?: number }
export interface GuildSyncCounts { total: number; processed: number; updated: number; unchanged: number; partial: number; failed: number; skipped: number; notProcessed: number; rolesAdded: number; rolesRemoved: number; membersBlocked: number }
/** Aggregated, PII-light explanation of what happened (stored with the job and shown in the dashboard). */
export interface GuildSyncDetails {
  skippedReasons: Record<string, number>; blockedReasons: Record<string, number>; lookupFailures: Record<string, number>; errors: { discordUserId: string; note: string }[];
  /** Role values the game reported while syncing (party / unit roles per member count; government role values the app does not know yet). */
  seenRoles: { party: Record<string, number>; unit: Record<string, number>; governmentUnknown: string[] };
}
export type GuildSyncResult =
  | { ok: false; code: 'ALREADY_RUNNING' | 'GUILD_NOT_CONFIGURED' }
  | { ok: true; jobId: string; status: 'succeeded' | 'failed' | 'cancelled'; counts: GuildSyncCounts; details: GuildSyncDetails; error?: string; results: UserSyncResult[] };

/** Country-level data (roster, citizens) is identical for every member: fetch it once per run. Failures are NOT cached. */
export function memoizeCountryData(game: GameData): GameData {
  const roster = new Map<string, Fetched<GovernmentRoster>>();
  const citizens = new Map<string, Fetched<CitizensIndex>>();
  return {
    playerProfile: (id) => game.playerProfile(id),
    playerAllTimeDamage: (id) => game.playerAllTimeDamage(id),
    async governmentRoster(c) { const hit = roster.get(c); if (hit) return hit; const r = await game.governmentRoster(c); if (r.status === 'ok') roster.set(c, r); return r; },
    async countryCitizens(c) { const hit = citizens.get(c); if (hit) return hit; const r = await game.countryCitizens(c); if (r.status === 'ok') citizens.set(c, r); return r; },
  };
}

// In-process guard: one sync per user at a time (DB unique index guards the guild-wide job across processes).
const userLocks = new Set<string>();
export async function syncOneUser(deps: GuildSyncDeps, guildId: string, discordUserId: string): Promise<UserSyncResult | { error: 'NOT_LINKED' | 'GUILD_NOT_CONFIGURED' | 'BUSY' }> {
  const ctx = await loadContext(deps, guildId);
  if (!ctx) return { error: 'GUILD_NOT_CONFIGURED' };
  const link = (await listActiveLinks(deps.db, guildId)).find((l) => l.discordUserId === discordUserId);
  if (!link) return { error: 'NOT_LINKED' };
  const key = `${guildId}:${discordUserId}`;
  if (userLocks.has(key)) return { error: 'BUSY' };
  userLocks.add(key);
  try { return await syncMember(ctx, link); } finally { userLocks.delete(key); }
}

async function loadContext(deps: GuildSyncDeps, guildId: string): Promise<SyncContext | null> {
  const cfg = await getGuildConfig(deps.db, guildId);
  if (!cfg) return null;
  return { db: deps.db, game: deps.game, discord: deps.discord, now: deps.now ?? (() => new Date()), ...(deps.sleep ? { sleep: deps.sleep } : {}), cfg, mappings: await listRoleMappings(deps.db, guildId), ladder: await getLadder(deps.db, guildId), retiredRoles: await getRetiredRankRoles(deps.db, guildId) };
}

/** /sync all and the scheduler. Batched, cancellable, isolated per user, stops early when the API rate-limits us. */
export async function syncGuild(deps: GuildSyncDeps, a: { guildId: string; kind: 'all' | 'scheduled'; requestedBy: string | null; onProgress?: (c: GuildSyncCounts) => void; signal?: AbortSignal }): Promise<GuildSyncResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const ctx0 = await loadContext(deps, a.guildId);
  if (!ctx0) return { ok: false, code: 'GUILD_NOT_CONFIGURED' };
  const ctx: SyncContext = { ...ctx0, game: memoizeCountryData(deps.game) };
  const job = await startSyncJob(deps.db, { guildId: a.guildId, kind: a.kind, requestedBy: a.requestedBy });
  if (!job.ok) { if (a.kind === 'scheduled') await scheduleRetry(deps.db, a.guildId, now(), 5 * 60_000); return { ok: false, code: 'ALREADY_RUNNING' }; }
  const tag = `sync[guild=${a.guildId} job=${job.jobId} kind=${a.kind}]`;
  const started = now().getTime();

  const links = await listActiveLinks(deps.db, a.guildId);
  log(`${tag} start members=${links.length}`);
  const counts: GuildSyncCounts = { total: links.length, processed: 0, updated: 0, unchanged: 0, partial: 0, failed: 0, skipped: 0, notProcessed: 0, rolesAdded: 0, rolesRemoved: 0, membersBlocked: 0 };
  const details: GuildSyncDetails = { skippedReasons: {}, blockedReasons: {}, lookupFailures: {}, errors: [], seenRoles: { party: {}, unit: {}, governmentUnknown: [] } };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const results: UserSyncResult[] = [];
  const batch = deps.batchSize ?? 10;
  const maxRl = deps.maxConsecutiveRateLimited ?? 3;
  let consecutiveRl = 0;
  let status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
  let error: string | undefined;

  try {
    outer: for (let i = 0; i < links.length; i += batch) {
      if (a.signal?.aborted || !(await isJobRunning(deps.db, job.jobId))) { status = 'cancelled'; break; }
      for (const link of links.slice(i, i + batch)) {
        let r: UserSyncResult;
        try { r = await syncMember(ctx, link); }
        catch (e) { r = { discordUserId: link.discordUserId, playerId: link.playerId, outcome: 'failed', added: [], removed: [], blocked: [], skipped: [], lookups: {}, note: `unexpected:${e instanceof Error ? e.message.slice(0, 80) : 'error'}` }; }
        results.push(r); counts.processed++; counts[r.outcome === 'updated' ? 'updated' : r.outcome]++;
        counts.rolesAdded += r.added.length; counts.rolesRemoved += r.removed.length; if (r.blocked.length) counts.membersBlocked++;
        if (r.seen?.partyRole) bump(details.seenRoles.party, r.seen.partyRole); if (r.seen?.unitRole) bump(details.seenRoles.unit, r.seen.unitRole);
        for (const g of r.seen?.unknownGovernmentRoles ?? []) if (!details.seenRoles.governmentUnknown.includes(g)) details.seenRoles.governmentUnknown.push(g);
        for (const s of r.skipped) bump(details.skippedReasons, s.why);
        for (const b of r.blocked) bump(details.blockedReasons, b.why);
        for (const [src, st] of Object.entries(r.lookups)) if (st !== 'ok') bump(details.lookupFailures, `${src}:${st}`);
        if ((r.outcome === 'failed' || r.outcome === 'skipped') && r.note) { bump(details.skippedReasons, r.note); if (r.outcome === 'failed' && details.errors.length < 10) details.errors.push({ discordUserId: r.discordUserId, note: r.note }); }
        if (r.outcome === 'failed' || r.blocked.length) log(`${tag} member=${r.discordUserId} outcome=${r.outcome} note=${r.note ?? '-'} blocked=${r.blocked.map((b) => `${b.roleId}:${b.why}`).join(',') || '-'}`);
        consecutiveRl = Object.values(r.lookups).includes('rate_limited') ? consecutiveRl + 1 : 0;
        if (consecutiveRl >= maxRl) { status = 'failed'; error = 'rate_limited: stopped early to respect the API limit; remaining members were not processed'; break outer; }
      }
      await updateJobProgress(deps.db, job.jobId, a.guildId, { ...counts });
      a.onProgress?.({ ...counts });
    }
  } catch (e) { status = 'failed'; error = e instanceof Error ? e.message.slice(0, 200) : 'unexpected error'; }

  counts.notProcessed = counts.total - counts.processed;
  await finishSyncJob(deps.db, job.jobId, a.guildId, status, { ...counts }, error, { ...details });
  // Every member was processed with no failure or blocked operation: leftovers of deleted rank roles have been cleaned.
  if (status === 'succeeded' && counts.notProcessed === 0 && counts.failed === 0 && counts.membersBlocked === 0) await clearRetiredRankRoles(deps.db, a.guildId, job.jobId);
  await audit(deps.db, { guildId: a.guildId, actor: a.requestedBy, action: `sync.${a.kind}.${status}`, details: { jobId: job.jobId, ...counts } });
  if (status === 'failed' && a.kind === 'scheduled') await scheduleRetry(deps.db, a.guildId, now());          // do not wait a whole interval after a failed run
  log(`${tag} end status=${status} processed=${counts.processed}/${counts.total} updated=${counts.updated} unchanged=${counts.unchanged} partial=${counts.partial} failed=${counts.failed} skipped=${counts.skipped} rolesAdded=${counts.rolesAdded} rolesRemoved=${counts.rolesRemoved} durationMs=${now().getTime() - started}${error ? ` error="${error}"` : ''}`);
  return { ok: true, jobId: job.jobId, status, counts, details, ...(error ? { error } : {}), results };
}
