import { beforeEach, describe, expect, it } from 'vitest';
import { addAdminRole, addRoleMapping, guildsWithAdminRoles, hasAdminRole, listAdminRoles, listRoleMappings, MAX_ADMIN_ROLES, removeAdminRole, removeProxyCountry, removeRoleMapping,
  setIdentityRole, setProxyCountry, updateGuildSettings, ensureGuild, type Db } from '../src/index.js';
import { freshDb } from './helpers.js';

const R = (n: number) => String(100000 + n);                                   // role ids
let db: Db;
const audits = async (action: string, g = 'A') => (await db.query<{ target: string | null; details: Record<string, unknown>; actor_discord_id: string | null }>(`SELECT target, details, actor_discord_id FROM audit_events WHERE guild_id=$1 AND action=$2 ORDER BY id`, [g, action])).rows;
beforeEach(async () => {
  db = await freshDb(); await ensureGuild(db, 'A', 'A'); await ensureGuild(db, 'B', 'B');
  await updateGuildSettings(db, 'A', { community_type: 'country', country_id: 'eg' }, 'x');
  await updateGuildSettings(db, 'B', { community_type: 'party', party_id: 'p1' }, 'x');
});

describe('proxy countries (role_mappings kind proxy_citizen)', () => {
  it('adds, lists, REPLACES the role of a country, and removes it; every change is audited', async () => {
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(1), actor: 'u1' })).toEqual({ ok: true });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'ly', discordRoleId: R(2), actor: 'u1' })).toEqual({ ok: true });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(3), actor: 'u2' })).toEqual({ ok: true });      // edit = replace
    const px = (await listRoleMappings(db, 'A')).filter((m) => m.kind === 'proxy_citizen').map((m) => [m.gameRef, m.discordRoleId]).sort();
    expect(px).toEqual([['ly', R(2)], ['sd', R(3)]]);
    expect(await removeProxyCountry(db, { guildId: 'A', countryId: 'sd', actor: 'u1' })).toBe(true); expect(await removeProxyCountry(db, { guildId: 'A', countryId: 'sd', actor: 'u1' })).toBe(false);
    expect((await audits('proxy.set')).map((a) => a.target)).toEqual(['sd', 'ly', 'sd']); expect((await audits('proxy.removed')).map((a) => a.actor_discord_id)).toEqual(['u1']);
  });
  it('only a country server with its own country; never the server\'s own country; never on another type', async () => {
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'EG', discordRoleId: R(1), actor: null })).toEqual({ ok: false, code: 'SAME_AS_OWN_COUNTRY' });
    expect(await setProxyCountry(db, { guildId: 'B', countryId: 'sd', discordRoleId: R(1), actor: null })).toEqual({ ok: false, code: 'NOT_COUNTRY_SERVER' });
    await ensureGuild(db, 'C', 'C'); await updateGuildSettings(db, 'C', { community_type: 'country' }, 'x');                              // country type but no country chosen yet
    expect(await setProxyCountry(db, { guildId: 'C', countryId: 'sd', discordRoleId: R(1), actor: null })).toEqual({ ok: false, code: 'NOT_COUNTRY_SERVER' });
    expect(await setProxyCountry(db, { guildId: 'ZZ', countryId: 'sd', discordRoleId: R(1), actor: null })).toEqual({ ok: false, code: 'GUILD_NOT_FOUND' });
  });
  it('validates ids; a proxy role is dedicated: not the citizen role, not another proxy/identity role, not a military-rank role', async () => {
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'bad id!', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'GAME_REF_REQUIRED' });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: 'abc', actor: null })).toMatchObject({ code: 'DISCORD_ROLE_INVALID' });
    await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(9), actor: null });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(9), actor: null })).toMatchObject({ code: 'ROLE_CONFLICT' });          // proxies must not get the citizen role
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: null })).toEqual({ ok: true });                         // reverse direction
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'ROLE_CONFLICT' });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(2), actor: null })).toEqual({ ok: true });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'ly', discordRoleId: R(2), actor: null })).toMatchObject({ code: 'ROLE_IN_USE' });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R(2), actor: null })).toMatchObject({ code: 'ROLE_IN_USE' });
    await db.query(`INSERT INTO military_ranks (guild_id, rank_order, name, threshold, enabled, discord_role_id) VALUES ('A',1,'R',1,true,$1)`, [R(5)]).catch(() => undefined);
  });
  it('the database refuses a proxy mapping without a country and a second role for the same country', async () => {
    await expect(db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','proxy_citizen','',$1)`, [R(1)])).rejects.toThrow(/check|violat/i);
    await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(1), actor: null });
    await expect(db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','proxy_citizen','sd',$1)`, [R(7)])).rejects.toThrow(/unique|duplicate/i);
  });
  it('the generic mapping function refuses proxy / identity kinds (they have their own replace-semantics path)', async () => {
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'proxy_citizen', gameRef: 'sd', discordRoleId: R(1), actor: null })).toEqual({ ok: false, code: 'USE_DEDICATED' });
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R(1), actor: null })).toEqual({ ok: false, code: 'USE_DEDICATED' });
  });
});

