import { DEFAULT_RANKS, type RankDefinition } from '@aon/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimLink, forceLink, getLadder, listLinks, reviewLink, saveLadder, seedDefaultLadder, unlink, type Db } from '../src/index.js';
import { addGuild, freshDb, rejects } from './helpers.js';

let db: Db;
beforeEach(async () => { db = await freshDb(); await addGuild(db, 'A'); await addGuild(db, 'B'); });

const withMin = (key: string, minDamage: number): RankDefinition[] => DEFAULT_RANKS.map((r) => (r.key === key ? { ...r, minDamage } : { ...r }));
const actions = async (g: string) => (await db.query<{ action: string }>('SELECT action FROM audit_events WHERE guild_id=$1 ORDER BY id', [g])).rows.map((r) => r.action);

describe('military rank ladder persistence', () => {
  it('saves and reads back the default ladder in order', async () => {
    expect((await seedDefaultLadder(db, 'A')).ok).toBe(true);
    const l = await getLadder(db, 'A');
    expect(l.map((r) => r.minDamage)).toEqual(DEFAULT_RANKS.map((r) => r.minDamage));
  });
  it('rejects an invalid ladder (Lt Colonel < Captain) and leaves the stored ladder untouched', async () => {
    await seedDefaultLadder(db, 'A');
    const res = await saveLadder(db, 'A', withMin('lieutenant_colonel', 1_000_000), 'admin1');
    expect(res.ok).toBe(false);
    const l = await getLadder(db, 'A');
    expect(l.find((r) => r.key === 'lieutenant_colonel')!.minDamage).toBe(20_000_000);
    expect(await actions('A')).toContain('ranks.update_rejected');
  });
  it('database itself refuses a non-monotonic ladder even if validation is bypassed', async () => {
    await rejects(db.tx(async (t) => {
      await t.query(`INSERT INTO military_ranks (guild_id,key,rank_order,name_en,name_ar,min_damage) VALUES ('A','lo',1,'Lo','ل',5000000),('A','hi',2,'Hi','ع',1000000)`);
    }), /higher rank must require more damage/);
    expect((await getLadder(db, 'A'))).toHaveLength(0); // rolled back
  });
  it('rolls the whole replace back if a later insert fails (transactional)', async () => {
    await seedDefaultLadder(db, 'A');
    // Passes validateLadder but is rejected by PostgreSQL on the 6th insert, i.e. AFTER the old ladder was deleted.
    const broken = DEFAULT_RANKS.map((r, i) => ({ ...r, enabled: i === 5 ? ('maybe' as unknown as boolean) : r.enabled }));
    await rejects(saveLadder(db, 'A', broken, 'admin1'), /boolean|invalid input/i);
    const after = await getLadder(db, 'A');
    expect(after).toHaveLength(DEFAULT_RANKS.length);
    expect(after.map((r) => r.minDamage)).toEqual(DEFAULT_RANKS.map((r) => r.minDamage));
  });
  it('is isolated per guild', async () => {
    await seedDefaultLadder(db, 'A');
    await saveLadder(db, 'B', withMin('captain', 6_000_000), 'adminB');
    expect((await getLadder(db, 'A')).find((r) => r.key === 'captain')!.minDamage).toBe(5_000_000);
    expect((await getLadder(db, 'B')).find((r) => r.key === 'captain')!.minDamage).toBe(6_000_000);
  });
  it('persists the 17 starter ranks with Arabic + English names and the enabled flag', async () => {
    await seedDefaultLadder(db, 'A');
    const l = await getLadder(db, 'A');
    expect(l).toHaveLength(17);
    expect(l[0]).toMatchObject({ key: 'soldier', nameAr: 'عسكري', nameEn: 'Soldier', minDamage: 10_000, enabled: true });
    expect(l[16]).toMatchObject({ key: 'field_marshal', nameAr: 'مشير', minDamage: 250_000_000 });
  });
  it('an admin can add, remove, rename, disable and re-map ranks in one save', async () => {
    await seedDefaultLadder(db, 'A');
    const custom: RankDefinition[] = [
      { key: 'recruit', order: 1, nameAr: 'مجند', nameEn: 'Recruit', minDamage: 1_000, discordRoleId: '900001', enabled: true },
      { key: 'veteran', order: 2, nameAr: 'محارب قديم', nameEn: 'Veteran', minDamage: 50_000, discordRoleId: '900002', enabled: true },
      { key: 'legend', order: 3, nameAr: 'أسطورة', nameEn: 'Legend', minDamage: 9_000_000, discordRoleId: null, enabled: false },
    ];
    expect((await saveLadder(db, 'A', custom, 'adm')).ok).toBe(true);
    expect(await getLadder(db, 'A')).toEqual(custom);
  });
  it('db allows a DISABLED rank to sit out of order, but not an enabled one', async () => {
    await seedDefaultLadder(db, 'A');
    await db.query(`UPDATE military_ranks SET enabled=false, min_damage=1 WHERE guild_id='A' AND key='captain'`);
    await rejects(db.query(`UPDATE military_ranks SET enabled=true WHERE guild_id='A' AND key='captain'`), /higher rank must require more damage/);
  });
  it('the same Discord role cannot be mapped to two ranks (validation and DB index)', async () => {
    const dup = DEFAULT_RANKS.map((r) => (r.order <= 2 ? { ...r, discordRoleId: '777777' } : { ...r }));
    expect((await saveLadder(db, 'A', dup, 'adm')).ok).toBe(false);
    await seedDefaultLadder(db, 'A');
    await db.query(`UPDATE military_ranks SET discord_role_id='777777' WHERE guild_id='A' AND key='soldier'`);
    await rejects(db.query(`UPDATE military_ranks SET discord_role_id='777777' WHERE guild_id='A' AND key='corporal'`), /unique|duplicate/i);
    // the same role id in a different guild is fine
    await seedDefaultLadder(db, 'B');
    await db.query(`UPDATE military_ranks SET discord_role_id='777777' WHERE guild_id='B' AND key='soldier'`);
  });
  it('new guilds default to Arabic', async () => {
    const { rows } = await db.query<{ language: string }>(`SELECT language FROM guilds WHERE guild_id='A'`);
    expect(rows[0]!.language).toBe('ar');
  });
  it('db rejects zero thresholds', async () => {
    await rejects(db.query(`INSERT INTO military_ranks (guild_id,key,rank_order,name_en,name_ar,min_damage) VALUES ('A','z',1,'Z','ز',0)`), /check/i);
  });
});

