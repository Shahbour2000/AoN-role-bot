import { beforeEach, describe, expect, it } from 'vitest';
import { addAdminRole, addRoleMapping, guildsWithAdminRoles, hasAdminRole, listAdminRoles, listRoleMappings, MAX_ADMIN_ROLES, removeAdminRole, removeProxyCountry, removeRoleMapping,
  setIdentityRole, setEntityMemberRole, removeEntityMemberRole, listEntityMemberRoles, setProxyCountry, updateGuildSettings, ensureGuild, type Db } from '../src/index.js';
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
  it('validates ids; a proxy role may be the SHARED citizen role, but never an identity role, a military-rank role or another country\'s citizen role', async () => {
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'bad id!', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'GAME_REF_REQUIRED' });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: 'abc', actor: null })).toMatchObject({ code: 'DISCORD_ROLE_INVALID' });
    // the intentional exception: proxies and the own-country citizen role share ONE Discord role, in either order, for several proxies at once
    await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(9), actor: null });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(9), actor: null })).toEqual({ ok: true });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'ly', discordRoleId: R(9), actor: null })).toEqual({ ok: true });
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: null })).toEqual({ ok: true });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'ye', discordRoleId: R(1), actor: null })).toEqual({ ok: true });                     // proxy role set AFTER the citizen role
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind === 'proxy_citizen').map((m) => [m.gameRef, m.discordRoleId]).sort()).toEqual([['ly', R(9)], ['sd', R(9)], ['ye', R(1)]]);
    // ... and in the other direction: a citizen mapping added after proxies already use the role
    await db.query(`DELETE FROM role_mappings WHERE guild_id='A' AND kind='citizen'`);
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(9), actor: null })).toEqual({ ok: true });
    // NOT shared: the citizen role of some OTHER specific country, identity roles, rank roles
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'citizen', gameRef: 'ru', discordRoleId: R(9), actor: null })).toMatchObject({ code: 'ROLE_CONFLICT' });
    await addRoleMapping(db, { guildId: 'A', kind: 'citizen', gameRef: 'ru', discordRoleId: R(20), actor: null });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'cn', discordRoleId: R(20), actor: null })).toMatchObject({ code: 'ROLE_CONFLICT' });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_party_president', discordRoleId: R(30), actor: null })).toEqual({ ok: true });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'cn', discordRoleId: R(30), actor: null })).toMatchObject({ code: 'ROLE_IN_USE' });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R(9), actor: null })).toMatchObject({ code: 'ROLE_IN_USE' });      // an identity role may not equal a proxy role
    await db.query(`INSERT INTO military_ranks (guild_id, key, rank_order, name_en, name_ar, min_damage, discord_role_id) VALUES ('A','r1',1,'R','ر',1000,$1)`, [R(5)]);
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'cn', discordRoleId: R(5), actor: null })).toMatchObject({ code: 'ROLE_CONFLICT' });
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
  const KINDS = ['country_party_president', 'country_unit_leader', 'country_unit_owner'];       // the SHARED roles; membership roles are per party / unit
  it('each kind has one role (replace semantics) and can be cleared; audited', async () => {
    for (const [i, k] of KINDS.entries()) expect(await setIdentityRole(db, { guildId: 'A', kind: k, discordRoleId: R(i + 1), actor: 'u' })).toEqual({ ok: true });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R(50), actor: 'u' })).toEqual({ ok: true });
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind === 'country_unit_owner').map((m) => m.discordRoleId)).toEqual([R(50)]);
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: null, actor: 'u' })).toEqual({ ok: true });
    expect((await listRoleMappings(db, 'A')).filter((m) => m.kind.startsWith('country_')).length).toBe(2);
    expect((await audits('identity_role.cleared')).length).toBe(1); expect((await audits('identity_role.set')).length).toBe(4);
    // membership kinds are NOT settable here any more (one role per party / unit)
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_party_member', discordRoleId: R(70), actor: 'u' })).toMatchObject({ code: 'INVALID_KIND' });
  });
  it('a role is never shared between two identity roles; only country servers may have them; unknown kinds are refused', async () => {
    await setIdentityRole(db, { guildId: 'A', kind: 'country_party_president', discordRoleId: R(1), actor: null });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_leader', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'ROLE_IN_USE' });
    expect(await setIdentityRole(db, { guildId: 'B', kind: 'country_party_president', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'KIND_NOT_ALLOWED' });      // dedicated party server
    await ensureGuild(db, 'G', 'G'); expect(await setIdentityRole(db, { guildId: 'G', kind: 'country_party_president', discordRoleId: R(1), actor: null })).toMatchObject({ code: 'KIND_NOT_ALLOWED' });  // general
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
    await setEntityMemberRole(db, { guildId: 'A', kind: 'country_party_member', entityId: 'p1', discordRoleId: R(1), actor: null }); await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(2), actor: null });
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

describe('country party / unit MEMBERSHIP roles (one role per entity)', () => {
  const set = (kind: string, entityId: string, role: number, guildId = 'A') => setEntityMemberRole(db, { guildId, kind, entityId, discordRoleId: R(role), actor: 'u' });
  it('one role per party and per unit; REPLACE semantics per entity; remove; audited; isolated per server', async () => {
    expect(await set('country_party_member', 'p1', 1)).toEqual({ ok: true }); expect(await set('country_party_member', 'p2', 2)).toEqual({ ok: true });
    expect(await set('country_unit_member', 'u1', 3)).toEqual({ ok: true }); expect(await set('country_unit_member', 'u2', 4)).toEqual({ ok: true });
    expect(await set('country_party_member', 'p1', 5)).toEqual({ ok: true });                                           // replace the role of p1 only
    const l = await listEntityMemberRoles(db, 'A');
    expect(l.current.map((r) => [r.kind, r.entityId, r.discordRoleId])).toEqual([['country_party_member', 'p1', R(5)], ['country_party_member', 'p2', R(2)], ['country_unit_member', 'u1', R(3)], ['country_unit_member', 'u2', R(4)]]);
    expect(l.legacy).toEqual([]);
    expect(await removeEntityMemberRole(db, { guildId: 'A', kind: 'country_unit_member', entityId: 'u1', actor: 'u' })).toBe(true);
    expect(await removeEntityMemberRole(db, { guildId: 'A', kind: 'country_unit_member', entityId: 'u1', actor: 'u' })).toBe(false);
    expect((await audits('entity_role.set')).length).toBe(5); expect((await audits('entity_role.removed')).length).toBe(1);
    await ensureGuild(db, 'D', 'D'); await updateGuildSettings(db, 'D', { community_type: 'country', country_id: 'sd' }, 'x');
    expect(await set('country_party_member', 'p1', 5, 'D')).toEqual({ ok: true });                                      // the same role / party in ANOTHER server is independent
    expect((await listEntityMemberRoles(db, 'A')).current.length).toBe(3);
  });
  it('refuses: a role already used by another identity / proxy role or a rank, other server types, bad ids and kinds', async () => {
    await set('country_party_member', 'p1', 1);
    expect(await set('country_party_member', 'p2', 1)).toMatchObject({ code: 'ROLE_IN_USE' });                         // never two parties on one role
    expect(await set('country_unit_member', 'u1', 1)).toMatchObject({ code: 'ROLE_IN_USE' });
    await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R(2), actor: null });
    expect(await set('country_party_member', 'p2', 2)).toMatchObject({ code: 'ROLE_IN_USE' });                         // shared roles are exclusive too
    await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(3), actor: null });
    expect(await set('country_party_member', 'p2', 3)).toMatchObject({ code: 'ROLE_IN_USE' });
    await db.query(`INSERT INTO military_ranks (guild_id, key, rank_order, name_en, name_ar, min_damage, discord_role_id) VALUES ('A','r1',1,'R','ر',1000,$1)`, [R(6)]);
    expect(await set('country_party_member', 'p2', 6)).toMatchObject({ code: 'ROLE_CONFLICT' });
    expect(await set('country_party_member', 'p1', 1)).toEqual({ ok: true });                                           // re-saving the same entity with its own role is fine
    expect(await set('country_party_member', 'bad id!', 7)).toMatchObject({ code: 'GAME_REF_REQUIRED' });
    expect(await setEntityMemberRole(db, { guildId: 'A', kind: 'country_party_member', entityId: 'p3', discordRoleId: 'x', actor: null })).toMatchObject({ code: 'DISCORD_ROLE_INVALID' });
    expect(await set('party_member', 'p3', 7)).toMatchObject({ code: 'INVALID_KIND' });
    expect(await set('country_party_member', 'p3', 7, 'B')).toMatchObject({ code: 'NOT_COUNTRY_SERVER' });             // dedicated party server
    expect(await set('country_party_member', 'p3', 7, 'ZZ')).toMatchObject({ code: 'GUILD_NOT_FOUND' });
  });
  it('the database itself refuses an empty entity reference for NEW rows and duplicate rows per entity', async () => {
    await expect(db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','country_unit_member','',$1)`, [R(1)])).rejects.toThrow(/check|violat/i);
    await set('country_unit_member', 'u1', 1);
    await expect(db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','country_unit_member','u1',$1)`, [R(9)])).rejects.toThrow(/unique|duplicate/i);
  });
  it('the old general member rows are reported as legacy, never mixed with per-entity roles, and can be removed', async () => {
    await db.query(`DELETE FROM role_mappings WHERE guild_id='A'`);
    await db.query(`ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_entity_member_ref`);                           // simulate a row written by Delivery B (before the constraint existed)
    await db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','country_party_member','',$1)`, [R(1)]);
    await set('country_party_member', 'p1', 2);
    const l = await listEntityMemberRoles(db, 'A');
    expect(l.legacy).toEqual([{ kind: 'country_party_member', discordRoleId: R(1) }]); expect(l.current.map((r) => r.entityId)).toEqual(['p1']);
    expect(await removeEntityMemberRole(db, { guildId: 'A', kind: 'country_party_member', entityId: '', actor: 'u' })).toBe(true);
    expect((await listEntityMemberRoles(db, 'A')).legacy).toEqual([]);
  });
  it('concurrency: two admins saving the SAME party leave exactly one row; different parties both persist; a racing role grab keeps roles exclusive', async () => {
    await Promise.all([set('country_party_member', 'p1', 1), set('country_party_member', 'p1', 2), set('country_party_member', 'p1', 3)]);
    expect((await listEntityMemberRoles(db, 'A')).current.filter((r) => r.entityId === 'p1').length).toBe(1);
    const res = await Promise.all([set('country_party_member', 'pa', 40), set('country_unit_member', 'ua', 40), set('country_party_member', 'pb', 40)]);
    expect(res.filter((r) => r.ok).length).toBe(1);                                                                      // exactly one entity wins the contested Discord role
    expect(res.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'ROLE_IN_USE')).toBe(true);
  });
});

