import { beforeEach, describe, expect, it } from 'vitest';
import { addRoleMapping, ensureGuild, getGuildConfig, roleIsManagedByBot, saveLadder, setBuildRoles, setEntityMemberRole, setIdentityRole, setProxyCountry, setUnverifiedRole, updateGuildSettings, type Db } from '../src/index.js';
import { freshDb } from './helpers.js';

const R = (n: number) => String(100000 + n);
let db: Db;
const cfg = async () => (await getGuildConfig(db, 'A'))!;
const audits = async (action: string) => (await db.query<{ target: string; details: Record<string, unknown> }>(`SELECT target, details FROM audit_events WHERE guild_id='A' AND action=$1 ORDER BY id`, [action])).rows;
beforeEach(async () => { db = await freshDb(); await ensureGuild(db, 'A', 'A'); await updateGuildSettings(db, 'A', { community_type: 'country', country_id: 'eg' }, 'x'); });

describe('setUnverifiedRole (M2a)', () => {
  it('is disabled by default; enabling needs a role; saves, replaces, disables (keeping the role) and is audited with the actor', async () => {
    expect(await cfg()).toMatchObject({ unverifiedRoleEnabled: false, unverifiedRoleId: null });
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: null, actor: 'u' })).toEqual({ ok: false, code: 'ROLE_REQUIRED' });
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: 'abc', actor: 'u' })).toEqual({ ok: false, code: 'ROLE_INVALID' });
    expect(await setUnverifiedRole(db, { guildId: 'ZZ', enabled: true, roleId: R(1), actor: 'u' })).toEqual({ ok: false, code: 'GUILD_NOT_FOUND' });
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: R(1), actor: 'u' })).toEqual({ ok: true }); expect(await cfg()).toMatchObject({ unverifiedRoleEnabled: true, unverifiedRoleId: R(1) });
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: R(2), actor: 'u' })).toEqual({ ok: true }); expect((await cfg()).unverifiedRoleId).toBe(R(2));
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: false, roleId: R(2), actor: 'u2' })).toEqual({ ok: true }); expect(await cfg()).toMatchObject({ unverifiedRoleEnabled: false, unverifiedRoleId: R(2) });
    expect((await audits('verification.unverified_role.set')).map((a) => [a.target, a.details.enabled])).toEqual([[R(1), true], [R(2), true], [R(2), false]]);
  });
  it('refuses a role the bot manages: citizen / proxy / party / unit / president / leader / owner / build / rank roles', async () => {
    await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: null });
    await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(2), actor: null });
    await setEntityMemberRole(db, { guildId: 'A', kind: 'country_party_member', entityId: 'pa', discordRoleId: R(3), actor: null });
    await setIdentityRole(db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: R(4), actor: null });
    await setBuildRoles(db, { guildId: 'A', roles: { war: R(5) }, actor: null });
    await db.query(`INSERT INTO military_ranks (guild_id, key, rank_order, name_en, name_ar, min_damage, discord_role_id) VALUES ('A','r1',1,'R','ر',1000,$1)`, [R(6)]);
    for (const n of [1, 2, 3, 4, 5, 6]) { expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: R(n), actor: null }), `role ${n}`).toEqual({ ok: false, code: 'ROLE_CONFLICT' }); expect(await roleIsManagedByBot(db, 'A', R(n))).toBe(true); }
    expect(await roleIsManagedByBot(db, 'A', R(9))).toBe(false); expect(await cfg()).toMatchObject({ unverifiedRoleEnabled: false, unverifiedRoleId: null });
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: R(9), actor: null })).toEqual({ ok: true });
  });
  it('the other direction: once enabled, every role writer refuses that role; while disabled they accept it', async () => {
    await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: R(1), actor: null });
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: null })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT' });
    expect(await setProxyCountry(db, { guildId: 'A', countryId: 'sd', discordRoleId: R(1), actor: null })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT' });
    expect(await setIdentityRole(db, { guildId: 'A', kind: 'country_party_president', discordRoleId: R(1), actor: null })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT' });
    expect(await setEntityMemberRole(db, { guildId: 'A', kind: 'country_unit_member', entityId: 'mu1', discordRoleId: R(1), actor: null })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT' });
    expect(await setBuildRoles(db, { guildId: 'A', roles: { eco: R(1) }, actor: null })).toMatchObject({ ok: false, code: 'ROLE_CONFLICT' });
    const lad = await saveLadder(db, 'A', [{ key: 'r1', order: 1, nameEn: 'R', nameAr: 'ر', minDamage: 1000, discordRoleId: R(1), enabled: true }], 'u'); expect(lad).toMatchObject({ ok: false, code: 'ROLE_CONFLICT' });
    await setUnverifiedRole(db, { guildId: 'A', enabled: false, roleId: R(1), actor: null });
    expect(await addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: R(1), actor: null })).toEqual({ ok: true });                  // disabled => not reserved
    expect(await setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: R(1), actor: null })).toEqual({ ok: false, code: 'ROLE_CONFLICT' });      // ... but enabling it again is refused
  });
  it('concurrency on a real database: enabling the role and mapping it at the same moment never leaves it both Unverified AND a managed role', async () => {
    for (let i = 0; i < 8; i++) {
      const role = R(20 + i);
      await Promise.all([setUnverifiedRole(db, { guildId: 'A', enabled: true, roleId: role, actor: null }), addRoleMapping(db, { guildId: 'A', kind: 'citizen', discordRoleId: role, actor: null }), setProxyCountry(db, { guildId: 'A', countryId: `c${i}`, discordRoleId: role, actor: null })]);
      const c = await cfg(); const managed = await roleIsManagedByBot(db, 'A', role);
      expect(c.unverifiedRoleEnabled && c.unverifiedRoleId === role && managed, `round ${i}`).toBe(false);
      await db.query(`DELETE FROM role_mappings WHERE guild_id='A'`); await setUnverifiedRole(db, { guildId: 'A', enabled: false, roleId: null, actor: null });
    }
  });
});
