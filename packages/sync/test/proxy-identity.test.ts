import { describe, expect, it } from 'vitest';
import type { Fetched } from '@aon/core';
import type { PartySummary, UnitSummary } from '@aon/client';
import { addRoleMapping, setEntityMemberRole, setIdentityRole, setProxyCountry, updateGuildSettings } from '@aon/db';
import { memoizeCountryData, syncGuild, syncOneUser } from '../src/index.js';
import { FakeGame, ROLE, citizensOf, link, map, profileOf, setup } from './harness.js';

const R = { proxySd: '300001', proxyLy: '300002', pA: '300003', pPres: '300004', uA: '300005', uLeader: '300006', uOwner: '300007', pB: '300008', uB: '300009', citizen: ROLE.citizen };
class Game extends FakeGame {
  parties: Fetched<PartySummary[]> = { status: 'ok', data: [] }; units: Fetched<UnitSummary[]> = { status: 'ok', data: [] }; reqParties = 0; reqUnits = 0;
  async countryParties() { this.reqParties++; return this.parties; }
  async countryUnits() { this.reqUnits++; return this.units; }
}
const party = (id: string, leaderId: string | null = 'x'): PartySummary => ({ id, name: id, leaderId, leaderName: null, members: 1, ruling: false });
const unit = (id: string, countryId: string | null, ownerId: string | null): UnitSummary => ({ id, name: id, countryId, ownerId, ownerName: null, members: 1, capacity: 10, joinPolicy: null, logoUrl: null } as unknown as UnitSummary);
async function world() {
  const h = await setup(); const game = new Game(); (h as { game: FakeGame }).game = game;
  await updateGuildSettings(h.db, 'A', { community_type: 'country', country_id: 'eg', modules: { government: true, party: true, unit: true, alliance: false, ranks: false } }, null);
  game.citizens = citizensOf('eg', ['egy1']);                                     // egy1 is the only Egyptian citizen
  return { ...h, game };
}
const run = async (h: { db: never; game: FakeGame; discord: never } | Awaited<ReturnType<typeof world>>, user = 'd1', g = 'A') => {
  const r = await syncOneUser({ db: (h as Awaited<ReturnType<typeof world>>).db, game: h.game, discord: (h as Awaited<ReturnType<typeof world>>).discord }, g, user);
  if ('error' in r) throw new Error(r.error); return r;
};
const roles = (h: Awaited<ReturnType<typeof world>>, u = 'd1') => [...h.discord.has('A', u)].sort();

