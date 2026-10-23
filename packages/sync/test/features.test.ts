import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKS } from '@aon/core';
import { getGuildConfig, getLadder, getRetiredRankRoles, listActiveLinks, listRoleMappings, saveLadder, updateGuildSettings } from '@aon/db';
import { syncGuild, syncMember, syncOneUser, type SyncContext } from '../src/index.js';
import { ROLE, citizensOf, link, map, noSleep, profileOf, rankRole, rosterOf, setup } from './harness.js';

type H = Awaited<ReturnType<typeof setup>>;
const run = async (h: H, user = 'd1') => { const r = await syncOneUser({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, 'A', user); if ('error' in r) throw new Error(r.error); return r; };
const mods = (h: H, m: Partial<Record<'government' | 'party' | 'unit' | 'alliance' | 'ranks', boolean>>) =>
  updateGuildSettings(h.db, 'A', { modules: { government: true, party: false, unit: false, alliance: false, ranks: false, ...m } }, null);
const pty = (id: string, role: string) => ({ id, name: id, role });

describe('country server: independent roles, no invented exclusivity', () => {
  it('one player can hold president + vice-president + minister + congress + citizen at the same time', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    for (const [k, r] of [['president', '110001'], ['vice_president', '110002'], ['minister_defense', '110003'], ['congress', '110004'], ['citizen', '110005']] as const) await map(h.db, 'A', k, r);
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }, { userId: 'p1', role: 'vicePresident' }, { userId: 'p1', role: 'ministerDefense' }, { userId: 'p1', role: 'congress' }]);
    h.game.citizens = citizensOf('eg', ['p1']);
    await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['110001', '110002', '110003', '110004', '110005']);
  });
  it('a foreign-affairs minister is mapped through the game\'s own role value (not guessed); unknown values are reported', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    await map(h.db, 'A', 'minister_foreign', '120001', 'ministerForeign');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'ministerForeign' }, { userId: 'p9', role: 'president' }]);
    expect((await run(h)).added).toEqual(['120001']);
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: null });
    if (!res.ok) throw new Error('x'); expect(res.details.seenRoles.governmentUnknown).toEqual(['ministerForeign']);
  });
});

describe('party server: leader, treasurer, council and member are independent', () => {
  const setupParty = async () => {
    const h = await setup(); await mods(h, { party: true }); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    await map(h.db, 'A', 'party_leader', '210001'); await map(h.db, 'A', 'party_role', '210002', 'treasurer'); await map(h.db, 'A', 'party_role', '210003', 'council'); await map(h.db, 'A', 'party_member', '210004');
    return h;
  };
  it('the leader also receives the member role and no other party role; each role follows the game\'s role value', async () => {
    const h = await setupParty();
    h.game.profiles.set('p1', profileOf('p1', { party: pty('pt_1', 'leader') })); await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['210001', '210004']);
    h.game.profiles.set('p1', profileOf('p1', { party: pty('pt_1', 'treasurer') })); await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['210002', '210004']);                    // leader role removed, treasurer role + membership
    h.game.profiles.set('p1', profileOf('p1', { party: pty('pt_1', 'council') })); await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['210003', '210004']);
  });
  it('a member of ANOTHER party gets none of this party\'s roles; leaving removes them all; an unknown profile removes nothing', async () => {
    const h = await setupParty(); h.discord.give('A', 'd1', '210001', '210002', '210004');
    h.game.profiles.set('p1', { status: 'error', message: 'x' }); await run(h); expect(h.discord.has('A', 'd1').size).toBe(3);
    h.game.profiles.set('p1', profileOf('p1', { party: pty('pt_OTHER', 'leader') })); await run(h); expect(h.discord.has('A', 'd1').size).toBe(0);
  });
  it('without the game value a party_role mapping does nothing (and says why)', async () => {
    const h = await setup(); await mods(h, { party: true }); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', '210002');
    await h.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','party_member','','210004')`);
    await map(h.db, 'A', 'party_role', '210002', 'treasurer');
    h.game.profiles.set('p1', profileOf('p1', { party: pty('pt_1', 'treasurer') })); const r = await run(h);
    expect(r.removed).toEqual([]);
  });
  it('discovers the role values the game reports so admins know what to map', async () => {
    const h = await setupParty();
    for (const [n, role] of [[1, 'leader'], [2, 'treasurer'], [3, 'council'], [4, 'council']] as const) { await link(h.db, 'A', `d${n + 10}`, `q${n}`); h.discord.give('A', `d${n + 10}`); h.game.profiles.set(`q${n}`, profileOf(`q${n}`, { party: pty('pt_1', role) })); }
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: null });
    if (!res.ok) throw new Error('x'); expect(res.details.seenRoles.party).toEqual({ leader: 1, treasurer: 1, council: 2 });
  });
});

