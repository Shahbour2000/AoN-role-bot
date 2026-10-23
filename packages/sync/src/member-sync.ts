import {
  computeRank, evaluateRankRules, planRoleChanges, validateLadder,
  type Fetched, type RankDefinition, type RuleEvaluation,
} from '@aon/core';
import { citizenshipOf, rolesByPlayer, type CitizensIndex, type GovernmentRoster, type PlayerProfile } from '@aon/client';
import { audit, recordLinkSync, type ActiveLink, type Db, type GuildConfig, type RoleKind, type RoleMapping } from '@aon/db';
import type { DiscordGateway, GameData } from './ports.js';

export interface SyncContext {
  db: Db; game: GameData; discord: DiscordGateway; now: () => Date; sleep?: (ms: number) => Promise<void>;
  cfg: GuildConfig; mappings: readonly RoleMapping[]; ladder: readonly RankDefinition[];
  /** Rank roles removed from the ladder: stripped from members until a complete sync has run. */
  retiredRoles?: readonly string[];
}

export type Outcome = 'updated' | 'unchanged' | 'partial' | 'failed' | 'skipped';
export interface UserSyncResult {
  discordUserId: string; playerId: string; outcome: Outcome;
  added: string[]; removed: string[];
  blocked: { roleId: string; why: string }[]; skipped: { roleId: string; why: string }[];
  lookups: Record<string, Fetched<unknown>['status']>;
  /** Role values the game reported for this member (lets admins discover the exact value to map). Not used for decisions. */
  seen?: { partyRole?: string; unitRole?: string; unknownGovernmentRoles?: string[] };
  note?: string;
}

const RAW_ROLE: Partial<Record<RoleKind, string>> = {
  president: 'president', vice_president: 'vicePresident', minister_defense: 'ministerDefense', minister_economy: 'ministerEconomy', congress: 'congress',
};
type ModuleKey = 'government' | 'party' | 'unit' | 'alliance';
const moduleOf = (k: RoleKind): ModuleKey =>
  k.startsWith('party_') ? 'party' : k.startsWith('unit_') ? 'unit' : k.startsWith('alliance_') ? 'alliance' : 'government';


// ---------------------------------------------------------------- Discord error handling
export type DiscordFailure = 'member_left' | 'role_deleted' | 'missing_permissions' | 'rate_limited' | 'transient' | 'unknown';
/** Maps discord.js / REST errors to what the sync should do about them. Codes: 10007 Unknown Member, 10011 Unknown Role, 50013/50001 permissions. */
export function classifyDiscordError(e: unknown): { kind: DiscordFailure; retryAfterMs?: number; message: string } {
  const x = (e ?? {}) as { code?: unknown; status?: unknown; message?: unknown; retryAfter?: unknown; timeToReset?: unknown };
  const message = typeof x.message === 'string' ? x.message.slice(0, 80) : 'unknown';
  const code = typeof x.code === 'number' ? x.code : Number(x.code);
  const status = typeof x.status === 'number' ? x.status : 0;
  if (code === 10007 || code === 10013) return { kind: 'member_left', message };
  if (code === 10011) return { kind: 'role_deleted', message };
  if (code === 50013 || code === 50001 || status === 403) return { kind: 'missing_permissions', message };
  if (status === 429 || typeof x.timeToReset === 'number' || typeof x.retryAfter === 'number') {
    const ms = typeof x.timeToReset === 'number' ? x.timeToReset : typeof x.retryAfter === 'number' ? x.retryAfter * 1000 : 2000;
    return { kind: 'rate_limited', retryAfterMs: Math.min(Math.max(ms, 250), 30_000), message };
  }
  if (status >= 500 || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|timeout/i.test(message)) return { kind: 'transient', message };
  return { kind: 'unknown', message };
}

/** One role add/remove with bounded retries for rate limits and transient network errors (2 retries). */
async function runRoleOp(ctx: SyncContext, op: () => Promise<void>): Promise<{ ok: true } | { ok: false; failure: ReturnType<typeof classifyDiscordError> }> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try { await op(); return { ok: true }; }
    catch (e) {
      const f = classifyDiscordError(e);
      if ((f.kind === 'rate_limited' || f.kind === 'transient') && attempt < 2) { await sleep(f.retryAfterMs ?? 500 * 3 ** attempt); continue; }
      return { ok: false, failure: f };
    }
  }
}
const whyOf = (f: ReturnType<typeof classifyDiscordError>) => (f.kind === 'unknown' ? `discord_error:${f.message}` : `discord_${f.kind}`);

