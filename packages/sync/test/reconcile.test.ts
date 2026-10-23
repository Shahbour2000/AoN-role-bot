import { describe, expect, it } from 'vitest';
import { claimDueGuilds, getSyncStatus, listSyncJobs, startSyncJob, updateGuildSettings } from '@aon/db';
import { classifyDiscordError, syncGuild, syncOneUser, type GuildSyncDeps } from '../src/index.js';
import { ROLE, citizensOf, discordErr, httpErr, link, map, noSleep, profileOf, rankRole, rosterOf, setup } from './harness.js';

type H = Awaited<ReturnType<typeof setup>>;
const run = async (h: H, user = 'd1', g = 'A') => {
  const r = await syncOneUser({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, g, user);
  if ('error' in r) throw new Error(r.error);
  return r;
};
const roster = (h: H, members: { userId: string; role: string }[]) => { h.game.roster = rosterOf('eg', members); };

describe('1. a qualifying member receives the correct role', () => {
  it('adds every configured office the player holds', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'minister_economy', ROLE.econ);
    roster(h, [{ userId: 'p1', role: 'president' }, { userId: 'p1', role: 'ministerEconomy' }, { userId: 'p2', role: 'congress' }]);
    const r = await run(h);
    expect(r.added.sort()).toEqual([ROLE.pres, ROLE.econ].sort()); expect(r.removed).toEqual([]);
  });
});

describe('2. a former Congress member loses the managed Congress role (and only then)', () => {
  it('detects membership, then removes the role at the next sync once membership ends', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', 'UNRELATED');
    await map(h.db, 'A', 'congress', ROLE.pres);
    roster(h, [{ userId: 'p1', role: 'congress' }, { userId: 'p9', role: 'president' }]);
    await run(h); expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
    roster(h, [{ userId: 'p2', role: 'congress' }, { userId: 'p9', role: 'president' }]);             // complete roster, p1 no longer in it
    const r = await run(h);
    expect(r.removed).toEqual([ROLE.pres]); expect([...h.discord.has('A', 'd1')]).toEqual(['UNRELATED']);
  });
});

describe('3. a former minister loses the corresponding office role; ministerial changes are handled', () => {
  it('moves from Defense to Economy: loses the Defense role and gains the Economy role in one sync', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    await map(h.db, 'A', 'minister_defense', ROLE.vice); await map(h.db, 'A', 'minister_economy', ROLE.econ);
    roster(h, [{ userId: 'p1', role: 'ministerDefense' }, { userId: 'p9', role: 'president' }]); await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([ROLE.vice]);
    roster(h, [{ userId: 'p1', role: 'ministerEconomy' }, { userId: 'p9', role: 'president' }]);
    const r = await run(h);
    expect(r.added).toEqual([ROLE.econ]); expect(r.removed).toEqual([ROLE.vice]); expect([...h.discord.has('A', 'd1')]).toEqual([ROLE.econ]);
  });
  it('a change of government: the new president gets the role, the old one loses it', async () => {
    const h = await setup(); await link(h.db, 'A', 'old', 'p1'); await link(h.db, 'A', 'new', 'p2');
    await map(h.db, 'A', 'president', ROLE.pres); h.discord.give('A', 'old', ROLE.pres); h.discord.give('A', 'new');
    roster(h, [{ userId: 'p2', role: 'president' }, { userId: 'p3', role: 'congress' }]);
    await run(h, 'old'); await run(h, 'new');
    expect(h.discord.has('A', 'old').size).toBe(0); expect(h.discord.has('A', 'new').has(ROLE.pres)).toBe(true);
  });
});

describe('4. a player who changes citizenship loses the old managed country role and receives the new one', () => {
  it('per-country roles: eg -> pl swaps the role; unknown country changes nothing', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', 'UNRELATED');
    await map(h.db, 'A', 'citizen', ROLE.citizen, 'eg'); await map(h.db, 'A', 'citizen', ROLE.party, 'pl');   // two country roles, configured per guild
    h.game.profiles.set('p1', profileOf('p1', { countryId: 'eg' })); await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['UNRELATED', ROLE.citizen].sort());
    h.game.profiles.set('p1', profileOf('p1', { countryId: null })); const unknown = await run(h);
    expect(unknown.removed).toEqual([]);                                                                  // stateless/unknown: not evidence of leaving
    h.game.profiles.set('p1', profileOf('p1', { countryId: 'pl' })); const moved = await run(h);
    expect(moved.removed).toEqual([ROLE.citizen]); expect(moved.added).toEqual([ROLE.party]);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['UNRELATED', ROLE.party].sort());
  });
  it('the server\'s own country role follows the complete citizens list', async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1'); await map(h.db, 'A', 'citizen', ROLE.citizen);
    h.game.citizens = citizensOf('eg', ['p1']); await run(h); expect(h.discord.has('A', 'd1').has(ROLE.citizen)).toBe(true);
    h.game.citizens = citizensOf('eg', ['p2']); await run(h); expect(h.discord.has('A', 'd1').has(ROLE.citizen)).toBe(false);
  });
});