describe('proxy countries', () => {
  it('a Sudanese-nationality player gets the Sudan proxy role and NOT the Egyptian citizen role; the proxy role survives later syncs', async () => {
    const h = await world(); await link(h.db, 'A', 'd1', 'sud1');
    await map(h.db, 'A', 'citizen', R.citizen); await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null }); await setProxyCountry(h.db, { guildId: 'A', countryId: 'ly', discordRoleId: R.proxyLy, actor: null });
    h.discord.give('A', 'd1'); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'sd' }));
    expect((await run(h)).outcome).toBe('updated'); expect(roles(h)).toEqual([R.proxySd]);
    const again = await run(h); expect(again.outcome).toBe('unchanged'); expect(roles(h)).toEqual([R.proxySd]);           // idempotent
    h.discord.calls.length = 0; await run(h); expect(h.discord.calls).toEqual([]);
  });
  it('an Egyptian national gets the citizen role only; a proxy role is never granted to citizens', async () => {
    const h = await world(); await link(h.db, 'A', 'd1', 'egy1'); await map(h.db, 'A', 'citizen', R.citizen); await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null });
    h.discord.give('A', 'd1'); h.game.profiles.set('egy1', profileOf('egy1', { countryId: 'eg' })); await run(h); expect(roles(h)).toEqual([R.citizen]);
  });
  it('a proxy player who WRONGLY holds the citizen role loses it; changing nationality swaps proxy role -> citizen role', async () => {
    const h = await world(); await link(h.db, 'A', 'd1', 'sud1'); await map(h.db, 'A', 'citizen', R.citizen); await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null });
    h.discord.give('A', 'd1', R.citizen); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'sd' })); await run(h); expect(roles(h)).toEqual([R.proxySd]);
    h.game.citizens = citizensOf('eg', ['egy1', 'sud1']); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'eg' })); await run(h); expect(roles(h)).toEqual([R.citizen]);
  });
  it('leaves unrelated roles alone and a nationality that is not configured as a proxy gets nothing', async () => {
    const h = await world(); await link(h.db, 'A', 'd1', 'fr1'); await map(h.db, 'A', 'citizen', R.citizen); await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null });
    h.discord.give('A', 'd1', ROLE.other); h.game.profiles.set('fr1', profileOf('fr1', { countryId: 'fr' })); await run(h); expect(roles(h)).toEqual([ROLE.other]);
  });
  it('NEVER removes the proxy role when the profile lookup fails or the country is unreadable', async () => {
    for (const p of [{ status: 'error' as const, message: 'HTTP 500' }, { status: 'rate_limited' as const, retryAfterMs: 1 }, { status: 'not_found' as const }, { status: 'incomplete' as const, missing: ['countryId'] }]) {
      const h = await world(); await link(h.db, 'A', 'd1', 'sud1'); await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null });
      h.discord.give('A', 'd1', R.proxySd); h.game.profiles.set('sud1', p); await run(h); expect(roles(h), JSON.stringify(p)).toEqual([R.proxySd]);
    }
  });
  it('works for the scheduled/guild-wide sync as well, for many members at once, and does not touch non-linked members', async () => {
    const h = await world(); await map(h.db, 'A', 'citizen', R.citizen); await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null });
    for (const [d, p, c] of [['d1', 'sud1', 'sd'], ['d2', 'egy1', 'eg'], ['d3', 'sud2', 'sd']] as const) { await link(h.db, 'A', d, p); h.discord.give('A', d); h.game.profiles.set(p, profileOf(p, { countryId: c })); }
    h.discord.give('A', 'stranger', R.proxySd);
    const r = await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'u' }); expect(r.ok).toBe(true);
    expect(roles(h, 'd1')).toEqual([R.proxySd]); expect(roles(h, 'd2')).toEqual([R.citizen]); expect(roles(h, 'd3')).toEqual([R.proxySd]); expect(roles(h, 'stranger')).toEqual([R.proxySd]);
  });
  describe('SHARED citizen role: the own-country citizen role and every proxy country use the SAME Discord role', () => {
    const shared = async () => {
      const h = await world(); await map(h.db, 'A', 'citizen', R.citizen);
      expect(await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.citizen, actor: null })).toEqual({ ok: true });
      expect(await setProxyCountry(h.db, { guildId: 'A', countryId: 'ly', discordRoleId: R.citizen, actor: null })).toEqual({ ok: true });
      return h;
    };
    const player = async (h: Awaited<ReturnType<typeof world>>, d: string, p: string, countryId: string, hold = false) => { await link(h.db, 'A', d, p); h.discord.give('A', d, ...(hold ? [R.citizen] : [])); h.game.profiles.set(p, profileOf(p, { countryId })); };
    it('Egyptians and proxy nationals all receive that one role; other nationalities do not and lose it', async () => {
      const h = await shared(); await player(h, 'd1', 'egy1', 'eg'); await player(h, 'd2', 'sud1', 'sd'); await player(h, 'd3', 'lib1', 'ly'); await player(h, 'd4', 'fr1', 'fr'); await player(h, 'd5', 'fr2', 'fr', true);
      for (const d of ['d1', 'd2', 'd3', 'd4', 'd5']) await run(h, d);
      expect([1, 2, 3, 4, 5].map((i) => roles(h, `d${i}`))).toEqual([[R.citizen], [R.citizen], [R.citizen], [], []]);
      h.discord.calls.length = 0; for (const d of ['d1', 'd2', 'd3', 'd4', 'd5']) await run(h, d); expect(h.discord.calls).toEqual([]);          // idempotent: no churn
    });
    it('a nationality change grants / removes the shared role correctly, and never churns when the player moves between two roles that are the same Discord role', async () => {
      const h = await shared(); await player(h, 'd1', 'sud1', 'sd'); await run(h); expect(roles(h)).toEqual([R.citizen]);
      h.discord.calls.length = 0; h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'ly' })); await run(h); expect(roles(h)).toEqual([R.citizen]); expect(h.discord.calls).toEqual([]);       // proxy -> proxy
      h.game.citizens = citizensOf('eg', ['egy1', 'sud1']); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'eg' })); await run(h); expect(roles(h)).toEqual([R.citizen]);                // proxy -> citizen
      h.game.citizens = citizensOf('eg', ['egy1']); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'fr' })); await run(h); expect(roles(h)).toEqual([]);                            // -> foreign: removed
      h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'sd' })); await run(h); expect(roles(h)).toEqual([R.citizen]);                                                                 // -> proxy again: granted
    });
    it('NEVER removes the shared role while either side is uncertain; only a definite "neither" removes it', async () => {
      // citizens list unreadable + a foreign national: the citizen rule is unknown -> kept
      let h = await shared(); await player(h, 'd1', 'fr1', 'fr', true); h.game.citizens = { status: 'error', message: 'down' } as never; await run(h); expect(roles(h)).toEqual([R.citizen]);
      // profile unreadable + not in the (complete) citizens list: the proxy rule is unknown -> kept
      h = await shared(); await link(h.db, 'A', 'd1', 'sud1'); h.discord.give('A', 'd1', R.citizen); h.game.profiles.set('sud1', { status: 'error', message: 'x' }); await run(h); expect(roles(h)).toEqual([R.citizen]);
      // profile unreadable but the complete citizens list proves citizenship -> granted
      h = await shared(); await link(h.db, 'A', 'd1', 'egy1'); h.discord.give('A', 'd1'); h.game.profiles.set('egy1', { status: 'error', message: 'x' }); await run(h); expect(roles(h)).toEqual([R.citizen]);
      // both readable and neither holds -> removed
      h = await shared(); await player(h, 'd1', 'fr1', 'fr', true); await run(h); expect(roles(h)).toEqual([]);
    });
    it('removing a proxy country keeps the role for the citizens; the guild-wide run gives the same result as single-user runs', async () => {
      const h = await shared(); await player(h, 'd1', 'egy1', 'eg'); await player(h, 'd2', 'sud1', 'sd'); await player(h, 'd3', 'fr1', 'fr', true);
      const { removeProxyCountry } = await import('@aon/db'); await removeProxyCountry(h.db, { guildId: 'A', countryId: 'sd', actor: null });
      const r = await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'u' }); expect(r.ok).toBe(true);
      expect(roles(h, 'd1')).toEqual([R.citizen]); expect(roles(h, 'd2')).toEqual([]); expect(roles(h, 'd3')).toEqual([]);          // Sudan is no longer a proxy: its nationals are ordinary foreigners again
    });
  });
  it('servers are isolated: another server\'s proxy configuration never affects this one', async () => {
    const h = await world(); await link(h.db, 'A', 'd1', 'sud1'); h.discord.give('A', 'd1'); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'sd' }));
    await run(h); expect(roles(h)).toEqual([]);                       // no proxy configured here
  });
  it('the proxy kind survives the link being global (a player linked in several servers is evaluated per server)', async () => {
    const h = await setup({ guilds: ['A', 'B'] }); const game = new Game(); (h as { game: FakeGame }).game = game;
    await updateGuildSettings(h.db, 'A', { community_type: 'country', country_id: 'eg' }, null); await updateGuildSettings(h.db, 'B', { community_type: 'country', country_id: 'ly' }, null);
    await setProxyCountry(h.db, { guildId: 'A', countryId: 'sd', discordRoleId: R.proxySd, actor: null }); await setProxyCountry(h.db, { guildId: 'B', countryId: 'sd', discordRoleId: R.proxyLy, actor: null });
    await link(h.db, 'A', 'd1', 'sud1'); await link(h.db, 'B', 'd1', 'sud1'); h.discord.give('A', 'd1'); h.discord.give('B', 'd1'); game.profiles.set('sud1', profileOf('sud1', { countryId: 'sd' })); game.citizens = citizensOf('eg', []);
    await syncOneUser({ db: h.db, game, discord: h.discord }, 'A', 'd1'); await syncOneUser({ db: h.db, game, discord: h.discord }, 'B', 'd1');
    expect([...h.discord.has('A', 'd1')]).toEqual([R.proxySd]); expect([...h.discord.has('B', 'd1')]).toEqual([R.proxyLy]);
  });
});