const unknown = (roleId: string, why: string): RuleEvaluation => ({ roleId, evidence: 'unknown', why });

function evalMapping(m: RoleMapping, cfg: GuildConfig, playerId: string, roster: Fetched<GovernmentRoster> | undefined, profile: Fetched<PlayerProfile> | undefined, citizens: Fetched<CitizensIndex> | undefined): RuleEvaluation {
  const id = m.discordRoleId;
  switch (m.kind) {
    case 'president': case 'vice_president': case 'minister_defense': case 'minister_economy': case 'congress':
    case 'minister_foreign': case 'government_role': {
      const raw = RAW_ROLE[m.kind] ?? m.gameRef;          // minister_foreign: raw value not verified => admin supplies it via gameRef
      if (!raw) return unknown(id, 'raw_role_not_configured');
      if (!cfg.countryId) return unknown(id, 'country_not_configured');
      if (!roster || roster.status !== 'ok') return unknown(id, `roster_${roster?.status ?? 'missing'}`);
      const held = rolesByPlayer(roster.data).get(playerId);
      return { roleId: id, evidence: held?.has(raw) ? 'qualifies' : 'not_qualifies', why: 'government_roster' };
    }
    case 'citizen': {
      const ref = m.gameRef || cfg.countryId;
      if (!ref) return unknown(id, 'country_not_configured');
      if (m.gameRef) {
        // A role for one SPECIFIC country (possibly not the guild's own): the player's current country from their profile.
        if (!profile || profile.status !== 'ok') return unknown(id, `profile_${profile?.status ?? 'missing'}`);
        const c = citizenshipOf(profile.data, ref);
        return c.state === 'member' ? { roleId: id, evidence: 'qualifies', why: 'citizenship' } : c.state === 'not_member' ? { roleId: id, evidence: 'not_qualifies', why: 'citizenship' } : unknown(id, 'country_unknown');
      }
      // The guild's own country: the COMPLETE paginated citizens list (one batch for everyone).
      if (!citizens || citizens.status !== 'ok') return unknown(id, `citizens_${citizens?.status ?? 'missing'}`);
      return { roleId: id, evidence: citizens.data.byId.has(playerId) ? 'qualifies' : 'not_qualifies', why: 'citizenship' };
    }
    case 'party_member': case 'unit_member': {
      const isParty = m.kind === 'party_member';
      const ref = m.gameRef || (isParty ? cfg.partyId : cfg.unitId);
      if (!ref) return unknown(id, isParty ? 'party_not_configured' : 'unit_not_configured');
      if (!profile || profile.status !== 'ok') return unknown(id, `profile_${profile?.status ?? 'missing'}`);
      const ms = isParty ? profile.data.party : profile.data.unit;
      if (ms.state === 'unknown') return unknown(id, 'membership_unknown');
      const inEntity = ms.state === 'member' && ms.value.id === ref;
      // Optional per-guild rule: a unit commander gets the leader role INSTEAD of the member role.
      const replacedByLeader = !isParty && cfg.unitLeaderReplacesMember && inEntity && ms.state === 'member' && ms.value.role === 'commander';
      return { roleId: id, evidence: inEntity && !replacedByLeader ? 'qualifies' : 'not_qualifies', why: replacedByLeader ? 'unit_leader_replaces_member' : isParty ? 'party_membership' : 'unit_membership' };
    }
    case 'party_role': {
      // A party role identified by the game's own role value (treasurer, council member, ...). The value is supplied by the admin.
      if (!cfg.partyId) return unknown(id, 'party_not_configured');
      if (!m.gameRef) return unknown(id, 'raw_role_not_configured');
      if (!profile || profile.status !== 'ok') return unknown(id, `profile_${profile?.status ?? 'missing'}`);
      const ms = profile.data.party;
      if (ms.state === 'unknown') return unknown(id, 'membership_unknown');
      return { roleId: id, evidence: ms.state === 'member' && ms.value.id === cfg.partyId && ms.value.role === m.gameRef ? 'qualifies' : 'not_qualifies', why: 'party_role' };
    }
    case 'party_leader': case 'unit_leader': {
      // Observed role values: party "leader", military unit "commander". Other role strings => not a leader.
      const isParty = m.kind === 'party_leader';
      const ref = m.gameRef || (isParty ? cfg.partyId : cfg.unitId);
      if (!ref) return unknown(id, isParty ? 'party_not_configured' : 'unit_not_configured');
      if (!profile || profile.status !== 'ok') return unknown(id, `profile_${profile?.status ?? 'missing'}`);
      const ms = isParty ? profile.data.party : profile.data.unit;
      if (ms.state === 'unknown') return unknown(id, 'membership_unknown');
      const leaderRole = isParty ? 'leader' : 'commander';
      return { roleId: id, evidence: ms.state === 'member' && ms.value.id === ref && ms.value.role === leaderRole ? 'qualifies' : 'not_qualifies', why: isParty ? 'party_leadership' : 'unit_leadership' };
    }
    case 'alliance_member': case 'alliance_leader': return unknown(id, 'alliance_data_unverified');
  }
}

