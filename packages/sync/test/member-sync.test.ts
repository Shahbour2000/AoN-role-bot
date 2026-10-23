import { describe, expect, it } from 'vitest';
import { syncOneUser } from '../src/index.js';
import { ROLE, citizensOf, link, map, profileOf, rankRole, rosterOf, setup } from './harness.js';
import { getLadder, saveLadder, listActiveLinks } from '@aon/db';
import { DEFAULT_RANKS } from '@aon/core';
import { updateGuildSettings } from '@aon/db';

const run = async (h: Awaited<ReturnType<typeof setup>>, user = 'd1', g = 'A') => {
  const r = await syncOneUser({ db: h.db, game: h.game, discord: h.discord }, g, user);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('government roles', () => {
  it('grants every office a player holds, from the roster (multi-office)', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'minister_economy', ROLE.econ); await map(h.db, 'A', 'vice_president', ROLE.vice);
    h.discord.give('A', 'd1');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }, { userId: 'p1', role: 'ministerEconomy' }, { userId: 'p2', role: 'vicePresident' }]);
    const r = await run(h);
    expect(r.outcome).toBe('updated');
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([ROLE.pres, ROLE.econ].sort());
  });
  it('removes an office role when the player is genuinely no longer in a complete roster', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres);
    h.discord.give('A', 'd1', ROLE.pres, ROLE.other);
    h.game.roster = rosterOf('eg', [{ userId: 'p9', role: 'president' }]);
    await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([ROLE.other]); // unmanaged role untouched
  });
  it('NEVER revokes when the roster is incomplete/failed/rate-limited', async () => {
    for (const roster of [
      { status: 'error' as const, message: 'HTTP 500' }, { status: 'rate_limited' as const, retryAfterMs: 1 }, { status: 'not_found' as const },
      { status: 'incomplete' as const, missing: ['empty roster'] },
    ]) {
      const h = await setup();
      await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres);
      h.discord.give('A', 'd1', ROLE.pres);
      h.game.roster = roster;
      const r = await run(h);
      expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
      expect(r.removed).toEqual([]);
      expect(r.outcome).toBe('failed'); // nothing trustworthy was learned
    }
  });
  it('a genuinely empty roster response is treated as incomplete (cannot mass-revoke)', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres);
    h.discord.give('A', 'd1', ROLE.pres);
    h.game.roster = rosterOf('eg', []);
    await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
  });
  it('maps unknown/new raw roles per guild via government_role + gameRef', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'government_role', ROLE.foreign, 'ministerForeign');
    h.discord.give('A', 'd1');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'ministerForeign' }, { userId: 'p2', role: 'president' }]);
    await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.foreign)).toBe(true);
  });
  it('minister_foreign without a configured raw role does nothing (value unverified)', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'minister_foreign', ROLE.foreign);
    h.discord.give('A', 'd1', ROLE.foreign);
    h.game.roster = rosterOf('eg', [{ userId: 'p2', role: 'president' }]);
    const r = await run(h);
    expect(r.removed).toEqual([]);
  });
  it('disabled government module leaves roles untouched', async () => {
    const h = await setup();
    await updateGuildSettings(h.db, 'A', { modules: { government: false, party: false, unit: false, alliance: false, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres);
    h.discord.give('A', 'd1', ROLE.pres);
    h.game.roster = rosterOf('eg', [{ userId: 'p2', role: 'president' }]);
    const r = await run(h);
    expect(r.outcome).toBe('unchanged');
    expect(h.game.requests.roster).toBe(0);
  });
});

