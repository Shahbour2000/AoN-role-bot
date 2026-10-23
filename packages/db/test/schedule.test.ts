import { beforeEach, describe, expect, it } from 'vitest';
import { claimDueGuilds, getGuildConfig, getSyncStatus, recoverStaleJobs, scheduleRetry, startSyncJob, updateGuildSettings, type Db } from '../src/index.js';
import { addGuild, freshDb, rejects } from './helpers.js';

const T0 = new Date('2026-10-18T00:00:00Z');
const H = 3_600_000, M = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
let db: Db;
beforeEach(async () => { db = await freshDb(); await addGuild(db, 'A'); await addGuild(db, 'B'); });

const next = async (g: string) => (await db.query<{ next_sync_at: Date | null }>('SELECT next_sync_at FROM guilds WHERE guild_id=$1', [g])).rows[0]!.next_sync_at;
const nextMs = async (g: string) => { const n = await next(g); return n === null ? null : new Date(n).getTime() - T0.getTime(); };
const enable = (g: string, minutes: number, now = T0) => updateGuildSettings(db, g, { auto_sync_enabled: true, sync_interval_minutes: minutes }, 'adm', now);
const job = (g: string, kind: string, status: string, createdAt: Date, finishedAt: Date | null = null, counts: object = {}) =>
  db.query(`INSERT INTO sync_jobs (guild_id, kind, status, created_at, finished_at, counts) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [g, kind, status, createdAt.toISOString(), finishedAt?.toISOString() ?? null, JSON.stringify(counts)]);

describe('schedule settings (3 / 6 / 12 / 24 hours)', () => {
  it('only 3, 6, 12 and 24 hours are accepted by the database', async () => {
    for (const m of [180, 360, 720, 1440]) await updateGuildSettings(db, 'A', { sync_interval_minutes: m }, null, T0);
    for (const bad of [1, 30, 60, 90, 240, 600, 2880]) await rejects(updateGuildSettings(db, 'A', { sync_interval_minutes: bad }, null, T0), /check/i);
  });
  it('default is disabled, 6 hours, with no schedule', async () => {
    const c = await getGuildConfig(db, 'A');
    expect(c).toMatchObject({ autoSyncEnabled: false, syncIntervalMinutes: 360, nextSyncAt: null });
  });
  it('enabling schedules now + interval; the choice is persisted and readable back', async () => {
    await enable('A', 720);
    expect(await nextMs('A')).toBe(12 * H);
    const c = await getGuildConfig(db, 'A');
    expect(c).toMatchObject({ autoSyncEnabled: true, syncIntervalMinutes: 720 }); expect(new Date(c!.nextSyncAt!).getTime()).toBe(T0.getTime() + 12 * H);
  });
  it('disabling clears the schedule; the database refuses an enabled guild without a next run', async () => {
    await enable('A', 180); await updateGuildSettings(db, 'A', { auto_sync_enabled: false }, 'adm', T0);
    expect(await next('A')).toBeNull();
    await rejects(db.query(`UPDATE guilds SET auto_sync_enabled=true, next_sync_at=NULL WHERE guild_id='A'`), /check/i);
    await rejects(db.query(`UPDATE guilds SET auto_sync_enabled=false, next_sync_at=now() WHERE guild_id='A'`), /check/i);
  });
  it('changing the interval re-anchors the single schedule (no second one)', async () => {
    await enable('A', 1440);
    await updateGuildSettings(db, 'A', { sync_interval_minutes: 360 }, 'adm', at(1 * H));          // no run yet => anchor = change time
    expect(await nextMs('A')).toBe(7 * H);
    expect((await db.query(`SELECT count(*)::int AS n FROM guilds WHERE guild_id='A' AND next_sync_at IS NOT NULL`)).rows[0]).toEqual({ n: 1 });
  });
  it('re-anchors from the last SCHEDULED run, never earlier than 5 minutes from now', async () => {
    await enable('A', 1440);
    await job('A', 'scheduled', 'succeeded', at(-1 * H), at(-1 * H + 5 * M));
    await updateGuildSettings(db, 'A', { sync_interval_minutes: 360 }, 'adm', T0);
    expect(await nextMs('A')).toBe(5 * H);                                                             // last run (−1h) + 6h
    await job('A', 'scheduled', 'succeeded', at(-5 * H), at(-5 * H + 5 * M));                          // older runs do not matter; newest wins
    await updateGuildSettings(db, 'A', { sync_interval_minutes: 180 }, 'adm', T0);
    expect(await nextMs('A')).toBe(2 * H);                                                             // −1h + 3h
    await updateGuildSettings(db, 'A', { sync_interval_minutes: 360 }, 'adm', at(10 * H));             // overdue anchor => floor of now + 5 min
    expect(await nextMs('A')).toBe(10 * H + 5 * M);
  });
  it('MANUAL runs do not anchor or move the schedule', async () => {
    await enable('A', 360);
    await job('A', 'all', 'succeeded', at(-10 * M), at(-5 * M));
    await updateGuildSettings(db, 'A', { sync_interval_minutes: 720 }, 'adm', T0);
    expect(await nextMs('A')).toBe(12 * H);                                                            // anchored at "now", not at the manual run
  });
  it('re-saving the same values or changing unrelated settings leaves the schedule untouched', async () => {
    await enable('A', 360); const before = await nextMs('A');
    await updateGuildSettings(db, 'A', { auto_sync_enabled: true, sync_interval_minutes: 360 }, 'adm', at(2 * H));
    await updateGuildSettings(db, 'A', { language: 'en', demotion_mode: 'immediate' }, 'adm', at(3 * H));
    expect(await nextMs('A')).toBe(before);
  });
});

describe('claiming due guilds (durable, atomic)', () => {
  it('not due before its time, due at it, and claiming advances the schedule by one interval', async () => {
    await enable('A', 180);
    expect(await claimDueGuilds(db, at(3 * H - 1))).toEqual([]);
    expect(await claimDueGuilds(db, at(3 * H))).toEqual(['A']);
    expect(await nextMs('A')).toBe(6 * H);
    expect(await claimDueGuilds(db, at(3 * H))).toEqual([]);                                           // same slot can never be claimed twice
    expect(await claimDueGuilds(db, at(6 * H - 1))).toEqual([]);
    expect(await claimDueGuilds(db, at(6 * H))).toEqual(['A']);
  });
  it('two workers racing for the same slot: exactly one wins', async () => {
    await enable('A', 180);
    const [x, y] = await Promise.all([claimDueGuilds(db, at(3 * H)), claimDueGuilds(db, at(3 * H))]);
    expect([...x, ...y]).toEqual(['A']);
  });
  it('a long outage yields ONE catch-up run, not one per missed slot', async () => {
    await enable('A', 180);
    expect(await claimDueGuilds(db, at(7 * 24 * H))).toEqual(['A']);
    expect(await claimDueGuilds(db, at(7 * 24 * H + 1))).toEqual([]);
    expect(await nextMs('A')).toBe(7 * 24 * H + 3 * H);
  });
  it('a running job (scheduled or manual) postpones the claim; once finished the guild is claimable again', async () => {
    await enable('A', 180);
    await job('A', 'all', 'running', at(3 * H - 10 * M));
    expect(await claimDueGuilds(db, at(3 * H))).toEqual([]);
    await db.query(`UPDATE sync_jobs SET status='succeeded', finished_at=now() WHERE guild_id='A'`);
    expect(await claimDueGuilds(db, at(3 * H + 1))).toEqual(['A']);
  });
  it('repeated interval changes never create duplicate runs', async () => {
    await enable('A', 180);
    for (const m of [360, 720, 180, 1440, 360, 180]) await updateGuildSettings(db, 'A', { sync_interval_minutes: m }, 'adm', at(5 * M));
    const runs: number[] = [];
    for (let h = 0; h <= 48; h++) { const c = await claimDueGuilds(db, at(h * H)); if (c.length) runs.push(h); }
    // one claim per slot, strictly spaced by the final interval (3 h), never two in the same slot
    expect(runs.length).toBeGreaterThan(0); runs.slice(1).forEach((h, i) => expect(h - runs[i]!).toBeGreaterThanOrEqual(3));
  });
  it('disabled guilds are never claimed', async () => {
    await enable('A', 180); await updateGuildSettings(db, 'A', { auto_sync_enabled: false }, 'adm', T0);
    expect(await claimDueGuilds(db, at(100 * H))).toEqual([]);
  });
  it('scheduleRetry only ever moves the next run EARLIER', async () => {
    await enable('A', 1440);
    await scheduleRetry(db, 'A', T0, 30 * M); expect(await nextMs('A')).toBe(30 * M);
    await scheduleRetry(db, 'A', T0, 6 * H); expect(await nextMs('A')).toBe(30 * M);
    await scheduleRetry(db, 'B', T0, 30 * M); expect(await next('B')).toBeNull();                       // auto-sync off => stays unscheduled
  });
});

describe('worker restart', () => {
  it('the schedule survives: a brand-new connection/worker sees and claims it', async () => {
    await enable('A', 360);
    expect(await recoverStaleJobs(db, at(1 * H))).toBe(0);                                              // nothing interrupted
    expect(await claimDueGuilds(db, at(6 * H))).toEqual(['A']);
  });
  it('an interrupted SCHEDULED run is marked failed and its guild becomes due immediately', async () => {
    await enable('A', 1440);
    await job('A', 'scheduled', 'running', at(-1 * M));
    expect(await recoverStaleJobs(db, at(1 * H))).toBe(1);
    const s = await getSyncStatus(db, 'A');
    expect(s!.running).toBe(false); expect(s!.lastJob!.status).toBe('failed'); expect(s!.lastJob!.error).toMatch(/interrupted/);
    expect(await claimDueGuilds(db, at(1 * H))).toEqual(['A']);                                          // re-run right away, not 24 h later
  });
  it('an interrupted MANUAL run is cleaned up but does not touch the schedule; other guilds are unaffected', async () => {
    await enable('A', 1440); await enable('B', 360);
    await job('A', 'all', 'running', at(-1 * M)); const a0 = await nextMs('A'), b0 = await nextMs('B');
    await recoverStaleJobs(db, at(1 * H));
    expect(await nextMs('A')).toBe(a0); expect(await nextMs('B')).toBe(b0);
  });
});

describe('isolation between guilds', () => {
  it('one guild\'s interval, switch and schedule never affect another', async () => {
    await enable('A', 180); await enable('B', 1440);
    await updateGuildSettings(db, 'A', { sync_interval_minutes: 720 }, 'adm', at(1 * H));
    await updateGuildSettings(db, 'A', { auto_sync_enabled: false }, 'adm', at(2 * H));
    expect(await getGuildConfig(db, 'B')).toMatchObject({ autoSyncEnabled: true, syncIntervalMinutes: 1440 }); expect(await nextMs('B')).toBe(24 * H);
    await enable('A', 180, at(2 * H));
    expect(await claimDueGuilds(db, at(5 * H))).toEqual(['A']);                                          // only A is due
    expect(await nextMs('B')).toBe(24 * H);
  });
});

describe('getSyncStatus', () => {
  it('reports schedule, last SUCCESSFUL run (not a later failure), last result and running state', async () => {
    await enable('A', 360);
    expect(await getSyncStatus(db, 'A')).toMatchObject({ enabled: true, intervalMinutes: 360, running: false, lastSuccess: null, lastJob: null });
    await job('A', 'scheduled', 'succeeded', at(-3 * H), at(-3 * H + 1 * M), { rolesAdded: 4, rolesRemoved: 2 });
    await job('A', 'all', 'failed', at(-1 * H), at(-1 * H + 1 * M));
    const s = (await getSyncStatus(db, 'A'))!;
    expect(s.lastSuccess!.counts).toMatchObject({ rolesAdded: 4, rolesRemoved: 2 }); expect(s.lastJob!.status).toBe('failed'); expect(s.running).toBe(false);
    await startSyncJob(db, { guildId: 'A', kind: 'all', requestedBy: 'x' });
    expect((await getSyncStatus(db, 'A'))!.running).toBe(true);
    expect(await getSyncStatus(db, 'nope')).toBeNull();
  });
});