// ---------------------------------------------------------------- per-member serialisation
// Two syncs of the same member (e.g. /sync me during /sync all, or a manual run overlapping the scheduler) never interleave:
// each one re-reads the member's current roles after the previous finished, so a member can never end up with two rank roles.
const memberChains = new Map<string, Promise<unknown>>();
async function withMemberLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = memberChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const chain = prev.then(() => gate);
  memberChains.set(key, chain);
  await prev;
  try { return await fn(); } finally { release(); if (memberChains.get(key) === chain) memberChains.delete(key); }
}

/** Syncs ONE linked member. Never throws for API/Discord trouble; returns a structured result. */
export function syncMember(ctx: SyncContext, link: ActiveLink): Promise<UserSyncResult> {
  return withMemberLock(`${ctx.cfg.guildId}:${link.discordUserId}`, () => syncMemberUnlocked(ctx, link));
}

async function syncMemberUnlocked(ctx: SyncContext, link: ActiveLink): Promise<UserSyncResult> {
  const { cfg, db, game, discord } = ctx;
  const base: UserSyncResult = { discordUserId: link.discordUserId, playerId: link.playerId, outcome: 'unchanged', added: [], removed: [], blocked: [], skipped: [], lookups: {} };

  const enabled = ctx.mappings.filter((m) => cfg.modules[moduleOf(m.kind)]);
  const rankOk = cfg.modules.ranks && validateLadder(ctx.ladder).ok;
  const activeLadder = rankOk ? ctx.ladder.filter((r) => r.enabled) : [];       // disabled ranks are completely unmanaged
  const rankRoles = activeLadder.filter((r) => r.discordRoleId);
  const managed = new Set<string>([...enabled.map((m) => m.discordRoleId), ...rankRoles.map((r) => r.discordRoleId!)]);
  const retired = (ctx.retiredRoles ?? []).filter((r) => !managed.has(r));
  if (managed.size === 0 && retired.length === 0) return { ...base, outcome: 'unchanged', note: 'nothing_configured' };
  for (const r of retired) managed.add(r);

  const member = await discord.getMemberRoles(cfg.guildId, link.discordUserId);
  if (member.status === 'absent') return { ...base, outcome: 'skipped', note: 'member_not_in_guild' };
  if (member.status === 'error') return { ...base, outcome: 'failed', note: `discord_${member.message}` };

  // Fetch only what the enabled rules need.
  const needRoster = enabled.some((m) => moduleOf(m.kind) === 'government' && m.kind !== 'citizen') && !!cfg.countryId;
  const needCitizens = enabled.some((m) => m.kind === 'citizen' && !m.gameRef) && !!cfg.countryId;
  const needProfile = enabled.some((m) => ['party_member', 'party_role', 'unit_member', 'party_leader', 'unit_leader'].includes(m.kind) || (m.kind === 'citizen' && !!m.gameRef));
  const needDamage = rankRoles.length > 0;
  const [roster, citizens, profile, damage] = await Promise.all([
    needRoster ? game.governmentRoster(cfg.countryId!) : undefined,
    needCitizens ? game.countryCitizens(cfg.countryId!) : undefined,
    needProfile ? game.playerProfile(link.playerId) : undefined,
    needDamage ? game.playerAllTimeDamage(link.playerId) : undefined,
  ]);
  if (roster) base.lookups['roster'] = roster.status;
  if (citizens) base.lookups['citizens'] = citizens.status;
  if (profile) base.lookups['profile'] = profile.status;
  if (damage) base.lookups['damage'] = damage.status;
  const seen: NonNullable<UserSyncResult['seen']> = {};
  if (profile?.status === 'ok') { if (profile.data.party.state === 'member' && profile.data.party.value.role) seen.partyRole = profile.data.party.value.role; if (profile.data.unit.state === 'member' && profile.data.unit.value.role) seen.unitRole = profile.data.unit.value.role; }
  if (roster?.status === 'ok' && roster.data.unknownRoles.length) seen.unknownGovernmentRoles = roster.data.unknownRoles;
  if (Object.keys(seen).length) base.seen = seen;
  const statuses = Object.values(base.lookups);
  const allFailed = statuses.length > 0 && statuses.every((s) => s !== 'ok');

  const evaluations: RuleEvaluation[] = enabled.map((m) => evalMapping(m, cfg, link.playerId, roster, profile, citizens));
  // Rank roles that were deleted from the ladder: a configuration fact (no game data needed) ⇒ strip them from the member.
  for (const r of retired) evaluations.push({ roleId: r, evidence: 'not_qualifies', why: 'rank_retired' });
  let belowSince: Date | null = link.rankBelowSince;
  if (damage && rankRoles.length) {
    const currentOrder = rankRoles.filter((r) => member.roleIds.has(r.discordRoleId!)).reduce<number | null>((hi, r) => (hi === null || r.order > hi ? r.order : hi), null);
    const computed = damage.status === 'ok' ? computeRank(damage.data, activeLadder) : null;
    const targetOrder = computed?.status === 'ranked' ? computed.rank.order : computed?.status === 'unranked' ? 0 : null;
    if (targetOrder !== null && currentOrder !== null && targetOrder < currentOrder) belowSince = belowSince ?? ctx.now(); else if (targetOrder !== null) belowSince = null;
    evaluations.push(...evaluateRankRules({ ladder: activeLadder, damage, currentOrder, policy: cfg.demotion, belowSince, now: ctx.now() }));
  }

  const plan = planRoleChanges({ evaluations, managedRoleIds: managed, currentRoleIds: member.roleIds, assignableRoleIds: await discord.assignableRoles(cfg.guildId) });
  const held = new Set(member.roleIds);
  base.blocked.push(...plan.blocked); base.skipped.push(...plan.skipped);

  const left = (why = 'member_left_during_sync'): UserSyncResult => ({ ...base, outcome: 'skipped', note: why });
  for (const [roleIds, op, done] of [[plan.remove, (r: string) => discord.removeRole(cfg.guildId, link.discordUserId, r, 'AoN role sync'), (r: string) => { base.removed.push(r); held.delete(r); }],
                                     [plan.add, (r: string) => discord.addRole(cfg.guildId, link.discordUserId, r, 'AoN role sync'), (r: string) => { base.added.push(r); held.add(r); }]] as const) {
    for (const roleId of roleIds) {
      const res = await runRoleOp(ctx, () => op(roleId));
      if (res.ok) { done(roleId); continue; }
      if (res.failure.kind === 'member_left') return left();           // nothing more to do for a member who is gone
      base.blocked.push({ roleId, why: whyOf(res.failure) });          // deleted role / missing permission / persistent failure: report, keep going
    }
  }

  if (allFailed) return { ...base, outcome: 'failed', note: 'all_lookups_failed' }; // nothing trustworthy; no state recorded
  await recordLinkSync(db, { linkId: link.id, guildId: cfg.guildId, damage: damage?.status === 'ok' ? damage.data : null, managedRoleIds: [...held].filter((r) => managed.has(r)), rankBelowSince: belowSince, ...(profile?.status === 'ok' ? { username: profile.data.username } : {}) });
  if (base.added.length || base.removed.length) {
    await audit(db, { guildId: cfg.guildId, actor: null, action: 'sync.roles_changed', target: link.discordUserId, details: { playerId: link.playerId, added: base.added, removed: base.removed } });
    return { ...base, outcome: 'updated' };
  }
  return { ...base, outcome: base.skipped.length > 0 || statuses.some((s) => s !== 'ok') ? 'partial' : 'unchanged' };
}