describe('military-unit server: member and leader, optional "leader replaces member"', () => {
  const setupUnit = async (replace: boolean) => {
    const h = await setup(); await mods(h, { unit: true }); await updateGuildSettings(h.db, 'A', { unit_leader_replaces_member: replace }, null);
    await link(h.db, 'A', 'cmd', 'p1'); await link(h.db, 'A', 'mem', 'p2'); h.discord.give('A', 'cmd'); h.discord.give('A', 'mem');
    await map(h.db, 'A', 'unit_member', '310001'); await map(h.db, 'A', 'unit_leader', '310002');
    h.game.profiles.set('p1', profileOf('p1', { militaryUnit: pty('mu_9', 'commander') })); h.game.profiles.set('p2', profileOf('p2', { militaryUnit: pty('mu_9', 'member') }));
    return h;
  };
  it('default: the commander has BOTH roles', async () => {
    const h = await setupUnit(false); await run(h, 'cmd'); await run(h, 'mem');
    expect([...h.discord.has('A', 'cmd')].sort()).toEqual(['310001', '310002']); expect([...h.discord.has('A', 'mem')]).toEqual(['310001']);
  });
  it('with "leader replaces member": the commander has only the leader role, regular members are unaffected, and turning it off restores both', async () => {
    const h = await setupUnit(true); h.discord.give('A', 'cmd', '310001');
    await run(h, 'cmd'); await run(h, 'mem');
    expect([...h.discord.has('A', 'cmd')]).toEqual(['310002']); expect([...h.discord.has('A', 'mem')]).toEqual(['310001']);
    await updateGuildSettings(h.db, 'A', { unit_leader_replaces_member: false }, null); await run(h, 'cmd');
    expect([...h.discord.has('A', 'cmd')].sort()).toEqual(['310001', '310002']);
  });
  it('being a unit leader never grants any political or military role by itself', async () => {
    const h = await setupUnit(true);
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'congress', ROLE.vice); await map(h.db, 'A', 'citizen', ROLE.citizen);
    h.game.roster = rosterOf('eg', [{ userId: 'p9', role: 'president' }, { userId: 'p8', role: 'congress' }]); h.game.citizens = citizensOf('eg', ['p9']);
    await run(h, 'cmd');
    expect([...h.discord.has('A', 'cmd')]).toEqual(['310002']);
  });
  it('a member of another unit gets neither role', async () => {
    const h = await setupUnit(false); h.game.profiles.set('p1', profileOf('p1', { militaryUnit: pty('mu_OTHER', 'commander') })); h.discord.give('A', 'cmd', '310001', '310002');
    await run(h, 'cmd'); expect(h.discord.has('A', 'cmd').size).toBe(0);
  });
});

describe('alliance server: not implemented (no verified API data) — nothing is changed', () => {
  it('alliance mappings never add or remove a role, and the reason is reported', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', '410001');
    await mods(h, { alliance: true }); await map(h.db, 'A', 'alliance_member', '410001');
    h.game.profiles.set('p1', profileOf('p1'));
    const r = await run(h);
    expect(r.removed).toEqual([]); expect(r.added).toEqual([]); expect(h.discord.has('A', 'd1').has('410001')).toBe(true);
    expect(r.skipped.map((s) => s.why)).toContain('alliance_data_unverified');
  });
});