describe('account linking', () => {
  const claim = (g: string, u: string, p: string) => claimLink(db, { guildId: g, discordUserId: u, playerId: p, username: p });

  it('a claim is pending and grants nothing until staff approve', async () => {
    const r = await claim('A', 'u1', 'p1');
    expect(r).toMatchObject({ ok: true, conflict: false });
    expect((await listLinks(db, 'A', 'pending'))).toHaveLength(1);
    expect((await listLinks(db, 'A', 'verified'))).toHaveLength(0);
  });
  it('blocks duplicate pending claims by the same user for the same player', async () => {
    await claim('A', 'u1', 'p1');
    expect(await claim('A', 'u1', 'p1')).toEqual({ ok: false, code: 'DUPLICATE_PENDING' });
  });
  it('flags competing claims on one player, and approval auto-rejects the rival', async () => {
    const a = await claim('A', 'u1', 'p1');
    const b = await claim('A', 'u2', 'p1');
    expect(b).toMatchObject({ ok: true, conflict: true });
    expect((await listLinks(db, 'A', 'pending')).every((l) => l.conflict)).toBe(true);
    expect(await reviewLink(db, { guildId: 'A', linkId: (a as { linkId: string }).linkId, reviewerId: 'mod', approve: true })).toEqual({ ok: true });
    expect((await listLinks(db, 'A', 'verified')).map((l) => l.discord_user_id)).toEqual(['u1']);
    expect((await listLinks(db, 'A', 'rejected')).map((l) => l.discord_user_id)).toEqual(['u2']);
  });
  it('an already-linked player cannot be claimed again', async () => {
    const a = await claim('A', 'u1', 'p1') as { linkId: string };
    await reviewLink(db, { guildId: 'A', linkId: a.linkId, reviewerId: 'mod', approve: true });
    expect(await claim('A', 'u2', 'p1')).toEqual({ ok: false, code: 'PLAYER_ALREADY_LINKED' });
    expect(await claim('A', 'u1', 'p9')).toEqual({ ok: false, code: 'ALREADY_LINKED_SELF' });
  });
  it('cannot be reviewed twice', async () => {
    const a = await claim('A', 'u1', 'p1') as { linkId: string };
    await reviewLink(db, { guildId: 'A', linkId: a.linkId, reviewerId: 'mod', approve: false });
    expect(await reviewLink(db, { guildId: 'A', linkId: a.linkId, reviewerId: 'mod', approve: true })).toEqual({ ok: false, code: 'NOT_PENDING' });
  });
  it('CROSS-GUILD: staff of guild B cannot review a guild A link, even with its id', async () => {
    const a = await claim('A', 'u1', 'p1') as { linkId: string };
    expect(await reviewLink(db, { guildId: 'B', linkId: a.linkId, reviewerId: 'modB', approve: true })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await listLinks(db, 'A', 'pending'))).toHaveLength(1);
    expect(await listLinks(db, 'B')).toHaveLength(0);
  });
  it('the same player may be linked independently in two guilds', async () => {
    const a = await claim('A', 'u1', 'p1') as { linkId: string };
    const b = await claim('B', 'u1', 'p1') as { linkId: string };
    expect((await reviewLink(db, { guildId: 'A', linkId: a.linkId, reviewerId: 'm', approve: true })).ok).toBe(true);
    expect((await reviewLink(db, { guildId: 'B', linkId: b.linkId, reviewerId: 'm', approve: true })).ok).toBe(true);
  });
  it('database unique index prevents two active links for one player even if app checks are bypassed', async () => {
    await db.query(`INSERT INTO account_links (guild_id,discord_user_id,player_id,status,method) VALUES ('A','u1','p1','verified','staff_approved')`);
    await rejects(db.query(`INSERT INTO account_links (guild_id,discord_user_id,player_id,status,method) VALUES ('A','u2','p1','admin_linked','admin_forced')`), /unique|duplicate/i);
  });
});