describe('country party roles: one membership role PER party + ONE shared Party President', () => {
  const cfg = async (h: Awaited<ReturnType<typeof world>>) => {
    expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_party_member', entityId: 'pa', discordRoleId: R.pA, actor: null })).toEqual({ ok: true });
    expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_party_member', entityId: 'pb', discordRoleId: R.pB, actor: null })).toEqual({ ok: true });
    await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_president', discordRoleId: R.pPres, actor: null });
  };
  const member = async (h: Awaited<ReturnType<typeof world>>, d: string, p: string, pid: string | null, role = 'member', hold: string[] = []) => {
    await link(h.db, 'A', d, p); h.discord.give('A', d, ...hold); h.game.profiles.set(p, profileOf(p, { party: pid ? { id: pid, name: pid, role } : null }));
  };
  it('a player gets the membership role of THEIR party; every leader gets the SAME president role; members do not', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'lead1'), party('pb', 'lead2')] };
    await member(h, 'd1', 'm1', 'pa'); await member(h, 'd2', 'm2', 'pb', 'treasurer'); await member(h, 'd3', 'lead1', 'pa', 'leader'); await member(h, 'd4', 'lead2', 'pb', 'leader');
    for (const d of ['d1', 'd2', 'd3', 'd4']) await run(h, d);
    expect(roles(h, 'd1')).toEqual([R.pA]); expect(roles(h, 'd2')).toEqual([R.pB]); expect(roles(h, 'd3')).toEqual([R.pA, R.pPres].sort()); expect(roles(h, 'd4')).toEqual([R.pB, R.pPres].sort());
  });
  it('changing party swaps the membership role; leaving removes membership and president; a stale president role goes when leadership changes', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'someone-else'), party('pb', 'lead2')] };
    await member(h, 'd1', 'm1', 'pa', 'member', [R.pA, R.pPres]); await run(h, 'd1'); expect(roles(h, 'd1')).toEqual([R.pA]);
    h.game.profiles.set('m1', profileOf('m1', { party: { id: 'pb', name: 'pb', role: 'member' } })); await run(h, 'd1'); expect(roles(h, 'd1')).toEqual([R.pB]);
    h.game.profiles.set('m1', profileOf('m1', { party: null })); await run(h, 'd1'); expect(roles(h, 'd1')).toEqual([]);
  });
  it('a party of ANOTHER country, or a mapping whose party is not in the country list, never grants; stale roles are removed when the data is complete', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'lead1')] };             // pb is NOT a party of this country (stale / foreign mapping)
    await member(h, 'd1', 'egy1', 'foreign-party', 'leader', [R.pA, R.pB, R.pPres]); await run(h, 'd1'); expect(roles(h, 'd1')).toEqual([]);
    await member(h, 'd2', 'm2', 'pb', 'member', [R.pB]); await run(h, 'd2'); expect(roles(h, 'd2')).toEqual([]);          // pb is not in the list: no grant, and the role is removed
    await member(h, 'd3', 'm3', 'pb'); await run(h, 'd3'); expect(roles(h, 'd3')).toEqual([]);
  });
  it('is safe when the party list or the profile cannot be read: nothing is removed, nothing is guessed', async () => {
    for (const parties of [{ status: 'error' as const, message: 'x' }, { status: 'rate_limited' as const, retryAfterMs: 1 }, { status: 'incomplete' as const, missing: ['parties[]'] }]) {
      const h = await world(); await cfg(h); h.game.parties = parties; await member(h, 'd1', 'm1', 'pa', 'member', [R.pA]); await run(h); expect(roles(h, 'd1'), JSON.stringify(parties)).toEqual([R.pA]);
    }
    const h = await world(); await cfg(h); await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1', R.pA, R.pPres); h.game.profiles.set('m1', { status: 'error', message: 'x' }); await run(h); expect(roles(h)).toEqual([R.pA, R.pPres].sort());
  });
  it('the president role needs no profile when the country\'s own list names the player; a profile that says "member" is definitive even if another party has no leader', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'lead1'), party('pb', null)] }; await link(h.db, 'A', 'd1', 'lead1'); h.discord.give('A', 'd1');
    h.game.profiles.set('lead1', { status: 'error', message: 'down' }); await run(h); expect(roles(h)).toContain(R.pPres);
    await member(h, 'd2', 'm2', 'pb', 'member', [R.pPres]); await run(h, 'd2'); expect(roles(h, 'd2')).toEqual([R.pB]);       // the profile's own role is definitive: a plain member is not president, whatever the list's gaps
  });
  it('legacy general "any party" rows are neither granted nor removed', async () => {
    const h = await world(); await h.db.query(`ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_entity_member_ref`);
    await h.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','country_party_member','','300050')`);
    h.game.parties = { status: 'ok', data: [party('pa', 'lead1')] }; await member(h, 'd1', 'm1', 'pa', 'member', ['300050']); await member(h, 'd2', 'm2', 'pa'); await run(h, 'd1'); await run(h, 'd2');
    expect(roles(h, 'd1')).toEqual(['300050']); expect(roles(h, 'd2')).toEqual([]);
  });
});