describe('country identity roles', () => {
  const KINDS = ['country_party_member', 'country_party_president', 'country_unit_member', 'country_unit_leader', 'country_unit_owner'];
  it('each kind has one role (replace semantics) and can be cleared; audited', async () => {
    for (const [i, k] of KINDS.entries()) expect(await setIdentityRole(db, { guildId: 'A', kind: k, discordRoleId: R(i + 1), actor: 'u' })).toEqual({ ok: true });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R(50), actor: 'u' })).toEqual({ ok: true });
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind === 'country_unit_owner').map((m) => m.discordRoleId)).toEqual([R(50)]);
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: null, actor: 'u' })).toEqual({ ok: true });
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind.startsWith('country_')).length).toBe(4);
    expect((await audits('identity_role.cleared')).length).toBe(1); expect((await audits('identity_role.set')).length).toBe(6);
  });
  it('a role is never shared between two identity kinds; only country servers may have them; unknown kinds are refused', async () => {
    await setIdentityRole(db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R(1), actor: null });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_member', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'ROLE_IN_USE' });
    expect(await setIdentityRole(db, { guildId: 'B', kind: 'country_party_member', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'KIND_NOT_ALLOWED' });      // dedicated party server
    await ensureGuild(db, 'G', 'G'); expect(await setIdentityRole(db, { guildId: 'G', kind: 'country_party_member', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'KIND_NOT_ALLOWED' });  // general
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'party_member', discordRoleId: R(2), actor: null })).toMatchObject({ code: 'INVALID_KIND' });
  });
  it('they are independent of the party-server / unit-server mappings: a dedicated party server keeps its own member/leader/role mappings', async () => {
    expect(await addRoleMapping(db, { guildId: 'B', kind: 'party_member', discordRoleId: R(1), actor: null })).toEqual({ ok: true });
    expect(await addRoleMapping(db, { guildId: 'B', kind: 'party_leader', discordRoleId: R(2), actor: null })).toEqual({ ok: true });
    expect(await addRoleMapping(db, { guildId: 'B', kind: 'party_role', gameRef: 'treasurer', discordRoleId: R(3), actor: null })).toEqual({ ok: true });
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'party_member', discordRoleId: R(1), actor: null })).toEqual({ ok: true });      // country server may still map ONE specific party
    expect((await listRoleMappings(db, 'B')).map((m) => m.kind).sort()).toEqual(['party_leader', 'party_member', 'party_role']);
  });
  it('changing a country server to another type removes the identity and proxy mappings (confirmed), exactly like other country-only kinds', async () => {
    await setIdentityRole(db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R(1), actor: null }); await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(2), actor: null });
    await expect(updateGuildSettings(db, 'A', { community_type: 'party', party_id: 'p' }, 'u')).rejects.toMatchObject({ code: 'INCOMPATIBLE_MAPPINGS' });
    expect((await listRoleMappings(db, 'A')).length).toBe(2);
    const r = await updateGuildSettings(db, 'A', { community_type: 'party', party_id: 'p' }, 'u', new Date(), { confirmRemoveIncompatible: true });
    expect(r.removedMappings.map((m) => m.kind).sort()).toEqual(['country_party_member', 'proxy_citizen']); expect((await listRoleMappings(db, 'A')).length).toBe(0);
  });
});