describe('5. party / military unit changes update the role assignments', () => {
  const party = (id: string, role = 'member') => ({ id, name: id, role });
  it('moves between parties and units; leaving removes the role', async () => {
    const h = await setup(); await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: true, alliance: false, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    await map(h.db, 'A', 'party_member', '300001', 'ptA'); await map(h.db, 'A', 'party_member', '300002', 'ptB');
    await map(h.db, 'A', 'unit_member', '300003', 'muA'); await map(h.db, 'A', 'unit_member', '300004', 'muB');
    h.game.profiles.set('p1', profileOf('p1', { party: party('ptA'), militaryUnit: party('muA') })); await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['300001', '300003']);
    h.game.profiles.set('p1', profileOf('p1', { party: party('ptB'), militaryUnit: party('muB') })); const r = await run(h);
    expect(r.removed.sort()).toEqual(['300001', '300003']); expect(r.added.sort()).toEqual(['300002', '300004']);
    h.game.profiles.set('p1', profileOf('p1', { party: null, militaryUnit: party('muB') })); await run(h);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual(['300004']);                                      // left the party, kept the unit
  });
});

describe('6. rank advancement removes the obsolete managed rank role', () => {
  it('advances 2 ranks: exactly one rank role remains', async () => {
    const h = await setup({ withRanks: true }); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(8), 'UNRELATED');
    h.game.damage.set('p1', { status: 'ok', data: 10_000_000 });                                           // major = order 10
    const r = await run(h);
    expect(r.added).toEqual([rankRole(10)]); expect(r.removed).toEqual([rankRole(8)]);
    expect([...h.discord.has('A', 'd1')].sort()).toEqual([rankRole(10), 'UNRELATED'].sort());
  });
  it('cleans up several conflicting rank roles down to one', async () => {
    const h = await setup({ withRanks: true }); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', rankRole(3), rankRole(6), rankRole(10));
    h.game.damage.set('p1', { status: 'ok', data: 10_000_000 }); await run(h);
    expect([...h.discord.has('A', 'd1')]).toEqual([rankRole(10)]);
  });
});

describe('7. unrelated Discord roles are preserved (the bot touches managed roles only)', () => {
  it('every add/remove call targets a configured role', async () => {
    const h = await setup({ withRanks: true }); await link(h.db, 'A', 'd1', 'p1');
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'congress', ROLE.vice);
    const foreign = ['ADMIN_ROLE', 'BOOSTER', 'OTHER_BOT_ROLE', '777000'];
    h.discord.give('A', 'd1', ...foreign, ROLE.pres, rankRole(2));
    roster(h, [{ userId: 'p1', role: 'congress' }, { userId: 'p9', role: 'president' }]); h.game.damage.set('p1', { status: 'ok', data: 5_000_000 });
    await run(h);
    for (const f of foreign) expect(h.discord.has('A', 'd1').has(f)).toBe(true);
    const managed = new Set([ROLE.pres, ROLE.vice, ...Array.from({ length: 17 }, (_, i) => rankRole(i + 1))]);
    for (const call of h.discord.calls) expect(managed.has(call.split(':')[1]!)).toBe(true);
  });
});

describe('8. API errors never cause destructive removals', () => {
  const failures = [{ status: 'error' as const, message: 'HTTP 500' }, { status: 'rate_limited' as const, retryAfterMs: 9000 }, { status: 'not_found' as const }, { status: 'incomplete' as const, missing: ['x'] }];
  it.each(failures.map((f) => [f.status, f] as const))('every data source failing with %s keeps every managed role', async (_n, f) => {
    const h = await setup({ withRanks: true });
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: true, alliance: false, ranks: true } }, null);
    await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', ROLE.pres, ROLE.citizen, ROLE.party, ROLE.unit, ROLE.vice, rankRole(9));
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'citizen', ROLE.citizen); await map(h.db, 'A', 'party_member', ROLE.party);
    await map(h.db, 'A', 'unit_member', ROLE.unit); await map(h.db, 'A', 'citizen', ROLE.vice, 'pl');
    h.game.roster = f; h.game.citizens = f; h.game.profiles.set('p1', f); h.game.damage.set('p1', f);
    const before = new Set(h.discord.has('A', 'd1')); const r = await run(h);
    expect(r.removed).toEqual([]); expect(r.added).toEqual([]); expect(new Set(h.discord.has('A', 'd1'))).toEqual(before); expect(h.discord.calls).toEqual([]);
    expect(r.outcome).toBe('failed');
  });
});

