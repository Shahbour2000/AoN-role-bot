import type { Fetched } from '@aon/core';
import { extractGovernmentRoster, extractPlayerProfile, type CitizensIndex, type GovernmentRoster, type PlayerProfile } from '@aon/client';
import { addRoleMapping, ensureGuild, forceLink, saveLadder, updateGuildSettings, type Db } from '@aon/db';
import { DEFAULT_RANKS } from '@aon/core';
import { freshDb } from '../../db/test/helpers.js';
import type { DiscordGateway, GameData, MemberRoles } from '../src/index.js';

export { freshDb };

export class FakeDiscord implements DiscordGateway {
  members = new Map<string, Set<string>>();           // `${guild}:${user}` -> roles
  assignable: Set<string> | 'all' = 'all';
  failAdd = new Set<string>();
  /** Queued errors per operation key ("+roleId" add / "-roleId" remove): each call consumes one; empty queue => success. */
  errors = new Map<string, unknown[]>();
  /** Artificial latency per add/remove so tests can force two syncs to overlap in time. */
  delayMs = 0;
  attempts = new Map<string, number>();
  calls: string[] = [];
  memberStatus = new Map<string, MemberRoles['status']>();
  key = (g: string, u: string) => `${g}:${u}`;
  give(g: string, u: string, ...roles: string[]) { this.members.set(this.key(g, u), new Set(roles)); }
  has(g: string, u: string) { return this.members.get(this.key(g, u)) ?? new Set<string>(); }
  async getMemberRoles(g: string, u: string): Promise<MemberRoles> {
    const st = this.memberStatus.get(this.key(g, u));
    if (st === 'absent') return { status: 'absent' };
    if (st === 'error') return { status: 'error', message: 'boom' };
    const m = this.members.get(this.key(g, u));
    return m ? { status: 'ok', roleIds: new Set(m) } : { status: 'absent' };
  }
  async assignableRoles(): Promise<ReadonlySet<string>> { return this.assignable === 'all' ? new AllSet() : this.assignable; }
  private async lag() { if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); }
  private inject(key: string) { this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1); const q = this.errors.get(key); if (q?.length) throw q.shift(); }
  async addRole(g: string, u: string, r: string) { await this.lag(); this.inject(`+${r}`); if (this.failAdd.has(r)) throw new Error('Missing Permissions'); this.calls.push(`+${u}:${r}`); this.has(g, u).add(r); }
  async removeRole(g: string, u: string, r: string) { await this.lag(); this.inject(`-${r}`); this.calls.push(`-${u}:${r}`); this.has(g, u).delete(r); }
}
/** A Set whose .has() is always true (every role assignable). */
class AllSet extends Set<string> { override has(): boolean { return true; } }

export class FakeGame implements GameData {
  roster: Fetched<GovernmentRoster> = { status: 'error', message: 'unset' };
  citizens: Fetched<CitizensIndex> = { status: 'error', message: 'unset' };
  profiles = new Map<string, Fetched<PlayerProfile>>();
  damage = new Map<string, Fetched<number>>();
  requests = { roster: 0, citizens: 0, profile: 0, damage: 0 };
  async governmentRoster() { this.requests.roster++; return this.roster; }
  async countryCitizens() { this.requests.citizens++; return this.citizens; }
  async playerProfile(id: string) { this.requests.profile++; return this.profiles.get(id) ?? { status: 'not_found' as const }; }
  async playerAllTimeDamage(id: string) { this.requests.damage++; return this.damage.get(id) ?? { status: 'not_found' as const }; }
}

export const rosterOf = (countryId: string, members: { userId: string; role: string }[]): Fetched<GovernmentRoster> =>
  extractGovernmentRoster({ status: 'ok', data: { countryId, countryName: countryId, count: members.length, members: members.map((m) => ({ ...m, username: m.userId, label: m.role, level: 1, party: null })) } }, countryId);

export const profileOf = (id: string, over: Record<string, unknown> = {}): Fetched<PlayerProfile> =>
  extractPlayerProfile({ status: 'ok', data: { id, username: id, deleted: false, countryId: 'eg', damage: { total: '1' }, party: null, militaryUnit: null, offices: [], ...over } });

/** A COMPLETE citizens list (what AonClient.countryCitizens returns when every page was collected). */
export const citizensOf = (countryId: string, ids: string[]): Fetched<CitizensIndex> =>
  ({ status: 'ok', data: { countryId, total: ids.length, byId: new Map(ids.map((id) => [id, { id, username: id, active: true, level: 1, offices: [] }])) } });

export const ROLE = { pres: '100001', vice: '100002', econ: '100003', citizen: '100004', party: '100005', unit: '100006', ally: '100007', foreign: '100008', other: '999999' };
export const rankRole = (order: number) => String(200000 + order);

export async function setup(opts: { guilds?: string[]; withRanks?: boolean } = {}): Promise<{ db: Db; discord: FakeDiscord; game: FakeGame }> {
  const db = await freshDb();
  for (const g of opts.guilds ?? ['A']) {
    await ensureGuild(db, g, `Guild ${g}`);
    await updateGuildSettings(db, g, { country_id: 'eg', party_id: 'pt_1', unit_id: 'mu_9' }, null);
    if (opts.withRanks) {
      await updateGuildSettings(db, g, { modules: { government: true, party: false, unit: false, alliance: false, ranks: true } }, null);   // the rank system is optional and off by default
      await saveLadder(db, g, DEFAULT_RANKS.map((r) => ({ ...r, discordRoleId: rankRole(r.order) })), null);
    }
  }
  return { db, discord: new FakeDiscord(), game: new FakeGame() };
}
export const link = (db: Db, g: string, user: string, player: string) => forceLink(db, { guildId: g, adminId: 'adm', discordUserId: user, playerId: player, username: player });
export const map = (db: Db, g: string, kind: string, roleId: string, gameRef?: string) => addRoleMapping(db, { guildId: g, kind, discordRoleId: roleId, ...(gameRef ? { gameRef } : {}), actor: null });

/** Error shapes as thrown by discord.js: DiscordAPIError carries a numeric `code` (JSON error) and HTTP `status`. */
export const discordErr = (code: number, message = 'discord error', status = 400) => Object.assign(new Error(message), { code, status });
export const httpErr = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
export const noSleep = async () => undefined;
