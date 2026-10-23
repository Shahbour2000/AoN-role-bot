import { describe, expect, it } from 'vitest';
import { claimDueGuilds, getSyncStatus, listSyncJobs, recoverStaleJobs, updateGuildSettings, type Db } from '@aon/db';
import { syncGuild } from '@aon/sync';
import { schedulerTick } from '../src/index.js';
import { ROLE, link, map, noSleep, rosterOf, setup } from '../../sync/test/harness.js';

const T0 = new Date(); const H = 3_600_000, M = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
type S = Awaited<ReturnType<typeof setup>>;

/** One "worker process": its own scheduler tick wired to the real sync engine. A restart = a new worker object, same database. */
const worker = (h: Pick<S, 'db' | 'game' | 'discord'>, ran: string[] = [], logs: string[] = []) => ({
  ran, logs,
  tick: (now: Date) => schedulerTick(h.db, now, async (guildId) => { ran.push(guildId); await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep, now: () => now }, { guildId, kind: 'scheduled', requestedBy: null }); }, (m) => logs.push(m)),
});
const nextMs = async (db: Db, g: string) => { const r = (await db.query<{ n: Date | null }>('SELECT next_sync_at AS n FROM guilds WHERE guild_id=$1', [g])).rows[0]!.n; return r === null ? null : new Date(r).getTime() - T0.getTime(); };
const scheduledJobs = async (db: Db, g: string) => (await listSyncJobs(db, g, 100)).filter((j) => j.kind === 'scheduled');
const withMember = async (h: S, g = 'A', userId = 'd1', playerId = 'p1') => {
  await map(h.db, g, 'president', ROLE.pres); await link(h.db, g, userId, playerId); h.discord.give(g, userId);
  h.game.roster = rosterOf('eg', [{ userId: playerId, role: 'president' }, { userId: 'other', role: 'congress' }]);
};

describe('10. the selected interval is persisted and respected', () => {
  it('runs exactly when the interval elapses, then again one interval later', async () => {
    const h = await setup(); await withMember(h); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 360 }, 'adm', T0);
    expect(await w.tick(at(5 * H + 59 * M))).toEqual([]); expect(h.discord.calls).toEqual([]);
    expect(await w.tick(at(6 * H))).toEqual(['A']);
    expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
    expect(await w.tick(at(6 * H + 1))).toEqual([]);                                   // not again in the same slot
    expect(await w.tick(at(11 * H))).toEqual([]);
    expect(await w.tick(at(12 * H))).toEqual(['A']);
    expect((await scheduledJobs(h.db, 'A')).map((j) => j.status)).toEqual(['succeeded', 'succeeded']);
  });
  it.each([[180, 3], [360, 6], [720, 12], [1440, 24]])('%i minutes => every %i hours', async (minutes, hours) => {
    const h = await setup(); await withMember(h); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: minutes }, 'adm', T0);
    expect(await w.tick(at(hours * H - M))).toEqual([]); expect(await w.tick(at(hours * H))).toEqual(['A']);
    expect(await nextMs(h.db, 'A')).toBe(2 * hours * H);
  });
  it('the dashboard-visible status (interval, last success, next run, last result) is consistent', async () => {
    const h = await setup(); await withMember(h); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 720 }, 'adm', T0);
    await w.tick(at(12 * H));
    const st = (await getSyncStatus(h.db, 'A'))!;
    expect(st).toMatchObject({ enabled: true, intervalMinutes: 720, running: false }); expect(new Date(st.nextSyncAt!).getTime()).toBe(T0.getTime() + 24 * H);
    expect(st.lastSuccess!.counts).toMatchObject({ rolesAdded: 1, rolesRemoved: 0, processed: 1 });
  });
});

describe('11. changing the interval does not create duplicate jobs', () => {
  it('a day of hourly ticks with several changes: every claim produces exactly one job, never two in the same slot', async () => {
    const h = await setup(); await withMember(h); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 180 }, 'adm', T0);
    const claimedAt: number[] = [];
    for (let hr = 0; hr <= 30; hr++) {
      if (hr === 5) await updateGuildSettings(h.db, 'A', { sync_interval_minutes: 720 }, 'adm', at(hr * H));
      if (hr === 6) await updateGuildSettings(h.db, 'A', { sync_interval_minutes: 180 }, 'adm', at(hr * H));
      if (hr === 7) await updateGuildSettings(h.db, 'A', { sync_interval_minutes: 1440 }, 'adm', at(hr * H));
      if (hr === 8) await updateGuildSettings(h.db, 'A', { sync_interval_minutes: 360 }, 'adm', at(hr * H));
      if ((await w.tick(at(hr * H))).length) claimedAt.push(hr);
    }
    expect((await scheduledJobs(h.db, 'A')).length).toBe(claimedAt.length);                  // one job per claim, nothing extra
    expect(w.ran.length).toBe(claimedAt.length);
    claimedAt.slice(1).forEach((hr, i) => expect(hr - claimedAt[i]!).toBeGreaterThanOrEqual(3));
    expect(new Set(claimedAt).size).toBe(claimedAt.length);
  });
  it('two workers ticking at the same moment run a due guild once', async () => {
    const h = await setup(); await withMember(h); const a = worker(h), b = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 180 }, 'adm', T0);
    const [x, y] = await Promise.all([a.tick(at(3 * H)), b.tick(at(3 * H))]);
    expect([...x, ...y]).toEqual(['A']); expect((await scheduledJobs(h.db, 'A')).length).toBe(1);
  });
});