describe('M1.1: one membership role per party / unit across BOTH membership kinds', () => {
  const entity = (kind: string, id: string, role: number) => setEntityMemberRole(db, { guildId: 'A', kind, entityId: id, discordRoleId: R(role), actor: null });
  const generic = (kind: string, ref: string, role: number) => addRoleMapping(db, { guildId: 'A', kind, gameRef: ref, discordRoleId: R(role), actor: null });
  it('a party / unit that already has a membership role cannot get a second one of the other kind or with another role; the identical mapping is idempotent', async () => {
    expect(await entity('country_party_member', 'pa', 1)).toEqual({ ok: true });
    expect(await generic('party_member', 'pa', 2)).toMatchObject({ ok: false, code: 'ROLE_ENTITY_DUPLICATE' });                 // generic after country
    expect(await generic('party_member', 'pb', 2)).toEqual({ ok: true });                                                          // another party: fine
    expect(await entity('country_party_member', 'pb', 3)).toMatchObject({ ok: false, code: 'ROLE_ENTITY_DUPLICATE' });             // country after generic
    expect(await generic('party_member', 'pb', 2)).toEqual({ ok: true });                                                          // identical row: idempotent
    expect(await generic('party_member', 'pb', 4)).toMatchObject({ ok: false, code: 'ROLE_ENTITY_DUPLICATE' });                    // same party, second role, same kind
    expect(await entity('country_unit_member', 'mu1', 5)).toEqual({ ok: true });
    expect(await generic('unit_member', 'mu1', 6)).toMatchObject({ ok: false, code: 'ROLE_ENTITY_DUPLICATE' });
    expect(await generic('unit_member', 'pa', 7)).toEqual({ ok: true });                                                           // families are separate: a unit mapping never collides with a party id
    expect(await entity('country_party_member', 'pa', 8)).toEqual({ ok: true });                                                   // replacing the country row of the same party stays possible
    const m = (await listRoleMappings(db, 'A')).filter((x) => /party_member|unit_member/.test(x.kind)).map((x) => [x.kind, x.gameRef, x.discordRoleId]).sort();
    expect(m).toEqual([['country_party_member', 'pa', R(8)], ['country_unit_member', 'mu1', R(5)], ['party_member', 'pb', R(2)], ['unit_member', 'pa', R(7)]].sort());
  });
  it('dedicated party / unit servers (mappings without a game reference) keep allowing several roles', async () => {
    expect(await generic('party_member', '', 1)).toEqual({ ok: true }); expect(await generic('party_member', '', 2)).toEqual({ ok: true });
  });
  it('concurrency on a real database: a generic and a country writer racing for the SAME party leave exactly one row; racing writers for different parties both win', async () => {
    for (let i = 0; i < 6; i++) {
      const ref = `pr${i}`; const res = await Promise.all([generic('party_member', ref, 10 + i * 2), entity('country_party_member', ref, 11 + i * 2), generic('party_member', ref, 30 + i)]);
      expect(res.filter((r) => r.ok).length, `round ${i}`).toBeGreaterThanOrEqual(1);
      const rows = (await listRoleMappings(db, 'A')).filter((x) => x.gameRef === ref && /party_member/.test(x.kind)); expect(new Set(rows.map((r) => r.discordRoleId)).size, `round ${i}`).toBe(1);
    }
    const both = await Promise.all([entity('country_party_member', 'px', 60), generic('party_member', 'py', 61)]); expect(both.every((r) => r.ok)).toBe(true);
  });
});