describe('9. incomplete or missing data never removes roles', () => {
  it('partial roster, empty roster, wrong-country roster, partial citizens, null/garbled fields', async () => {
    const h = await setup({ withRanks: true }); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', ROLE.pres, ROLE.citizen, rankRole(9));
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'citizen', ROLE.citizen);
    const { extractGovernmentRoster, extractPlayerProfile } = await import('@aon/client');
    const rosterBodies = [{ countryId: 'eg', count: 14, members: [{ role: 'president', userId: 'p9' }] }, { countryId: 'eg', count: 0, members: [] }, { countryId: 'pl', count: 1, members: [{ role: 'president', userId: 'p9' }] }, {}, { members: 'x' }];
    for (const b of rosterBodies) {
      h.game.roster = extractGovernmentRoster({ status: 'ok', data: b }, 'eg');
      h.game.citizens = { status: 'incomplete', missing: ['citizens (150 collected, total 200)'] };
      h.game.damage.set('p1', { status: 'incomplete', missing: ['damage.all'] });
      const r = await run(h); expect(r.removed, JSON.stringify(b)).toEqual([]);
    }
    h.game.damage.set('p1', { status: 'ok', data: undefined as never });                                    // "ok" but unusable value
    expect((await run(h)).removed).toEqual([]);
    h.game.profiles.set('p1', extractPlayerProfile({ status: 'ok', data: { id: 'p1', username: 'x' } }));  // profile without party/country keys
    expect((await run(h)).removed).toEqual([]);
    expect(h.discord.has('A', 'd1').size).toBe(3);
  });
});

describe('Discord-side failures', () => {
  const setupOne = async () => {
    const h = await setup(); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'minister_economy', ROLE.econ);
    roster(h, [{ userId: 'p1', role: 'president' }, { userId: 'p1', role: 'ministerEconomy' }]); return h;
  };
  it('classifies discord.js errors', () => {
    expect(classifyDiscordError(discordErr(10011)).kind).toBe('role_deleted'); expect(classifyDiscordError(discordErr(10007)).kind).toBe('member_left');
    expect(classifyDiscordError(discordErr(50013)).kind).toBe('missing_permissions'); expect(classifyDiscordError(httpErr(429, { retryAfter: 3 }))).toMatchObject({ kind: 'rate_limited', retryAfterMs: 3000 });
    expect(classifyDiscordError(httpErr(502)).kind).toBe('transient'); expect(classifyDiscordError(new Error('read ECONNRESET')).kind).toBe('transient'); expect(classifyDiscordError(new Error('weird')).kind).toBe('unknown');
  });
  it('a deleted role is reported and does not stop the other roles', async () => {
    const h = await setupOne(); h.discord.errors.set(`+${ROLE.pres}`, [discordErr(10011, 'Unknown Role')]);
    const r = await run(h);
    expect(r.blocked).toEqual([{ roleId: ROLE.pres, why: 'discord_role_deleted' }]); expect(r.added).toEqual([ROLE.econ]); expect(h.discord.attempts.get(`+${ROLE.pres}`)).toBe(1);   // not retried
  });
  it('missing permissions are reported without retrying', async () => {
    const h = await setupOne(); h.discord.errors.set(`+${ROLE.pres}`, [discordErr(50013, 'Missing Permissions', 403)]);
    const r = await run(h); expect(r.blocked[0]).toEqual({ roleId: ROLE.pres, why: 'discord_missing_permissions' }); expect(h.discord.attempts.get(`+${ROLE.pres}`)).toBe(1);
  });
  it('a member who leaves mid-sync is skipped cleanly, with no further operations', async () => {
    const h = await setupOne();
    h.discord.errors.set(`+${ROLE.econ}`, [discordErr(10007, 'Unknown Member')]);                  // the FIRST operation (mapping order) finds the member gone
    const r = await run(h); expect(r.outcome).toBe('skipped'); expect(r.note).toBe('member_left_during_sync');
    expect(h.discord.calls).toEqual([]); expect(h.discord.attempts.has(`+${ROLE.pres}`)).toBe(false);   // nothing was attempted after that
  });
  it('rate limits and transient network errors are retried (bounded) and then succeed', async () => {
    const h = await setupOne(); const sleeps: number[] = [];
    h.discord.errors.set(`+${ROLE.pres}`, [httpErr(429, { retryAfter: 1.5 }), new Error('read ECONNRESET')]);
    const r = await syncOneUser({ db: h.db, game: h.game, discord: h.discord, sleep: async (ms) => { sleeps.push(ms); } }, 'A', 'd1');
    expect('error' in r).toBe(false); expect((r as { added: string[] }).added.sort()).toEqual([ROLE.pres, ROLE.econ].sort());
    expect(sleeps).toEqual([1500, 1500]); expect(h.discord.attempts.get(`+${ROLE.pres}`)).toBe(3);
  });
  it('a persistent outage gives up after 3 attempts and reports it (no infinite retry)', async () => {
    const h = await setupOne(); h.discord.errors.set(`+${ROLE.pres}`, [httpErr(503), httpErr(503), httpErr(503), httpErr(503)]);
    const r = await run(h); expect(r.blocked).toEqual([{ roleId: ROLE.pres, why: 'discord_transient' }]); expect(h.discord.attempts.get(`+${ROLE.pres}`)).toBe(3);
  });
  it('the Discord adapter never deletes roles or edits permissions (source check)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../bot/src/discord-gateway.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/roles\.(delete|create|edit)|\.setPermissions|\.permissions\.(add|remove)|\.delete\(|\.edit\(|\.setPosition|\.setName/);
  });
});