describe('retired rank roles are cleaned off members by the next COMPLETE sync', () => {
  const setupRanks = async () => {
    const h = await setup({ withRanks: true }); await updateGuildSettings(h.db, 'A', { demotion_mode: 'immediate' }, null);
    await link(h.db, 'A', 'd1', 'p1'); await link(h.db, 'A', 'd2', 'p2');
    h.discord.give('A', 'd1', rankRole(3), 'UNRELATED'); h.discord.give('A', 'd2', rankRole(3));
    h.game.damage.set('p1', { status: 'ok', data: 600_000 }); h.game.damage.set('p2', { status: 'ok', data: 600_000 });        // both are warrant officers (order 5)
    return h;
  };
  const deleteRank = async (h: H, key: string) => { const l = (await getLadder(h.db, 'A')).filter((r) => r.key !== key); expect((await saveLadder(h.db, 'A', l, 'adm')).ok).toBe(true); };
  it('deleting the "sergeant" rank: its Discord role is taken off members (and only that role), then forgotten', async () => {
    const h = await setupRanks(); await deleteRank(h, 'sergeant');                                // sergeant = order 3
    expect(await getRetiredRankRoles(h.db, 'A')).toEqual([rankRole(3)]);
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: 'adm' });
    expect(res.ok && res.counts.rolesRemoved).toBeGreaterThanOrEqual(2);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['UNRELATED', rankRole(5)].sort());
    expect(h.discord.has('A', 'd2').has(rankRole(3))).toBe(false);
    expect(await getRetiredRankRoles(h.db, 'A')).toEqual([]);                                        // complete, clean sync => forgotten
  });
  it('retired removal needs no game data: it happens even when the API is down, but the role stays queued if a member could not be processed', async () => {
    const h = await setupRanks(); await deleteRank(h, 'sergeant');
    h.game.damage.set('p1', { status: 'error', message: 'HTTP 500' }); h.game.damage.set('p2', { status: 'error', message: 'HTTP 500' });
    await run(h, 'd1');
    expect(h.discord.has('A', 'd1').has(rankRole(3))).toBe(false);
    h.discord.memberStatus.set('A:d2', 'error');
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect(res.ok && res.counts.failed).toBeGreaterThanOrEqual(1);
    expect(await getRetiredRankRoles(h.db, 'A')).toEqual([rankRole(3)]);                             // d2 could not be cleaned => keep trying
  });
  it('a role the bot cannot manage (hierarchy) is reported, kept in the queue, and never forced', async () => {
    const h = await setupRanks(); await deleteRank(h, 'sergeant'); h.discord.assignable = new Set(Array.from({ length: 17 }, (_, i) => rankRole(i + 1)).filter((r) => r !== rankRole(3)));
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect(res.ok && res.details.blockedReasons['bot_cannot_remove_role']).toBe(2); expect(h.discord.has('A', 'd2').has(rankRole(3))).toBe(true);
    expect(await getRetiredRankRoles(h.db, 'A')).toEqual([rankRole(3)]);
  });
  it('changing thresholds, or editing/disabling ranks, is reflected by the next sync; changing a threshold up demotes under the default policy', async () => {
    const h = await setupRanks();
    const raise = (await getLadder(h.db, 'A')).map((r) => (r.key === 'warrant_officer' ? { ...r, minDamage: 650_000 } : r));      // 600k no longer qualifies
    expect((await saveLadder(h.db, 'A', raise, 'adm')).ok).toBe(true);
    await run(h, 'd1');
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['UNRELATED', rankRole(4)].sort());                                          // sergeant_first_class (200k..650k)
  });
});

describe('military ranks are exclusive even when syncs overlap', () => {
  it('two overlapping syncs of the same member never leave two rank roles (serialised per member)', async () => {
    const h = await setup({ withRanks: true }); await updateGuildSettings(h.db, 'A', { demotion_mode: 'immediate' }, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(7)); h.discord.delayMs = 15;
    const ctx = async (): Promise<SyncContext> => ({ db: h.db, game: h.game, discord: h.discord, now: () => new Date(), sleep: noSleep, cfg: (await getGuildConfig(h.db, 'A'))!, mappings: await listRoleMappings(h.db, 'A'), ladder: await getLadder(h.db, 'A') });
    const l = (await listActiveLinks(h.db, 'A'))[0]!;
    h.game.damage.set('p1', { status: 'ok', data: 10_000_000 });                                          // first sync: major (order 10)
    const first = syncMember(await ctx(), l);
    await new Promise((r) => setTimeout(r, 5));                                                          // first is now mid-flight (slow Discord)
    h.game.damage.set('p1', { status: 'ok', data: 600_000 });                                            // data changes: warrant officer (order 5)
    const second = syncMember(await ctx(), l);
    await Promise.all([first, second]);
    const ranks = [...h.discord.has('A', 'd1')].filter((r) => /^2000\d\d$/.test(r));
    expect(ranks).toEqual([rankRole(5)]);                                                                // exactly ONE rank role, from the latest data
  });
  it('a member holding two rank roles (manual mistake, old data) is repaired to one', async () => {
    const h = await setup({ withRanks: true }); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(2), rankRole(9), rankRole(10));
    h.game.damage.set('p1', { status: 'ok', data: 10_000_000 }); await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(10)]);
  });
  it('with the rank system disabled the bot neither grants nor removes any rank role', async () => {
    const h = await setup({ withRanks: true }); await mods(h, {}); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(2));
    h.game.damage.set('p1', { status: 'ok', data: 10_000_000 }); const r = await run(h);
    expect(r.added).toEqual([]); expect(r.removed).toEqual([]); expect(h.game.requests.damage).toBe(0);
  });
});

void DEFAULT_RANKS;