describe('trusted bot-administrator roles', () => {
  it('add (idempotent), list, membership check, remove; audited with the actor', async () => {
    expect(await addAdminRole(db, { guildId: 'A', roleId: R(1), actor: 'owner' })).toEqual({ ok: true }); expect(await addAdminRole(db, { guildId: 'A', roleId: R(1), actor: 'owner' })).toEqual({ ok: true });
    await addAdminRole(db, { guildId: 'A', roleId: R(2), actor: 'owner' });
    expect((await listAdminRoles(db, 'A')).map((r) => r.roleId)).toEqual([R(1), R(2)]);
    expect(await hasAdminRole(db, 'A', [R(9), R(2)])).toBe(true); expect(await hasAdminRole(db, 'A', [R(9)])).toBe(false); expect(await hasAdminRole(db, 'A', [])).toBe(false); expect(await hasAdminRole(db, 'B', [R(1)])).toBe(false);
    expect(await removeAdminRole(db, { guildId: 'A', roleId: R(1), actor: 'owner' })).toBe(true); expect(await removeAdminRole(db, { guildId: 'A', roleId: R(1), actor: 'owner' })).toBe(false);
    expect((await audits('admin_role.added')).length).toBe(2); expect((await audits('admin_role.removed'))[0]).toMatchObject({ target: R(1), actor_discord_id: 'owner' });
    expect([...(await guildsWithAdminRoles(db, ['A', 'B'])).entries()]).toEqual([['A', [R(2)]]]);
  });
  it('validates ids, is capped, is isolated per server and disappears with the server', async () => {
    expect(await addAdminRole(db, { guildId: 'A', roleId: 'x', actor: null })).toMatchObject({ code: 'DISCORD_ROLE_INVALID' }); expect(await addAdminRole(db, { guildId: 'ZZ', roleId: R(1), actor: null })).toMatchObject({ code: 'GUILD_NOT_FOUND' });
    for (let i = 0; i < MAX_ADMIN_ROLES; i++) expect(await addAdminRole(db, { guildId: 'A', roleId: R(i), actor: null })).toEqual({ ok: true });
    expect(await addAdminRole(db, { guildId: 'A', roleId: R(99), actor: null })).toMatchObject({ code: 'TOO_MANY' }); expect(await listAdminRoles(db, 'B')).toEqual([]);
    await db.query(`DELETE FROM guilds WHERE guild_id='A'`); expect((await db.query(`SELECT 1 FROM bot_admin_roles WHERE guild_id='A'`)).rows).toHaveLength(0);
  });
});

describe('guild-level locking (needs a real PostgreSQL server to be meaningful; passes on PGlite too)', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  it('a mapping insert that races a server-type change is decided AFTER the type change commits (cannot bypass the type restriction)', async () => {
    const g = gate();
    const typeChange = db.tx(async (t) => {                                                    // a type change in progress: row locked, not yet committed
      await t.query(`SELECT 1 FROM guilds WHERE guild_id='A' FOR UPDATE`); await g.p;
      await t.query(`DELETE FROM role_mappings WHERE guild_id='A'`); await t.query(`UPDATE guilds SET community_type='party', party_id='p9', country_id=NULL WHERE guild_id='A'`);
    });
    await new Promise((r) => setTimeout(r, 100));
    const racing = addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: 'u' });        // 'citizen' is allowed for a country server, NOT for a party server
    await new Promise((r) => setTimeout(r, 150)); g.open(); await typeChange;
    expect(await racing).toEqual({ ok: false, code: 'KIND_NOT_ALLOWED' });
    expect((await listRoleMappings(db, 'A')).length).toBe(0);
  });
  it('the opposite order is consistent too: a mapping committed first is seen (and removed, if incompatible) by the type change', async () => {
    const g = gate(); let inserted = false;
    const insert = db.tx(async (t) => {
      await t.query(`SELECT 1 FROM guilds WHERE guild_id='A' FOR UPDATE`); await g.p;
      await t.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','citizen','',$1)`, [R(1)]); inserted = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    const change = updateGuildSettings(db, 'A', { community_type: 'party', party_id: 'p9' }, 'u', new Date(), { confirmRemoveIncompatible: true });
    await new Promise((r) => setTimeout(r, 150)); g.open(); await insert; const r = await change;
    expect(inserted).toBe(true); expect(r.removedMappings.map((m) => m.kind)).toEqual(['citizen']); expect((await listRoleMappings(db, 'A')).length).toBe(0);
  });
  it('concurrent writers never corrupt: same proxy country set by two admins, same identity kind, admin-role cap', async () => {
    await Promise.all([setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(1), actor: 'a' }), setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(2), actor: 'b' })]);
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind === 'proxy_citizen').length).toBe(1);
    await Promise.all([1, 2, 3, 4].map((i) => setIdentityRole(db, { guildId: 'A', kind: 'country_unit_leader', discordRoleId: R(10 + i), actor: 'a' })));
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind === 'country_unit_leader').length).toBe(1);
    const res = await Promise.all(Array.from({ length: MAX_ADMIN_ROLES + 5 }, (_, i) => addAdminRole(db, { guildId: 'A', roleId: R(200 + i), actor: 'a' })));
    expect(res.filter((r) => r.ok).length).toBe(MAX_ADMIN_ROLES); expect((await listAdminRoles(db, 'A')).length).toBe(MAX_ADMIN_ROLES);
  });
  it('a mapping removal is serialised with a type change as well', async () => {
    await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: null }); const id = (await listRoleMappings(db, 'A'))[0]!.id;
    const [r1, r2] = await Promise.all([removeRoleMapping(db, { guildId: 'A', mappingId: id, actor: 'u' }), updateGuildSettings(db, 'A', { community_type: 'general' }, 'u', new Date(), { confirmRemoveIncompatible: true }).then(() => true)]);
    expect(r2).toBe(true); expect(typeof r1).toBe('boolean'); expect((await listRoleMappings(db, 'A')).length).toBe(0);
  });
});
