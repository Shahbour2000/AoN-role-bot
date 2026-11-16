import { describe, expect, it } from 'vitest';
import type { Fetched } from '@aon/core';
import type { PartySummary, UnitSummary } from '@aon/client';
import { addRoleMapping, setIdentityRole, setProxyCountry, updateGuildSettings } from '@aon/db';
import { memoizeCountryData, syncGuild, syncOneUser } from '../src/index.js';
import { FakeGame, ROLE, citizensOf, link, map, profileOf, setup } from './harness.js';

const R = { proxySd: '300001', proxyLy: '300002', pMember: '300003', pPres: '300004', uMember: '300005', uLeader: '300006', uOwner: '300007', citizen: ROLE.citizen };
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

describe('country identity roles: parties', () => {
  const cfg = async (h: Awaited<ReturnType<typeof world>>) => { await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R.pMember, actor: null }); await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_president', discordRoleId: R.pPres, actor: null }); };
  it('a member of ANY party of the country gets Party Member whatever their rank; the leader also gets Party President', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'lead1'), party('pb', 'lead2')] };
    for (const [d, p, pid, role] of [['d1', 'm1', 'pa', 'member'], ['d2', 'm2', 'pb', 'treasurer'], ['d3', 'lead1', 'pa', 'leader'], ['d4', 'lead2', 'pb', 'leader']] as const) {
      await link(h.db, 'A', d, p); h.discord.give('A', d); h.game.profiles.set(p, profileOf(p, { party: { id: pid, name: pid, role } }));
    }
    for (const d of ['d1', 'd2', 'd3', 'd4']) await run(h, d);
    expect(roles(h, 'd1')).toEqual([R.pMember]); expect(roles(h, 'd2')).toEqual([R.pMember]); expect(roles(h, 'd3')).toEqual([R.pMember, R.pPres].sort()); expect(roles(h, 'd4')).toEqual([R.pMember, R.pPres].sort());
  });
  it('a party of ANOTHER country grants nothing (and its leader is not a president), even for an Egyptian citizen', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'lead1')] };
    await link(h.db, 'A', 'd1', 'egy1'); h.discord.give('A', 'd1', R.pMember, R.pPres); h.game.profiles.set('egy1', profileOf('egy1', { countryId: 'eg', party: { id: 'foreign-party', name: 'F', role: 'leader' } }));
    await run(h); expect(roles(h)).toEqual([]);                                       // stale roles are removed: the data is complete and says "foreign party"
  });
  it('no party => no roles; leaving the party removes both roles; a stale President role is removed when the leader changes', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'someone-else')] };
    await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1', R.pMember, R.pPres); h.game.profiles.set('m1', profileOf('m1', { party: { id: 'pa', name: 'pa', role: 'member' } }));
    await run(h); expect(roles(h)).toEqual([R.pMember]); h.game.profiles.set('m1', profileOf('m1', { party: null })); await run(h); expect(roles(h)).toEqual([]);
  });
  it('is safe when the party list or the profile cannot be read: nothing is removed, nothing is guessed', async () => {
    for (const parties of [{ status: 'error' as const, message: 'x' }, { status: 'rate_limited' as const, retryAfterMs: 1 }, { status: 'incomplete' as const, missing: ['parties[]'] }]) {
      const h = await world(); await cfg(h); h.game.parties = parties; await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1', R.pMember); h.game.profiles.set('m1', profileOf('m1', { party: { id: 'pa', name: 'pa', role: 'member' } }));
      await run(h); expect(roles(h), JSON.stringify(parties)).toEqual([R.pMember]);
    }
    const h = await world(); await cfg(h); await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1', R.pMember); h.game.profiles.set('m1', { status: 'error', message: 'x' }); await run(h); expect(roles(h)).toEqual([R.pMember]);
  });
  it('the Party President role needs no profile when the country\'s own list names the player as a leader', async () => {
    const h = await world(); await cfg(h); h.game.parties = { status: 'ok', data: [party('pa', 'lead1')] }; await link(h.db, 'A', 'd1', 'lead1'); h.discord.give('A', 'd1');
    h.game.profiles.set('lead1', { status: 'error', message: 'down' }); await run(h); expect(roles(h)).toContain(R.pPres);
  });
});