describe('country unit roles: one membership role PER unit + ONE shared Unit Leader + ONE shared Unit Owner', () => {
  const cfg = async (h: Awaited<ReturnType<typeof world>>) => {
    expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_unit_member', entityId: 'mu1', discordRoleId: R.uA, actor: null })).toEqual({ ok: true });
    expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_unit_member', entityId: 'mu2', discordRoleId: R.uB, actor: null })).toEqual({ ok: true });
    await setIdentityRole(h.db, { guildId: 'A', kind: 'country_unit_leader', discordRoleId: R.uLeader, actor: null }); await setIdentityRole(h.db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R.uOwner, actor: null });
  };
  const units = (): Fetched<UnitSummary[]> => ({ status: 'ok', data: [unit('mu1', 'eg', 'own1'), unit('mu2', 'eg', 'own2'), unit('muF', 'sd', 'ownF')] });
  const inUnit = async (h: Awaited<ReturnType<typeof world>>, d: string, p: string, mu: string | null, role = 'member', hold: string[] = [], countryId = 'eg') => {
    await link(h.db, 'A', d, p); h.discord.give('A', d, ...hold); h.game.profiles.set(p, profileOf(p, { countryId, militaryUnit: mu ? { id: mu, name: mu, role } : null }));
  };
  it('member + commander + owner of the SAME unit gets all three; another unit\'s commander gets that unit\'s membership and the SAME leader role', async () => {
    const h = await world(); await cfg(h); h.game.units = units();
    await inUnit(h, 'd1', 'own1', 'mu1', 'commander');                                       // owns mu1, commands mu1, is in mu1
    await inUnit(h, 'd2', 'c2', 'mu2', 'commander'); await inUnit(h, 'd3', 'm3', 'mu1', 'officer'); await inUnit(h, 'd4', 'own2', 'mu1', 'member');   // owner of mu2 sitting in mu1
    await inUnit(h, 'd5', 'x', null);
    for (const d of ['d1', 'd2', 'd3', 'd4', 'd5']) await run(h, d);
    expect(roles(h, 'd1')).toEqual([R.uA, R.uLeader, R.uOwner].sort());
    expect(roles(h, 'd2')).toEqual([R.uB, R.uLeader].sort());                                // commander, NOT the owner
    expect(roles(h, 'd3')).toEqual([R.uA]);
    expect(roles(h, 'd4')).toEqual([R.uA, R.uOwner].sort());                                 // owner, NOT a commander, and a member of a DIFFERENT unit
    expect(roles(h, 'd5')).toEqual([]);
  });
  it('commander and owner are separate facts: ownership never implies leadership and vice versa; the owner need not be inside the unit', async () => {
    const h = await world(); await cfg(h); h.game.units = units();
    await inUnit(h, 'd1', 'own1', null); await inUnit(h, 'd2', 'c1', 'mu1', 'commander', [R.uOwner]);
    await run(h, 'd1'); await run(h, 'd2'); expect(roles(h, 'd1')).toEqual([R.uOwner]); expect(roles(h, 'd2')).toEqual([R.uA, R.uLeader].sort());       // the stale Unit Owner is removed from the commander
  });
  it('changing unit swaps the membership role; losing command / ownership removes only that role', async () => {
    const h = await world(); await cfg(h); h.game.units = units(); await inUnit(h, 'd1', 'c1', 'mu1', 'commander', [R.uA, R.uLeader]);
    await run(h); expect(roles(h)).toEqual([R.uA, R.uLeader].sort());
    h.game.profiles.set('c1', profileOf('c1', { militaryUnit: { id: 'mu1', name: 'mu1', role: 'member' } })); await run(h); expect(roles(h)).toEqual([R.uA]);
    h.game.profiles.set('c1', profileOf('c1', { militaryUnit: { id: 'mu2', name: 'mu2', role: 'member' } })); await run(h); expect(roles(h)).toEqual([R.uB]);
    h.game.units = { status: 'ok', data: [unit('mu1', 'eg', 'own1'), unit('mu2', 'eg', 'c1')] }; await run(h); expect(roles(h)).toEqual([R.uB, R.uOwner].sort());
    h.game.units = units(); await run(h); expect(roles(h)).toEqual([R.uB]);
  });
  it('a FOREIGN unit never qualifies, whatever the nationality; a foreign national inside an Egyptian unit does', async () => {
    const h = await world(); await cfg(h); h.game.units = units();
    await inUnit(h, 'd1', 'egy1', 'muF', 'commander', [R.uA, R.uLeader]); await inUnit(h, 'd2', 'sud1', 'mu1', 'member', [], 'sd'); await inUnit(h, 'd3', 'ownF', 'muF', 'commander', [R.uOwner]);
    for (const d of ['d1', 'd2', 'd3']) await run(h, d);
    expect(roles(h, 'd1')).toEqual([]); expect(roles(h, 'd2')).toEqual([R.uA]); expect(roles(h, 'd3')).toEqual([]);
  });
  it('a mapped unit that is not a unit of this country grants nothing (stale / foreign configuration)', async () => {
    const h = await world(); await cfg(h); h.game.units = { status: 'ok', data: [unit('mu1', 'eg', 'own1'), unit('mu2', 'sd', 'own2')] };      // mu2 belongs to Sudan
    await inUnit(h, 'd1', 'm1', 'mu2', 'member', [R.uB]); await run(h); expect(roles(h)).toEqual([]);
  });
  it('a unit list with gaps can still GRANT but never REMOVES; failed lists never change anything', async () => {
    const h = await world(); await cfg(h); h.game.units = { status: 'ok', data: [unit('mu1', 'eg', null), unit('muX', null, null)] };
    await inUnit(h, 'd1', 'm1', 'mu1', 'member', [R.uOwner, R.uA]); await run(h); expect(roles(h)).toEqual([R.uA, R.uOwner].sort());          // owner unknown (gap) -> kept; member proven -> kept
    h.discord.give('A', 'd2', R.uB); await link(h.db, 'A', 'd2', 'm2'); h.game.profiles.set('m2', profileOf('m2', { militaryUnit: { id: 'mu2', name: 'mu2', role: 'member' } })); await run(h, 'd2'); expect(roles(h, 'd2')).toEqual([R.uB]);   // mu2 absent but the list has gaps: not provably foreign
    for (const units2 of [{ status: 'error' as const, message: 'x' }, { status: 'incomplete' as const, missing: ['units[]'] }, { status: 'rate_limited' as const, retryAfterMs: 1 }]) {
      const g = await world(); await cfg(g); g.game.units = units2; await inUnit(g, 'd1', 'm1', 'mu1', 'commander', [R.uA, R.uLeader, R.uOwner]);
      await run(g); expect(roles(g), JSON.stringify(units2)).toEqual([R.uA, R.uLeader, R.uOwner].sort());
    }
  });
  it('is idempotent, and the party list and unit list are requested ONCE per guild-wide run, however many members', async () => {
    const h = await world(); await cfg(h); await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_party_member', entityId: 'pa', discordRoleId: R.pA, actor: null }); h.game.units = units(); h.game.parties = { status: 'ok', data: [party('pa')] };
    for (let i = 0; i < 25; i++) { const p = `m${i}`; await link(h.db, 'A', `d${i}`, p); h.discord.give('A', `d${i}`); h.game.profiles.set(p, profileOf(p, { party: { id: 'pa', name: 'pa', role: 'member' }, militaryUnit: { id: 'mu1', name: 'mu1', role: 'member' } })); }
    await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'u' });
    expect(h.game.reqParties).toBe(1); expect(h.game.reqUnits).toBe(1); expect(roles(h, 'd7')).toEqual([R.pA, R.uA].sort());
    h.discord.calls.length = 0; await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'u' }); expect(h.discord.calls).toEqual([]);
  });
  it('memoizing does not cache failures (a later member retries)', async () => {
    const g = new Game(); g.units = { status: 'error', message: 'x' }; const m = memoizeCountryData(g);
    await m.countryUnits!('eg'); await m.countryUnits!('eg'); expect(g.reqUnits).toBe(2); g.units = { status: 'ok', data: [] }; await m.countryUnits!('eg'); await m.countryUnits!('eg'); expect(g.reqUnits).toBe(3);
  });
});