describe('/force link', () => {
  it('links directly, marked admin_linked, and audited with the reason', async () => {
    const r = await forceLink(db, { guildId: 'A', adminId: 'adm', discordUserId: 'u1', playerId: 'p1', username: 'P1', reason: 'verified in voice' });
    expect(r).toEqual({ ok: true, replaced: [] });
    const [l] = await listLinks(db, 'A', 'admin_linked');
    expect(l).toMatchObject({ discord_user_id: 'u1', method: 'admin_forced' });
    expect(await actions('A')).toContain('link.admin_linked');
  });
  it('refuses to displace an existing link unless replace is explicit', async () => {
    await forceLink(db, { guildId: 'A', adminId: 'adm', discordUserId: 'u1', playerId: 'p1', username: null });
    expect(await forceLink(db, { guildId: 'A', adminId: 'adm', discordUserId: 'u2', playerId: 'p1', username: null })).toEqual({ ok: false, code: 'CONFLICT_REQUIRES_REPLACE' });
    const r = await forceLink(db, { guildId: 'A', adminId: 'adm', discordUserId: 'u2', playerId: 'p1', username: null, replace: true });
    expect(r).toEqual({ ok: true, replaced: ['p1'] });
    expect((await listLinks(db, 'A', 'admin_linked')).map((l) => l.discord_user_id)).toEqual(['u2']);
    expect(await actions('A')).toContain('link.unlinked_by_replace');
  });
  it('unlink works and is audited', async () => {
    await forceLink(db, { guildId: 'A', adminId: 'adm', discordUserId: 'u1', playerId: 'p1', username: null });
    expect(await unlink(db, { guildId: 'A', actorId: 'adm', discordUserId: 'u1' })).toBe(true);
    expect(await listLinks(db, 'A', 'admin_linked')).toHaveLength(0);
    expect(await unlink(db, { guildId: 'A', actorId: 'adm', discordUserId: 'u1' })).toBe(false);
  });
});

describe('integrity guards', () => {
  it('audit log is append-only', async () => {
    await claimLink(db, { guildId: 'A', discordUserId: 'u1', playerId: 'p1', username: null });
    await rejects(db.query(`UPDATE audit_events SET action='x'`), /append-only/);
    await rejects(db.query(`DELETE FROM audit_events`), /append-only/);
  });
  it('audit history survives removing the guild', async () => {
    await claimLink(db, { guildId: 'A', discordUserId: 'u1', playerId: 'p1', username: null });
    await db.query(`DELETE FROM guilds WHERE guild_id='A'`);
    expect(await actions('A')).toContain('link.claimed');
    expect((await db.query(`SELECT 1 FROM account_links WHERE guild_id='A'`)).rows).toHaveLength(0);
  });
  it('only one active server-wide sync job per guild, but other guilds are unaffected', async () => {
    const ins = (g: string, status = 'running') => db.query(`INSERT INTO sync_jobs (guild_id,kind,status) VALUES ($1,'all',$2)`, [g, status]);
    await ins('A');
    await rejects(ins('A', 'queued'), /unique|duplicate/i);
    await ins('B');
    await db.query(`UPDATE sync_jobs SET status='succeeded' WHERE guild_id='A'`);
    await ins('A'); // allowed again once the previous one finished
  });
  it('role mappings cannot be duplicated within a guild but can repeat across guilds', async () => {
    const ins = (g: string) => db.query(`INSERT INTO role_mappings (guild_id,kind,discord_role_id) VALUES ($1,'president','R1')`, [g]);
    await ins('A');
    await rejects(ins('A'), /unique|duplicate/i);
    await ins('B');
  });
});