describe('citizen / party / unit (profile based)', () => {
  it('citizen: qualifies when listed, NOT when absent from a COMPLETE list, unchanged when the list is incomplete/failed', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'citizen', ROLE.citizen);
    h.discord.give('A', 'd1');
    h.game.citizens = citizensOf('eg', ['p1', 'p2']);
    await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.citizen)).toBe(true);
    for (const bad of [{ status: 'incomplete' as const, missing: ['citizens (150 collected, total 200)'] }, { status: 'error' as const, message: 'x' }, { status: 'rate_limited' as const }]) {
      h.game.citizens = bad;
      await run(h);
      expect(h.discord.has('A', 'd1').has(ROLE.citizen)).toBe(true);   // a partial list never revokes
    }
    h.game.citizens = citizensOf('eg', ['p2', 'p3']);                    // complete, and p1 is not in it
    await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.citizen)).toBe(false);
    expect(h.game.requests.profile).toBe(0);                             // no per-player profile needed for citizens
  });
  it('party/unit: member of the configured entity qualifies; other or null removes; absent key keeps', async () => {
    const h = await setup();
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: true, alliance: false, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'party_member', ROLE.party); await map(h.db, 'A', 'unit_member', ROLE.unit);
    h.discord.give('A', 'd1');
    h.game.profiles.set('p1', profileOf('p1', { party: { id: 'pt_1', name: 'N', role: 'member' }, militaryUnit: { id: 'mu_9', name: 'D', role: 'member' } }));
    await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([ROLE.party, ROLE.unit].sort());
    h.game.profiles.set('p1', profileOf('p1', { party: { id: 'other', name: 'O', role: 'member' }, militaryUnit: null }));
    await run(h);
    expect(h.discord.has('A', 'd1').size).toBe(0);
    h.discord.give('A', 'd1', ROLE.party);
    const absent = { id: 'p1', username: 'p1', countryId: 'eg', damage: { total: '1' } }; // no party / militaryUnit keys
    h.game.profiles.set('p1', (await import('@aon/client')).extractPlayerProfile({ status: 'ok', data: absent }));
    await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.party)).toBe(true);
  });
  it('party leader = party role "leader"; unit leader = unit role "commander" (observed values); others lose the role', async () => {
    const h = await setup();
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: true, alliance: false, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'party_leader', ROLE.party); await map(h.db, 'A', 'unit_leader', ROLE.unit);
    h.discord.give('A', 'd1');
    h.game.profiles.set('p1', profileOf('p1', { party: { id: 'pt_1', name: 'N', role: 'leader' }, militaryUnit: { id: 'mu_9', name: 'D', role: 'commander' } }));
    await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([ROLE.party, ROLE.unit].sort());
    h.game.profiles.set('p1', profileOf('p1', { party: { id: 'pt_1', name: 'N', role: 'member' }, militaryUnit: { id: 'mu_OTHER', name: 'D', role: 'commander' } }));
    await run(h);
    expect(h.discord.has('A', 'd1').size).toBe(0);                      // plain member / commander of a different unit
  });
  it('alliance roles are never changed (data unverified)', async () => {
    const h = await setup();
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: false, alliance: true, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'alliance_member', ROLE.ally);
    h.discord.give('A', 'd1', ROLE.ally);
    const r = await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.ally)).toBe(true);
    expect(r.skipped.map((s) => s.why)).toEqual(expect.arrayContaining(['alliance_data_unverified']));
  });
  it('a deleted player (profile => not_found) never changes party roles; a renamed player updates the stored username', async () => {
    const h = await setup();
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: false, alliance: false, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'party_member', ROLE.party);
    h.discord.give('A', 'd1', ROLE.party);
    h.game.profiles.set('p1', { status: 'not_found' });
    await run(h);
    expect(h.discord.has('A', 'd1').has(ROLE.party)).toBe(true);
    h.game.profiles.set('p1', profileOf('p1', { username: 'NewName', party: { id: 'pt_1', name: 'N', role: 'member' } }));
    await run(h);
    const { rows } = await h.db.query<{ player_username: string }>(`SELECT player_username FROM account_links WHERE guild_id='A' AND discord_user_id='d1'`);
    expect(rows[0]!.player_username).toBe('NewName');
    void listActiveLinks;
  });
});

