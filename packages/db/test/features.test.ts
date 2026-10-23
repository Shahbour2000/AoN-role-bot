import { DEFAULT_RANKS, type RankDefinition } from '@aon/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { addRoleMapping, claimLink, findLinkForUser, getGuildConfig, getLadder, getRetiredRankRoles, listLinks, saveLadder, seedDefaultLadder, unlinkWithRoles, updateGuildSettings, clearRetiredRankRoles, startSyncJob, finishSyncJob, type Db } from '../src/index.js';
import { addGuild, freshDb, rejects } from './helpers.js';

let db: Db;
beforeEach(async () => { db = await freshDb(); await addGuild(db, 'A'); await addGuild(db, 'B'); });
const withRole = (key: string, role: string | null): RankDefinition[] => DEFAULT_RANKS.map((r) => (r.key === key ? { ...r, discordRoleId: role } : { ...r }));
const auditActions = async (g = 'A') => (await db.query<{ action: string }>('SELECT action FROM audit_events WHERE guild_id=$1 ORDER BY id', [g])).rows.map((r) => r.action);

describe('defaults for a newly installed guild', () => {
  it('Arabic, direct linking, immediate demotion, military ranks OFF, no ladder, unit-leader option off', async () => {
    const c = (await getGuildConfig(db, 'A'))!;
    expect(c).toMatchObject({ language: 'ar', requireStaffApproval: false, linkMode: 'direct', unitLeaderReplacesMember: false, demotion: { mode: 'immediate' } });
    expect(c.modules).toEqual({ government: true, party: false, unit: false, alliance: false, ranks: false });
    expect(await getLadder(db, 'A')).toEqual([]);                                  // the 17 starter ranks appear only when an admin enables the system
  });
  it('link mode and the unit-leader option are per-guild settings', async () => {
    await updateGuildSettings(db, 'A', { require_staff_approval: true, unit_leader_replaces_member: true }, 'adm');
    expect(await getGuildConfig(db, 'A')).toMatchObject({ linkMode: 'staff_approval', unitLeaderReplacesMember: true });
    expect(await getGuildConfig(db, 'B')).toMatchObject({ linkMode: 'direct', unitLeaderReplacesMember: false });
  });
});

describe('direct linking (name-only, ownership not proven)', () => {
  const direct = (g: string, u: string, p: string) => claimLink(db, { guildId: g, discordUserId: u, playerId: p, username: p, direct: true });
  it('is active immediately with method self_direct, stores the stable player id, and is audited as unproven', async () => {
    const r = await direct('A', 'u1', 'p1');
    expect(r).toMatchObject({ ok: true, direct: true, conflict: false });
    expect(await findLinkForUser(db, 'A', 'u1')).toMatchObject({ playerId: 'p1', status: 'verified' });
    const [l] = await listLinks(db, 'A', 'verified'); expect(l).toMatchObject({ method: 'self_direct', discord_user_id: 'u1' });
    const ev = (await db.query<{ details: { ownershipProven: boolean } }>(`SELECT details FROM audit_events WHERE guild_id='A' AND action='link.direct'`)).rows[0]!;
    expect(ev.details.ownershipProven).toBe(false);
  });
  it('refuses a second account for the same Discord user and an account already linked to someone else', async () => {
    await direct('A', 'u1', 'p1');
    expect(await direct('A', 'u1', 'p2')).toEqual({ ok: false, code: 'ALREADY_LINKED_SELF' });
    expect(await direct('A', 'u2', 'p1')).toEqual({ ok: false, code: 'PLAYER_ALREADY_LINKED' });
    expect((await direct('B', 'u2', 'p1')).ok).toBe(true);                        // another guild is independent
  });
  it('two members racing for one game account: exactly one wins, the other gets a clean refusal (no exception)', async () => {
    const [x, y] = await Promise.all([direct('A', 'u1', 'p1'), direct('A', 'u2', 'p1')]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, code: 'PLAYER_ALREADY_LINKED' });
    expect(await listLinks(db, 'A', 'verified')).toHaveLength(1);
  });
  it('a game-side rename never touches the link (links are by stable id); only an explicit unlink removes it', async () => {
    await direct('A', 'u1', 'p1');
    await db.query(`UPDATE account_links SET player_username='NewName' WHERE guild_id='A'`);       // what a sync does on a rename
    expect(await findLinkForUser(db, 'A', 'u1')).toMatchObject({ playerId: 'p1', username: 'NewName', status: 'verified' });
  });
  it('re-linking requires an unlink first, and the old link keeps its history', async () => {
    await direct('A', 'u1', 'p1');
    const removed = await unlinkWithRoles(db, { guildId: 'A', actorId: 'u1', discordUserId: 'u1', action: 'link.unlinked_self' });
    expect(removed).toHaveLength(1); expect(await findLinkForUser(db, 'A', 'u1')).toBeNull();
    expect((await direct('A', 'u1', 'p2')).ok).toBe(true);
    expect((await listLinks(db, 'A', 'unlinked'))).toHaveLength(1);
    expect(await auditActions()).toEqual(expect.arrayContaining(['link.direct', 'link.unlinked_self']));
  });
  it('unlinkWithRoles returns the roles the bot granted (to be taken off the member) and clears them', async () => {
    await direct('A', 'u1', 'p1');
    await db.query(`UPDATE account_links SET managed_role_ids=ARRAY['111111','222222'] WHERE guild_id='A'`);
    const [r] = await unlinkWithRoles(db, { guildId: 'A', actorId: 'mod', discordUserId: 'u1' });
    expect(r).toMatchObject({ playerId: 'p1', managedRoleIds: ['111111', '222222'] });
    expect(await unlinkWithRoles(db, { guildId: 'A', actorId: 'mod', discordUserId: 'u1' })).toEqual([]);
  });
});

