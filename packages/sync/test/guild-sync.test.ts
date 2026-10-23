import { describe, expect, it } from 'vitest';
import { cancelSyncJob, startSyncJob } from '@aon/db';
import { syncGuild } from '../src/index.js';
import { ROLE, link, map, rosterOf, setup } from './harness.js';

describe('/sync all', () => {
  it('syncs every active link, isolates failures per user, and reports counts', async () => {
    const h = await setup();
    await map(h.db, 'A', 'president', ROLE.pres);
    for (const n of [1, 2, 3, 4]) { await link(h.db, 'A', `d${n}`, `p${n}`); }
    h.discord.give('A', 'd1'); h.discord.give('A', 'd2'); h.discord.give('A', 'd3', ROLE.pres); /* d4 not in guild */
    h.discord.memberStatus.set('A:d2', 'error');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    const r = await syncGuild({ db: h.db, game: h.game, discord: h.discord, batchSize: 2 }, { guildId: 'A', kind: 'all', requestedBy: 'adm' });
    expect(r.ok && r.status).toBe('succeeded');
    if (!r.ok) return;
    expect(r.counts).toMatchObject({ total: 4, processed: 4, updated: 2, failed: 1, skipped: 1, notProcessed: 0 });
    expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
    expect(h.discord.has('A', 'd3').has(ROLE.pres)).toBe(false);
  });
  it('fetches the roster ONCE for the whole run (memoised), and a failed fetch is retried instead of cached', async () => {
    const h = await setup();
    await map(h.db, 'A', 'president', ROLE.pres);
    for (const n of [1, 2, 3]) { await link(h.db, 'A', `d${n}`, `p${n}`); h.discord.give('A', `d${n}`); }
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect(h.game.requests.roster).toBe(1);   // roster fetched once per run and shared by every member
  });
  it('refuses a second concurrent job for the same guild, but other guilds may run', async () => {
    const h = await setup({ guilds: ['A', 'B'] });
    await startSyncJob(h.db, { guildId: 'A', kind: 'all', requestedBy: null });
    const dup = await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect(dup).toEqual({ ok: false, code: 'ALREADY_RUNNING' });
    expect((await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'B', kind: 'all', requestedBy: null })).ok).toBe(true);
  });
  it('can be cancelled mid-run via the job row, finishing as cancelled', async () => {
    const h = await setup();
    await map(h.db, 'A', 'president', ROLE.pres);
    for (const n of [1, 2, 3, 4]) { await link(h.db, 'A', `d${n}`, `p${n}`); h.discord.give('A', `d${n}`); }
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    const r = await syncGuild({ db: h.db, game: h.game, discord: h.discord, batchSize: 1 }, {
      guildId: 'A', kind: 'all', requestedBy: 'adm',
      onProgress: (c) => { if (c.processed === 1) void cancelSyncJob(h.db, 'A', 'adm'); },
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.ok && r.status).toBe('cancelled');
    if (r.ok) expect(r.counts.processed).toBeLessThan(4);
  });
  it('stops early on repeated rate limiting and never touches roles', async () => {
    const h = await setup();
    await map(h.db, 'A', 'president', ROLE.pres);
    for (const n of [1, 2, 3, 4, 5]) { await link(h.db, 'A', `d${n}`, `p${n}`); h.discord.give('A', `d${n}`, ROLE.pres); }
    h.game.roster = { status: 'rate_limited', retryAfterMs: 120_000 };
    const r = await syncGuild({ db: h.db, game: h.game, discord: h.discord, maxConsecutiveRateLimited: 3 }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect(r.ok && r.status).toBe('failed');
    if (!r.ok) return;
    expect(r.counts.processed).toBe(3);
    expect(r.counts.notProcessed).toBe(2);
    expect(r.error).toMatch(/rate_limited/);
    for (const n of [1, 2, 3, 4, 5]) expect(h.discord.has('A', `d${n}`).has(ROLE.pres)).toBe(true);
  });
  it('CROSS-GUILD: each guild only uses its own links, mappings and roles', async () => {
    const h = await setup({ guilds: ['A', 'B'] });
    await map(h.db, 'A', 'president', ROLE.pres); await map(h.db, 'B', 'president', ROLE.vice);
    await link(h.db, 'A', 'dA', 'p1'); await link(h.db, 'B', 'dB', 'p1');
    h.discord.give('A', 'dA'); h.discord.give('B', 'dB');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect([...h.discord.has('A', 'dA')]).toEqual([ROLE.pres]);
    expect(h.discord.has('B', 'dB').size).toBe(0);           // B untouched by A's run
    await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'B', kind: 'all', requestedBy: null });
    expect([...h.discord.has('B', 'dB')]).toEqual([ROLE.vice]);
  });
  it('an unconfigured guild is reported, and a second run changes nothing (idempotent)', async () => {
    const h = await setup();
    expect(await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'nope', kind: 'all', requestedBy: null })).toEqual({ ok: false, code: 'GUILD_NOT_CONFIGURED' });
    await map(h.db, 'A', 'president', ROLE.pres); await link(h.db, 'A', 'd1', 'p1'); h.discord.give('A', 'd1');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: null });
    h.discord.calls.length = 0;
    const second = await syncGuild({ db: h.db, game: h.game, discord: h.discord }, { guildId: 'A', kind: 'all', requestedBy: null });
    expect(second.ok && second.counts.unchanged).toBe(1);
    expect(h.discord.calls).toEqual([]);
  });
});

describe('memoizeCountryData', () => {
  it('caches successful roster/citizens per run but never caches failures', async () => {
    const { memoizeCountryData } = await import('../src/index.js');
    const h = await setup();
    const g = memoizeCountryData(h.game);
    h.game.roster = { status: 'error', message: 'boom' };
    expect((await g.governmentRoster('eg')).status).toBe('error');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    expect((await g.governmentRoster('eg')).status).toBe('ok');      // failure was not cached
    await g.governmentRoster('eg'); await g.governmentRoster('eg');
    expect(h.game.requests.roster).toBe(2);                            // 1 failed + 1 ok, then served from memory
    h.game.citizens = { status: 'rate_limited' };
    await g.countryCitizens('eg'); await g.countryCitizens('eg');
    expect(h.game.requests.citizens).toBe(2);                          // rate-limited results are retried each time
  });
});