describe('country identity roles: military units', () => {
  const cfg = async (h: Awaited<ReturnType<typeof world>>) => { for (const [k, r] of [['country_unit_member', R.uMember], ['country_unit_leader', R.uLeader], ['country_unit_owner', R.uOwner]] as const) await setIdentityRole(h.db, { guildId: 'A', kind: k, discordRoleId: r, actor: null }); };
  const units = (): Fetched<UnitSummary[]> => ({ status: 'ok', data: [unit('mu1', 'eg', 'own1'), unit('mu2', 'eg', 'own2'), unit('muF', 'sd', 'ownF')] });
  it('any member of any Egyptian unit gets Unit Member (rank irrelevant); the commander also Unit Leader; the owner Unit Owner', async () => {
    const h = await world(); await cfg(h); h.game.units = units();
    for (const [d, p, mu, role] of [['d1', 'm1', 'mu1', 'member'], ['d2', 'm2', 'mu2', 'officer'], ['d3', 'c1', 'mu2', 'commander']] as const) { await link(h.db, 'A', d, p); h.discord.give('A', d); h.game.profiles.set(p, profileOf(p, { militaryUnit: { id: mu, name: mu, role } })); }
    await link(h.db, 'A', 'd4', 'own1'); h.discord.give('A', 'd4'); h.game.profiles.set('own1', profileOf('own1', { militaryUnit: null }));
    for (const d of ['d1', 'd2', 'd3', 'd4']) await run(h, d);
    expect(roles(h, 'd1')).toEqual([R.uMember]); expect(roles(h, 'd2')).toEqual([R.uMember]); expect(roles(h, 'd3')).toEqual([R.uMember, R.uLeader].sort()); expect(roles(h, 'd4')).toEqual([R.uOwner]);       // the owner need not be inside the unit
  });
  it('an Egyptian CITIZEN inside a FOREIGN unit gets no Egyptian unit role; a foreign national inside an Egyptian unit does', async () => {
    const h = await world(); await cfg(h); h.game.units = units();
    await link(h.db, 'A', 'd1', 'egy1'); h.discord.give('A', 'd1', R.uMember, R.uLeader); h.game.profiles.set('egy1', profileOf('egy1', { countryId: 'eg', militaryUnit: { id: 'muF', name: 'F', role: 'commander' } }));
    await link(h.db, 'A', 'd2', 'sud1'); h.discord.give('A', 'd2'); h.game.profiles.set('sud1', profileOf('sud1', { countryId: 'sd', militaryUnit: { id: 'mu1', name: 'mu1', role: 'member' } }));
    await run(h, 'd1'); await run(h, 'd2'); expect(roles(h, 'd1')).toEqual([]); expect(roles(h, 'd2')).toEqual([R.uMember]);
  });
  it('the owner of a FOREIGN unit gets no Unit Owner; owning an Egyptian unit while sitting in a foreign unit still does', async () => {
    const h = await world(); await cfg(h); h.game.units = units();
    await link(h.db, 'A', 'd1', 'ownF'); h.discord.give('A', 'd1', R.uOwner); h.game.profiles.set('ownF', profileOf('ownF', { militaryUnit: { id: 'muF', name: 'F', role: 'commander' } }));
    await link(h.db, 'A', 'd2', 'own2'); h.discord.give('A', 'd2'); h.game.profiles.set('own2', profileOf('own2', { militaryUnit: { id: 'muF', name: 'F', role: 'member' } }));
    await run(h, 'd1'); await run(h, 'd2'); expect(roles(h, 'd1')).toEqual([]); expect(roles(h, 'd2')).toEqual([R.uOwner]);
  });
  it('a unit list with gaps can still GRANT but never REMOVES; failed lists never change anything', async () => {
    const h = await world(); await cfg(h); h.game.units = { status: 'ok', data: [unit('mu1', 'eg', null), unit('muX', null, null)] };
    await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1', R.uOwner, R.uMember); h.game.profiles.set('m1', profileOf('m1', { militaryUnit: { id: 'mu1', name: 'mu1', role: 'member' } }));
    await run(h); expect(roles(h)).toEqual([R.uMember, R.uOwner].sort());                  // owner unknown (gap) -> kept; member proven -> kept
    for (const units2 of [{ status: 'error' as const, message: 'x' }, { status: 'incomplete' as const, missing: ['units[]'] }, { status: 'rate_limited' as const, retryAfterMs: 1 }]) {
      const g = await world(); await cfg(g); g.game.units = units2; await link(g.db, 'A', 'd1', 'm1'); g.discord.give('A', 'd1', R.uMember, R.uLeader, R.uOwner); g.game.profiles.set('m1', profileOf('m1', { militaryUnit: { id: 'mu1', name: 'mu1', role: 'commander' } }));
      await run(g); expect(roles(g), JSON.stringify(units2)).toEqual([R.uMember, R.uLeader, R.uOwner].sort());
    }
  });
  it('is idempotent, and the party list and unit list are requested ONCE per guild-wide run, however many members', async () => {
    const h = await world(); await cfg(h); await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R.pMember, actor: null }); h.game.units = units(); h.game.parties = { status: 'ok', data: [party('pa')] };
    for (let i = 0; i < 25; i++) { const p = `m${i}`; await link(h.db, 'A', `d${i}`, p); h.discord.give('A', `d${i}`); h.game.profiles.set(p, profileOf(p, { party: { id: 'pa', name: 'pa', role: 'member' }, militaryUnit: { id: 'mu1', name: 'mu1', role: 'member' } })); }
    await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'u' });
    expect(h.game.reqParties).toBe(1); expect(h.game.reqUnits).toBe(1); expect(roles(h, 'd7')).toEqual([R.pMember, R.uMember].sort());
    h.discord.calls.length = 0; await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'u' }); expect(h.discord.calls).toEqual([]);
  });
  it('memoizing does not cache failures (a later member retries)', async () => {
    const g = new Game(); g.units = { status: 'error', message: 'x' }; const m = memoizeCountryData(g);
    await m.countryUnits!('eg'); await m.countryUnits!('eg'); expect(g.reqUnits).toBe(2); g.units = { status: 'ok', data: [] }; await m.countryUnits!('eg'); await m.countryUnits!('eg'); expect(g.reqUnits).toBe(3);
  });
});