describe('military ranks', () => {
  it('promotes: grants new rank role, removes the old one', async () => {
    const h = await setup({ withRanks: true });
    await link(h.db, 'A', 'd1', 'p1');
    h.discord.give('A', 'd1', rankRole(2));
    h.game.damage.set('p1', { status: 'ok', data: 5_000_000 });   // captain = order 9
    await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(9)]);
  });
  it('is idempotent', async () => {
    const h = await setup({ withRanks: true });
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    h.game.damage.set('p1', { status: 'ok', data: 260_000_000 });
    expect((await run(h)).outcome).toBe('updated');
    h.discord.calls.length = 0;
    expect((await run(h)).outcome).toBe('unchanged');
    expect(h.discord.calls).toEqual([]);
  });
  it('failed / incomplete / not-found damage never changes ranks', async () => {
    for (const d of [{ status: 'error' as const, message: 'x' }, { status: 'rate_limited' as const }, { status: 'incomplete' as const, missing: ['damage.all'] }, { status: 'not_found' as const }]) {
      const h = await setup({ withRanks: true });
      await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(6));
      h.game.damage.set('p1', d);
      await run(h);
      expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(6)]);
    }
  });
  it('with the "never" policy a lower reading keeps the rank; the new-guild default (immediate) demotes', async () => {
    const h = await setup({ withRanks: true });
    await updateGuildSettings(h.db, 'A', { demotion_mode: 'never' }, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(12));
    h.game.damage.set('p1', { status: 'ok', data: 600_000 });      // warrant_officer = order 5
    await run(h);
    expect(h.discord.has('A', 'd1').has(rankRole(12))).toBe(true);
    await updateGuildSettings(h.db, 'A', { demotion_mode: 'immediate' }, null);
    await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(5)]);
  });
  it('grace policy starts the clock on the first lower reading and demotes only after the grace period', async () => {
    const h = await setup({ withRanks: true });
    await updateGuildSettings(h.db, 'A', { demotion_mode: 'grace', demotion_grace_days: 7 }, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(12));
    h.game.damage.set('p1', { status: 'ok', data: 600_000 });
    let now = new Date('2026-10-01T00:00:00Z');
    const deps = { db: h.db, game: h.game, discord: h.discord, now: () => now };
    await syncOneUser(deps, 'A', 'd1');
    expect(h.discord.has('A', 'd1').has(rankRole(12))).toBe(true);
    now = new Date('2026-10-05T00:00:00Z'); await syncOneUser(deps, 'A', 'd1');
    expect(h.discord.has('A', 'd1').has(rankRole(12))).toBe(true);
    now = new Date('2026-10-09T00:00:00Z'); await syncOneUser(deps, 'A', 'd1');
    expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(5)]);
  });
  it('REAL SAMPLE: lifetime damage 649601 => warrant_officer role (order 5), independent of the game-native rank', async () => {
    const h = await setup({ withRanks: true });
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    h.game.damage.set('p1', { status: 'ok', data: 649_601 });
    await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(5)]);
  });
  it('the earned rank has no Discord role configured: nothing changes and the reason is reported', async () => {
    const h = await setup({ withRanks: true });
    const ladder = (await getLadder(h.db, 'A')).map((r) => (r.key === 'captain' ? { ...r, discordRoleId: null } : r));
    expect((await saveLadder(h.db, 'A', ladder, null)).ok).toBe(true);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(8));
    h.game.damage.set('p1', { status: 'ok', data: 5_000_000 });
    const r = await run(h);
    expect(r.added).toEqual([]); expect(r.removed).toEqual([]);
    expect(r.skipped.some((x) => x.why === 'rank_role_not_configured')).toBe(true);
  });
  it('a DISABLED rank is never assigned and its role is left alone; ranks can be removed or added per guild', async () => {
    const h = await setup({ withRanks: true });
    const ladder = (await getLadder(h.db, 'A')).map((r) => (r.key === 'captain' ? { ...r, enabled: false } : r));
    await saveLadder(h.db, 'A', ladder, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(9));      // already holds the (now disabled) captain role
    h.game.damage.set('p1', { status: 'ok', data: 5_000_000 });
    await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([rankRole(8), rankRole(9)].sort());   // gets first_lieutenant; captain role untouched
    // a guild with only 2 custom ranks
    const custom = [
      { key: 'rookie', order: 1, nameAr: 'مبتدئ', nameEn: 'Rookie', minDamage: 1_000, discordRoleId: '800001', enabled: true },
      { key: 'pro', order: 2, nameAr: 'محترف', nameEn: 'Pro', minDamage: 100_000, discordRoleId: '800002', enabled: true },
    ];
    await saveLadder(h.db, 'A', custom, null);
    h.discord.give('A', 'd1'); h.game.damage.set('p1', { status: 'ok', data: 150_000 });
    await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual(['800002']);
  });
  it('only rank-group roles are ever removed', async () => {
    const h = await setup({ withRanks: true });
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(3), 'UNRELATED_ROLE', rankRole(6));
    h.game.damage.set('p1', { status: 'ok', data: 649_601 });
    await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([rankRole(5), 'UNRELATED_ROLE'].sort());
  });
  it('rank module disabled => rank roles untouched and no damage lookups', async () => {
    const h = await setup({ withRanks: true });
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: false, unit: false, alliance: false, ranks: false } }, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(6));
    await run(h);
    expect(h.game.requests.damage).toBe(0);
  });
});

describe('Discord constraints and failures', () => {
  it('reports hierarchy-blocked roles and does not attempt them', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres);
    h.discord.give('A', 'd1'); h.discord.assignable = new Set();
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    const r = await run(h);
    expect(r.blocked).toEqual([{ roleId: ROLE.pres, why: 'bot_cannot_assign_role' }]);
    expect(h.discord.calls).toEqual([]);
  });
  it('a failing role add is reported and does not stop other roles', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'minister_economy', ROLE.econ);
    h.discord.give('A', 'd1'); h.discord.failAdd.add(ROLE.pres);
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }, { userId: 'p1', role: 'ministerEconomy' }]);
    const r = await run(h);
    expect(r.added).toEqual([ROLE.econ]);
    expect(r.blocked[0]!.why).toContain('Missing Permissions');
  });
  it('member who left the server is skipped; Discord errors fail safely', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres);
    expect((await run(h)).outcome).toBe('skipped');
    h.discord.give('A', 'd1'); h.discord.memberStatus.set('A:d1', 'error');
    expect((await run(h)).outcome).toBe('failed');
  });
  it('unlinked users cannot be synced; unconfigured guilds are reported', async () => {
    const h = await setup();
    expect(await syncOneUser({ db: h.db, game: h.game, discord: h.discord }, 'A', 'nobody')).toEqual({ error: 'NOT_LINKED' });
    expect(await syncOneUser({ db: h.db, game: h.game, discord: h.discord }, 'ZZZ', 'd1')).toEqual({ error: 'GUILD_NOT_CONFIGURED' });
  });
  it('does not call the game API for data no enabled rule needs', async () => {
    const h = await setup();
    await link(h.db, 'A', 'd1', 'p1'); await map(h.db, 'A', 'president', ROLE.pres); h.discord.give('A', 'd1');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    await run(h);
    expect(h.game.requests).toEqual({ roster: 1, citizens: 0, profile: 0, damage: 0 });
  });
});