describe('13. manual synchronization is independent of the schedule', () => {
  it('a manual run between ticks neither consumes nor delays the automatic run', async () => {
    const h = await setup(); await withMember(h); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 360 }, 'adm', T0);
    const before = await nextMs(h.db, 'A');
    const manual = await syncGuild({ db: h.db, game: h.game, discord: h.discord, sleep: noSleep }, { guildId: 'A', kind: 'all', requestedBy: 'adm' });
    expect(manual.ok && manual.status).toBe('succeeded'); expect(await nextMs(h.db, 'A')).toBe(before);
    expect(await w.tick(at(6 * H))).toEqual(['A']);
    expect((await listSyncJobs(h.db, 'A', 10)).map((j) => j.kind).sort()).toEqual(['all', 'scheduled']);
  });
  it('a manual run that is still going postpones (does not skip) the automatic one', async () => {
    const h = await setup(); await withMember(h); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 180 }, 'adm', T0);
    await h.db.query(`INSERT INTO sync_jobs (guild_id, kind, status) VALUES ('A','all','running')`);
    expect(await w.tick(at(3 * H))).toEqual([]);
    await h.db.query(`UPDATE sync_jobs SET status='succeeded', finished_at=now() WHERE guild_id='A'`);
    expect(await w.tick(at(3 * H + M))).toEqual(['A']);
  });
});

describe('14. synchronization remains operational after a worker restart', () => {
  it('a new worker (fresh process state, same database) continues the schedule', async () => {
    const h1 = await setup(); await withMember(h1); const w1 = worker(h1);
    await updateGuildSettings(h1.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 360 }, 'adm', T0);
    await w1.tick(at(6 * H));
    // --- process dies; a new one starts with new in-memory objects but the same database
    const h2 = { db: h1.db, game: h1.game, discord: h1.discord }; expect(await recoverStaleJobs(h2.db, at(7 * H))).toBe(0);
    const w2 = worker(h2);
    expect(await w2.tick(at(11 * H))).toEqual([]); expect(await w2.tick(at(12 * H))).toEqual(['A']);
    expect(w1.ran).toEqual(['A']); expect(w2.ran).toEqual(['A']);
  });
  it('a run interrupted by the crash is recovered and re-run immediately, not a whole interval later', async () => {
    const h = await setup(); await withMember(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 1440 }, 'adm', T0);
    expect(await claimDueGuilds(h.db, at(24 * H))).toEqual(['A']);                          // worker 1 claimed the slot ...
    await h.db.query(`INSERT INTO sync_jobs (guild_id, kind, status) VALUES ('A','scheduled','running')`);   // ... and died mid-run
    expect(await recoverStaleJobs(h.db, at(24 * H + 5 * M))).toBe(1);
    const w = worker(h);
    expect(await w.tick(at(24 * H + 5 * M))).toEqual(['A']);
    expect(h.discord.has('A', 'd1').has(ROLE.pres)).toBe(true);
    expect((await scheduledJobs(h.db, 'A')).map((j) => j.status).sort()).toEqual(['failed', 'succeeded']);
  });
  it('a long downtime yields one catch-up run per guild, then resumes the normal rhythm', async () => {
    const h = await setup({ guilds: ['A', 'B'] }); await withMember(h, 'A'); await withMember(h, 'B', 'dB', 'pB'); const w = worker(h);
    for (const g of ['A', 'B']) await updateGuildSettings(h.db, g, { auto_sync_enabled: true, sync_interval_minutes: 180 }, 'adm', T0);
    expect(await w.tick(at(10 * 24 * H))).toEqual(['A', 'B']); expect(await w.tick(at(10 * 24 * H + M))).toEqual([]);
    expect((await scheduledJobs(h.db, 'A')).length).toBe(1);
  });
});

describe('15. one server\'s schedule and configuration cannot affect another', () => {
  it('different intervals run independently; changing or disabling one leaves the other untouched', async () => {
    const h = await setup({ guilds: ['A', 'B'] }); await withMember(h, 'A'); await withMember(h, 'B', 'dB', 'pB'); const w = worker(h);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 180 }, 'adm', T0);
    await updateGuildSettings(h.db, 'B', { auto_sync_enabled: true, sync_interval_minutes: 1440 }, 'adm', T0);
    expect(await w.tick(at(3 * H))).toEqual(['A']);
    await updateGuildSettings(h.db, 'A', { auto_sync_enabled: false }, 'adm', at(4 * H));
    expect(await nextMs(h.db, 'B')).toBe(24 * H);
    expect(await w.tick(at(24 * H))).toEqual(['B']);
    expect((await scheduledJobs(h.db, 'A')).length).toBe(1); expect((await scheduledJobs(h.db, 'B')).length).toBe(1);
    expect(h.discord.has('B', 'dB').has(ROLE.pres)).toBe(true);
  });
});

describe('scheduler resilience', () => {
  it('one failing guild does not stop the others, and is retried within 30 minutes', async () => {
    const h = await setup({ guilds: ['A', 'B'] }); const logs: string[] = [];
    for (const g of ['A', 'B']) await updateGuildSettings(h.db, g, { auto_sync_enabled: true, sync_interval_minutes: 1440 }, 'adm', T0);
    const ran: string[] = [];
    const claimed = await schedulerTick(h.db, at(24 * H), async (g) => { ran.push(g); if (g === 'A') throw new Error('boom'); }, (m) => logs.push(m));
    expect(claimed).toEqual(['A', 'B']); expect(ran).toEqual(['A', 'B']); expect(logs[0]).toMatch(/scheduled sync failed for A: boom/);
    expect(await nextMs(h.db, 'A')).toBe(24 * H + 30 * M);                                   // retry soon
    expect(await nextMs(h.db, 'B')).toBe(48 * H);                                            // B keeps its normal rhythm
  });
});