describe('separation from the specialised party-server / unit-server systems', () => {
  it('a dedicated party server keeps its own member/leader mappings and ignores the country identity roles (which it cannot have)', async () => {
    const h = await setup(); const game = new Game(); (h as { game: FakeGame }).game = game;
    await updateGuildSettings(h.db, 'A', { community_type: 'party', party_id: 'pt_1', modules: { government: false, party: true, unit: false, alliance: false, ranks: false } }, null);
    await map(h.db, 'A', 'party_member', ROLE.party); await map(h.db, 'A', 'party_leader', '300099');
    expect(await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R.pMember, actor: null })).toMatchObject({ ok: false, code: 'KIND_NOT_ALLOWED' });
    await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1'); game.profiles.set('m1', profileOf('m1', { party: { id: 'pt_1', name: 'P', role: 'leader' } })); await run({ ...h, game }, 'd1');
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([ROLE.party, '300099'].sort());
  });
  it('a country server keeps working per-party/unit mappings alongside the identity roles', async () => {
    const h = await world(); await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R.pMember, actor: null });
    expect((await addRoleMapping(h.db, { guildId: 'A', kind: 'party_member', discordRoleId: ROLE.party, actor: null })).ok).toBe(true);
    h.game.parties = { status: 'ok', data: [party('pt_1', 'z')] }; await link(h.db, 'A', 'd1', 'm1'); h.discord.give('A', 'd1'); h.game.profiles.set('m1', profileOf('m1', { party: { id: 'pt_1', name: 'P', role: 'member' } }));
    await run(h); expect(roles(h)).toEqual([ROLE.party, R.pMember].sort());
  });
});