describe('12. concurrent synchronization attempts are safe', () => {
  it('two simultaneous /sync all: one runs, the other is refused; every role is applied exactly once', async () => {
    const h = await setup(); await map(h.db, 'A', 'president', ROLE.pres);
    for (const n of [1, 2, 3]) { await link(h.db, 'A', `d${n}`, `p${n}`); h.discord.give('A', `d${n}`); }
    roster(h, [{ userId: 'p1', role: 'president' }, { userId: 'p2', role: 'congress' }]);
    const deps: GuildSyncDeps = { db: h.db, game: h.game, discord: h.discord, sleep: noSleep };
    const [a, b] = await Promise.all([syncGuild(deps, { guildId: 'A', kind: 'all', requestedBy: 'x' }), syncGuild(deps, { guildId: 'A', kind: 'all', requestedBy: 'y' })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]); expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, code: 'ALREADY_RUNNING' });
    expect(h.discord.calls).toEqual([`+d1:${ROLE.pres}`]);
  });
  it('manual and scheduled runs exclude each other; two syncs of the same member are serialised', async () => {
    const h = await setup(); await map(h.db, 'A', 'president', ROLE.pres); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1'); roster(h, [{ userId: 'p1', role: 'president' }]);
    expect((await startSyncJob(h.db, { guildId: 'A', kind: 'scheduled', requestedBy: null })).ok).toBe(true);
    expect(await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: 'adm' })).toEqual({ ok: false, code: 'ALREADY_RUNNING' });
    const deps = { db: h.db, game: h.game, discord: h.discord, sleep: noSleep };
    const [x, y] = await Promise.all([syncOneUser(deps, 'A', 'd1'), syncOneUser(deps, 'A', 'd1')]);
    expect([x, y].filter((r) => 'error' in r && r.error === 'BUSY').length + [x, y].filter((r) => !('error' in r)).length).toBe(2);
    expect(h.discord.calls.filter((c) => c.startsWith('+')).length).toBe(1);
  });
});

describe('13. manual synchronization works independently of the automatic schedule', () => {
  it('works with auto-sync OFF, and with it ON leaves the schedule exactly as it was', async () => {
    const h = await setup(); await map(h.db, 'A', 'president', ROLE.pres); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1'); roster(h, [{ userId: 'p1', role: 'president' }]);
    const deps = { db: h.db, game: h.game, discord: h.discord, sleep: noSleep };
    expect((await syncGuild(deps, { guildId: 'A', kind: 'all', requestedBy: 'adm' })).ok).toBe(true);        // auto-sync is off by default
    expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 720 }, 'adm', new Date());
    const before = (await h.db.query<{ next_sync_at: Date }>(`SELECT next_sync_at FROM guilds WHERE guild_id='A'`)).rows[0]!.next_sync_at;
    expect((await syncGuild(deps, { guildId: 'A', kind: 'all', requestedBy: 'adm' })).ok).toBe(true);
    const after = (await h.db.query<{ next_sync_at: Date }>(`SELECT next_sync_at FROM guilds WHERE guild_id='A'`)).rows[0]!.next_sync_at;
    expect(new Date(after).getTime()).toBe(new Date(before).getTime());
  });
});