describe('separation from the specialised party-server / unit-server systems', () => {
  it('a dedicated party server keeps its own member/leader mappings and cannot have the country roles', async () => {
    const h = await setup(); const game = new Game(); (h as { game: FakeGame }).game = game;
    await updateGuildSettings(h.db, 'A', { community_type: 'party', party_id: 'pt_1', modules: { government: false, party: true, unit: false, alliance: false, ranks: false } }, null);
    await map(h.db, 'A', 'party_member', ROLE.party); await map(h.db, 'A', 'party_leader', '300099');
    expect(await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_president', discordRoleId: R.pPres, actor: null })).toMatchObject({ ok: false, code: 'KIND_NOT_ALLOWED' });
    expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_party_member', entityId: 'pt_1', discordRoleId: R.pA, actor: null })).toMatchObject({ ok: false, code: 'NOT_COUNTRY_SERVER' });
    await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1'); game.profiles.set('m1', profileOf('m1', { party: { id: 'pt_1', name: 'P', role: 'leader' } })); await run({ ...h, game }, 'd1');
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([ROLE.party, '300099'].sort());
  });
  it('a dedicated unit server keeps its own mappings and cannot have the country unit roles', async () => {
    const h = await setup(); await updateGuildSettings(h.db, 'A', { community_type: 'military_unit', unit_id: 'mu9', modules: { government: false, party: false, unit: true, alliance: false, ranks: false } }, null);
    expect(await setIdentityRole(h.db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R.uOwner, actor: null })).toMatchObject({ ok: false, code: 'KIND_NOT_ALLOWED' });
    expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_unit_member', entityId: 'mu9', discordRoleId: R.uA, actor: null })).toMatchObject({ ok: false, code: 'NOT_COUNTRY_SERVER' });
    expect(await addRoleMapping(h.db, { guildId: 'A', kind: 'unit_member', discordRoleId: ROLE.party, actor: null })).toEqual({ ok: true });
  });
  it('a country server keeps working per-party mappings of the generic kind alongside the new roles, for a DIFFERENT party (one membership role per party)', async () => {
    const h = await world(); await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_party_member', entityId: 'pt_1', discordRoleId: R.pA, actor: null });
    expect(await addRoleMapping(h.db, { guildId: 'A', kind: 'party_member', gameRef: 'pt_1', discordRoleId: ROLE.party, actor: null })).toMatchObject({ ok: false, code: 'ROLE_ENTITY_DUPLICATE' });   // M1.1: not twice for one party
    expect((await addRoleMapping(h.db, { guildId: 'A', kind: 'party_member', gameRef: 'pt_2', discordRoleId: ROLE.party, actor: null })).ok).toBe(true);
    h.game.parties = { status: 'ok', data: [party('pt_1', 'z'), party('pt_2', 'z')] }; await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1'); h.game.profiles.set('m1', profileOf('m1', { party: { id: 'pt_1', name: 'P', role: 'member' } }));
    await run(h); expect(roles(h)).toEqual([R.pA]);
    h.game.profiles.set('m1', profileOf('m1', { party: { id: 'pt_2', name: 'P', role: 'member' } })); await run(h); expect(roles(h)).toEqual([ROLE.party]);          // moving to the generically mapped party swaps the roles
  });
});