describe('a Discord role is either a military-rank role or a mapped role, never both', () => {
  it('mapping a role that is a rank role is refused; ranking a role that is mapped is refused (code level)', async () => {
    await saveLadder(db, 'A', withRole('captain', '500001'), null);
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'president', discordRoleId: '500001', actor: null })).toEqual({ ok: false, code: 'ROLE_CONFLICT' });
    expect((await addRoleMapping(db, { guildId: 'A', kind: 'president', discordRoleId: '500002', actor: null })).ok).toBe(true);
    const res = await saveLadder(db, 'A', withRole('major', '500002'), null);
    expect(res).toMatchObject({ ok: false, code: 'ROLE_CONFLICT', roleIds: ['500002'] });
    expect((await getLadder(db, 'A')).find((r) => r.key === 'captain')!.discordRoleId).toBe('500001');   // unchanged
  });
  it('the database itself rejects both directions even if the application checks are bypassed', async () => {
    await seedDefaultLadder(db, 'A');
    await db.query(`UPDATE military_ranks SET discord_role_id='600001' WHERE guild_id='A' AND key='soldier'`);
    await rejects(db.query(`INSERT INTO role_mappings (guild_id, kind, discord_role_id) VALUES ('A','president','600001')`), /already used as a military rank role/);
    await db.query(`INSERT INTO role_mappings (guild_id, kind, discord_role_id) VALUES ('A','congress','600002')`);
    await rejects(db.query(`UPDATE military_ranks SET discord_role_id='600002' WHERE guild_id='A' AND key='corporal'`), /already used by a role mapping/);
  });
  it('the same role id may be used in another guild', async () => {
    await saveLadder(db, 'A', withRole('captain', '500001'), null);
    expect((await addRoleMapping(db, { guildId: 'B', kind: 'president', discordRoleId: '500001', actor: null })).ok).toBe(true);
  });
});

describe('party roles with the game\'s own role value', () => {
  it('party_role needs the game value; party_leader/party_member stay independent mappings of the same server', async () => {
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'party_role', discordRoleId: '700001', actor: null })).toEqual({ ok: false, code: 'GAME_REF_REQUIRED' });
    expect((await addRoleMapping(db, { guildId: 'A', kind: 'party_role', gameRef: 'treasurer', discordRoleId: '700001', actor: null })).ok).toBe(true);
    expect((await addRoleMapping(db, { guildId: 'A', kind: 'party_role', gameRef: 'council', discordRoleId: '700002', actor: null })).ok).toBe(true);
    expect((await addRoleMapping(db, { guildId: 'A', kind: 'party_leader', discordRoleId: '700003', actor: null })).ok).toBe(true);
    expect((await addRoleMapping(db, { guildId: 'A', kind: 'party_member', discordRoleId: '700004', actor: null })).ok).toBe(true);
    await rejects(db.query(`INSERT INTO role_mappings (guild_id, kind, discord_role_id) VALUES ('A','party_role','700009')`), /check/i);   // DB refuses an empty value too
  });
});