describe('job results, logging and retry scheduling', () => {
  it('records roles added/removed, skip reasons and failed lookups; logs start and end with counts', async () => {
    const h = await setup(); const logs: string[] = [];
    await updateGuildSettings(h.db, 'A', { modules: { government: true, party: false, unit: false, alliance: true, ranks: true } }, null);
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'A', 'alliance_member', ROLE.ally);
    for (const n of [1, 2, 3]) { await link(h.db, 'A', `d${n}`, `p${n}`); }
    h.discord.give('A', 'd1'); h.discord.give('A', 'd2', ROLE.pres); /* d3 left the server */
    roster(h, [{ userId: 'p1', role: 'president' }, { userId: 'p9', role: 'congress' }]);
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep, log: (m) => logs.push(m) }, { guildId: 'A', kind: 'all', requestedBy: 'adm' });
    expect(res.ok && res.counts).toMatchObject({ total: 3, processed: 3, updated: 2, skipped: 1, rolesAdded: 1, rolesRemoved: 1 });
    if (!res.ok) return;
    expect(res.details.skippedReasons).toMatchObject({ alliance_data_unverified: 2, member_not_in_guild: 1 });
    const stored = (await listSyncJobs(h.db, 'A'))[0]!;
    expect(stored.status).toBe('succeeded'); expect(stored.counts).toMatchObject({ rolesAdded: 1, rolesRemoved: 1 }); expect(stored.details).toMatchObject({ skippedReasons: { alliance_data_unverified: 2 } });
    expect(logs[0]).toMatch(/^sync\[guild=A job=.+ kind=all\] start members=3$/);
    expect(logs.at(-1)).toMatch(/end status=succeeded processed=3\/3 updated=2 unchanged=0 partial=0 failed=0 skipped=1 rolesAdded=1 rolesRemoved=1 durationMs=\d+/);
  });
  it('failed API lookups are summarised, never turned into removals', async () => {
    const h = await setup(); await map(h.db, 'A', 'president', ROLE.pres); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1', ROLE.pres);
    h.game.roster = { status: 'rate_limited', retryAfterMs: 5000 };
    const res = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: null });
    if (!res.ok) throw new Error('x');
    expect(res.details.lookupFailures).toEqual({ 'roster:rate_limited': 1 }); expect(res.counts).toMatchObject({ failed: 1, rolesRemoved: 0 }); expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
  });
  it('a FAILED scheduled run is retried within 30 minutes; a successful one keeps the normal interval', async () => {
    const h = await setup(); await map(h.db, 'A', 'president', ROLE.pres); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    const T = new Date(); await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 1440 }, 'adm', T);
    const nextOf = async () => new Date((await h.db.query<{ n: Date }>(`SELECT next_sync_at AS n FROM guilds WHERE guild_id='A'`)).rows[0]!.n).getTime();
    const due = new Date(T.getTime() + 24 * 3_600_000);
    expect(await claimDueGuilds(h.db, due)).toEqual(['A']); expect(await nextOf()).toBe(due.getTime() + 24 * 3_600_000);
    h.game.roster = { status: 'rate_limited', retryAfterMs: 1 };
    const deps = { db: h.db, game: h.game, discord: h.discord, sleep: noSleep, now: () => due, maxConsecutiveRateLimited: 1 };
    const bad = await syncGuild(deps, { guildId: 'A', kind: 'scheduled', requestedBy: null });
    expect(bad.ok && bad.status).toBe('failed'); expect(await nextOf()).toBe(due.getTime() + 30 * 60_000);
    roster(h, [{ userId: 'p1', role: 'president' }]);
    await h.db.query(`UPDATE guilds SET next_sync_at=$1::timestamptz WHERE guild_id='A'`, [new Date(due.getTime() + 24 * 3_600_000).toISOString()]);
    const good = await syncGuild(deps, { guildId: 'A', kind: 'scheduled', requestedBy: null });
    expect(good.ok && good.status).toBe('succeeded'); expect(await nextOf()).toBe(due.getTime() + 24 * 3_600_000);
    expect((await getSyncStatus(h.db, 'A'))!.lastSuccess).not.toBeNull();
  });
});
