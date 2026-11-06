import { DEFAULT_RANKS } from '@aon/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { addRoleMapping, getBuildRoles, getRetiredRankRoles, listRoleMappings, saveLadder, setBuildRoles, type Db } from '../src/index.js';
import { addGuild, freshDb, rejects } from './helpers.js';

let db: Db;
beforeEach(async () => { db = await freshDb(); await addGuild(db, 'A'); await addGuild(db, 'B'); });
const set = (g: string, roles: Parameters<typeof setBuildRoles>[1]['roles']) => setBuildRoles(db, { guildId: g, roles, actor: 'adm' });

describe('permanent build roles (War / Eco / Hybrid)', () => {
  it('start empty; each build is set independently; unmentioned builds stay unchanged; null clears', async () => {
    expect(await getBuildRoles(db, 'A')).toEqual({ war: null, eco: null, hybrid: null });
    expect((await set('A', { war: '100001', eco: '100002' })).ok).toBe(true);
    expect(await getBuildRoles(db, 'A')).toEqual({ war: '100001', eco: '100002', hybrid: null });
    expect((await set('A', { hybrid: '100003' })).ok).toBe(true); expect(await getBuildRoles(db, 'A')).toEqual({ war: '100001', eco: '100002', hybrid: '100003' });
    expect((await set('A', { eco: null })).ok).toBe(true); expect(await getBuildRoles(db, 'A')).toEqual({ war: '100001', eco: null, hybrid: '100003' });
  });
  it('the same Discord role cannot serve two builds, even when set in separate calls', async () => {
    expect(await set('A', { war: '100001', eco: '100001' })).toEqual({ ok: false, code: 'DUPLICATE_ROLE' });
    await set('A', { war: '100001' });
    expect(await set('A', { hybrid: '100001' })).toEqual({ ok: false, code: 'DUPLICATE_ROLE' });
    expect(await getBuildRoles(db, 'A')).toEqual({ war: '100001', eco: null, hybrid: null });
  });
  it('malformed role ids are refused; a rank role or an office/membership role cannot be a build role', async () => {
    expect(await set('A', { war: 'not-an-id' })).toMatchObject({ ok: false, code: 'ROLE_INVALID' });
    await saveLadder(db, 'A', DEFAULT_RANKS.map((r) => (r.key === 'captain' ? { ...r, discordRoleId: '200001' } : { ...r })), null);
    await addRoleMapping(db, { guildId: 'A', kind: 'president', discordRoleId: '200002', actor: null });
    expect(await set('A', { war: '200001' })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT', roleIds: ['200001'] });
    expect(await set('A', { eco: '200002' })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT', roleIds: ['200002'] });
  });
  it('the other direction too: a build role cannot later be used as a rank role (database trigger)', async () => {
    await set('A', { war: '300001' });
    expect((await saveLadder(db, 'A', DEFAULT_RANKS.map((r) => (r.key === 'captain' ? { ...r, discordRoleId: '300001' } : { ...r })), null)).ok).toBe(false);
  });
  it('replacing or clearing a build role retires the old one; re-using it un-retires it', async () => {
    await set('A', { war: '400001', eco: '400002' }); await set('A', { war: '400003' }); await set('A', { eco: null });
    expect(await getRetiredRankRoles(db, 'A')).toEqual(['400001', '400002']);
    await set('A', { hybrid: '400002' }); expect(await getRetiredRankRoles(db, 'A')).toEqual(['400001']);
    await set('A', { war: '400003' }); expect(await getRetiredRankRoles(db, 'A')).toEqual(['400001']);
  });
  it('is strictly isolated per server', async () => {
    await set('A', { war: '500001' }); await set('B', { war: '500001', eco: '500002' });
    expect(await getBuildRoles(db, 'A')).toEqual({ war: '500001', eco: null, hybrid: null }); expect(await getBuildRoles(db, 'B')).toEqual({ war: '500001', eco: '500002', hybrid: null });
    await set('B', { war: null }); expect((await getBuildRoles(db, 'A')).war).toBe('500001');
  });
  it('the database enforces one role per build and one build per role even if the repository is bypassed', async () => {
    await set('A', { war: '600001' });
    await rejects(db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','build_war','','600002')`), /unique|duplicate/i);
    await rejects(db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','build_eco','','600001')`), /unique|duplicate/i);
  });
  it('is audited without leaking more than which builds changed; rows are ordinary mappings for the sync engine', async () => {
    await set('A', { war: '700001' }); await set('A', { war: null });
    const ev = (await db.query<{ details: { builds: string[]; cleared: string[] } }>(`SELECT details FROM audit_events WHERE guild_id='A' AND action='builds.updated' ORDER BY id`)).rows;
    expect(ev.map((e) => e.details)).toEqual([{ builds: ['war'], cleared: [] }, { builds: ['war'], cleared: ['war'] }]);
    await set('A', { hybrid: '800001' }); expect((await listRoleMappings(db, 'A')).map((m) => [m.kind, m.discordRoleId])).toEqual([['build_hybrid', '800001']]);
  });
});