describe('deleting ranks safely', () => {
  it('is refused while a synchronization is running, but edits that remove nothing are still allowed', async () => {
    await seedDefaultLadder(db, 'A');
    const job = await startSyncJob(db, { guildId: 'A', kind: 'all', requestedBy: null });
    const without = DEFAULT_RANKS.filter((r) => r.key !== 'corporal').map((r) => ({ ...r }));
    expect(await saveLadder(db, 'A', without, 'adm')).toMatchObject({ ok: false, code: 'SYNC_RUNNING' });
    expect(await getLadder(db, 'A')).toHaveLength(17);
    expect((await saveLadder(db, 'A', DEFAULT_RANKS.map((r) => (r.key === 'captain' ? { ...r, minDamage: 6_000_000 } : { ...r })), 'adm')).ok).toBe(true);
    if (job.ok) await finishSyncJob(db, job.jobId, 'A', 'succeeded', {});
    expect((await saveLadder(db, 'A', without, 'adm')).ok).toBe(true);               // allowed once the run finished
    expect(await getLadder(db, 'A')).toHaveLength(16);
  });
  it('other guilds\' running syncs do not block this guild', async () => {
    await seedDefaultLadder(db, 'A'); await startSyncJob(db, { guildId: 'B', kind: 'all', requestedBy: null });
    expect((await saveLadder(db, 'A', DEFAULT_RANKS.filter((r) => r.key !== 'corporal').map((r) => ({ ...r })), 'adm')).ok).toBe(true);
  });
});

describe('retired rank roles (deleted ranks are cleaned off members by the next complete sync)', () => {
  it('a deleted rank, or a rank whose role changed, retires the old role; re-using it (rank or mapping) un-retires it', async () => {
    await saveLadder(db, 'A', DEFAULT_RANKS.map((r) => ({ ...r, discordRoleId: r.key === 'corporal' ? '810002' : r.key === 'sergeant' ? '810003' : r.key === 'captain' ? '810009' : null })), null);
    expect(await getRetiredRankRoles(db, 'A')).toEqual([]);
    const next = DEFAULT_RANKS.filter((r) => r.key !== 'corporal').map((r) => ({ ...r, discordRoleId: r.key === 'sergeant' ? '810004' : r.key === 'captain' ? '810009' : null }));
    await saveLadder(db, 'A', next, null);
    expect(await getRetiredRankRoles(db, 'A')).toEqual(['810002', '810003']);        // 810002: rank deleted; 810003: sergeant now uses another role; 810009 unchanged
    await addRoleMapping(db, { guildId: 'A', kind: 'president', discordRoleId: '810002', actor: null });
    expect(await getRetiredRankRoles(db, 'A')).toEqual(['810003']);                  // now a managed office role: no longer a leftover
    await saveLadder(db, 'A', next.map((r) => (r.key === 'major' ? { ...r, discordRoleId: '810003' } : r)), null);
    expect(await getRetiredRankRoles(db, 'A')).toEqual([]);
  });
  it('disabling a rank does not retire its role (disabled = unmanaged by design); other guilds are unaffected', async () => {
    await saveLadder(db, 'A', withRole('captain', '820001'), null);
    await saveLadder(db, 'A', DEFAULT_RANKS.map((r) => (r.key === 'captain' ? { ...r, discordRoleId: '820001', enabled: false } : { ...r })), null);
    expect(await getRetiredRankRoles(db, 'A')).toEqual([]);
    expect(await getRetiredRankRoles(db, 'B')).toEqual([]);
  });
  it('clearRetiredRankRoles removes only roles retired before that job started', async () => {
    await saveLadder(db, 'A', withRole('captain', '830001'), null);
    await saveLadder(db, 'A', DEFAULT_RANKS.filter((r) => r.key !== 'captain').map((r) => ({ ...r })), null);
    const job = await startSyncJob(db, { guildId: 'A', kind: 'all', requestedBy: null });
    if (!job.ok) throw new Error('x');
    await saveLadder(db, 'A', withRole('major', '830002'), null);                      // (re-seeds the ladder; 830002 is a normal rank role now)
    await db.query(`INSERT INTO retired_rank_roles (guild_id, discord_role_id, retired_at) VALUES ('A','830099', now() + interval '1 hour')`);   // retired AFTER the job started
    expect(await clearRetiredRankRoles(db, 'A', job.jobId)).toBeGreaterThanOrEqual(1);
    expect(await getRetiredRankRoles(db, 'A')).toEqual(['830099']);
  });
});
