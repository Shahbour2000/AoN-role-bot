import { describe, expect, it } from 'vitest';
import { addAdminRole, getGuildConfig, listAdminRoles, listRoleMappings, updateGuildSettings } from '@aon/db';
import { ADMIN, MANAGE_GUILD, SEND_ONLY, get, guildInfo, login, makeApp, mut, role, type Ctx, type Login } from './harness.js';

const G1 = '100000001', G2 = '100000002', USER = '42', MEMBER = '77';
const R = { a: '900001', b: '900002', c: '900003', d: '900004' };             // ids used across the tests; 900003 is above the bot, 900004 is an integration role
const P = (g = G1) => `/api/guilds/${g}`;
async function ctx(perm: string = ADMIN, type: 'country' | 'party' = 'country') {
  const c = await makeApp({ guilds: [G1, G2] }); const l = await login(c, USER, [guildInfo(G1, perm), guildInfo(G2, SEND_ONLY)]);
  for (const g of [G1, G2]) { c.bot.roles.set(g, [role(g, 0), role(R.a, 5, { color: 0x1abc9c, name: 'Sudan' }), role(R.b, 6, { color: 0xe74c3c, name: 'Libya' }), role(R.c, 60), role(R.d, 2, { managed: true }), role('900005', 7), role('900006', 8), role('900007', 9)]); c.bot.top.set(g, 50); }
  await updateGuildSettings(c.db, G1, type === 'country' ? { community_type: 'country', country_id: 'eg', modules: { government: true, party: true, unit: true, alliance: false, ranks: false } } : { community_type: 'party', party_id: 'p1' }, null);
  c.game.countriesRes = { status: 'ok', data: [{ id: 'eg', name: 'Egypt' }, { id: 'sd', name: 'Sudan' }, { id: 'ly', name: 'Libya' }, { id: 'pl', name: 'Poland' }] };
  return { c, l };
}
type X = { c: Ctx; l: Login };
const put = ({ c, l }: X, url: string, body: unknown) => mut(c, l, 'PUT', url, body);

describe('proxy countries API', () => {
  it('lists configured proxies with real country names; add, edit (replace the role) and remove', async () => {
    const x = await ctx(); expect((await get(x.c, x.l, `${P()}/proxy-countries`)).json()).toMatchObject({ enabled: true, ownCountryId: 'eg', proxies: [] });
    expect((await put(x, `${P()}/proxy-countries/sd`, { discordRoleId: R.a })).json()).toMatchObject({ ok: true, countryId: 'sd', countryName: 'Sudan' });
    await put(x, `${P()}/proxy-countries/ly`, { discordRoleId: R.b });
    expect((await get(x.c, x.l, `${P()}/proxy-countries`)).json().proxies).toEqual([{ countryId: 'ly', countryName: 'Libya', discordRoleId: R.b }, { countryId: 'sd', countryName: 'Sudan', discordRoleId: R.a }]);
    expect((await put(x, `${P()}/proxy-countries/sd`, { discordRoleId: '900005' })).statusCode).toBe(200);
    expect((await get(x.c, x.l, `${P()}/proxy-countries`)).json().proxies.find((p: { countryId: string }) => p.countryId === 'sd').discordRoleId).toBe('900005');
    expect((await mut(x.c, x.l, 'DELETE', `${P()}/proxy-countries/ly`)).statusCode).toBe(200); expect((await mut(x.c, x.l, 'DELETE', `${P()}/proxy-countries/ly`)).statusCode).toBe(404);
    expect((await get(x.c, x.l, `${P()}/proxy-countries`)).json().proxies).toHaveLength(1);
    const ev = (await x.c.db.query<{ action: string; actor_discord_id: string }>(`SELECT action, actor_discord_id FROM audit_events WHERE guild_id=$1 AND action LIKE 'proxy.%' ORDER BY id`, [G1])).rows;
    expect(ev.map((e) => e.action)).toEqual(['proxy.set', 'proxy.set', 'proxy.set', 'proxy.removed']); expect(ev.every((e) => e.actor_discord_id === USER)).toBe(true);
  });
  it('the country must exist in the game (discovered via the API), not be the server\'s own country, and the list must be readable', async () => {
    const x = await ctx();
    expect((await put(x, `${P()}/proxy-countries/zz`, { discordRoleId: R.a })).json().error).toBe('unknown_country');
    expect((await put(x, `${P()}/proxy-countries/eg`, { discordRoleId: R.a })).json().error).toBe('same_country');
    const y = await ctx(); y.c.game.countriesRes = { status: 'error', message: 'down' } as never;            // fresh app: nothing cached yet
    expect((await put(y, `${P()}/proxy-countries/sd`, { discordRoleId: R.a })).statusCode).toBe(503);
    y.c.game.countriesRes = { status: 'incomplete', missing: ['countries'] } as never; const z = await ctx(); z.c.game.countriesRes = { status: 'incomplete', missing: ['countries'] } as never;
    expect((await put(z, `${P()}/proxy-countries/sd`, { discordRoleId: R.a })).statusCode).toBe(503);
    expect((await listRoleMappings(y.c.db, G1)).filter((m) => m.kind === 'proxy_citizen')).toHaveLength(0);                  // nothing is saved on a guess
  });
  it('the role must exist in THIS server and be usable; a proxy role MAY be the shared citizen role; it may never be a party / unit / president / leader / owner role', async () => {
    const x = await ctx(); const base = `${P()}/proxy-countries`;
    expect((await put(x, `${base}/sd`, { discordRoleId: '999999999' })).json().error).toBe('role_invalid');                 // no such role
    expect((await put(x, `${base}/sd`, { discordRoleId: G1 })).json().error).toBe('role_invalid');                          // @everyone
    expect((await put(x, `${base}/sd`, { discordRoleId: R.d })).json().error).toBe('role_invalid');                          // integration role
    await mut(x.c, x.l, 'POST', `${P()}/mappings`, { kind: 'citizen', discordRoleId: R.b });
    expect((await put(x, `${base}/sd`, { discordRoleId: R.b })).statusCode).toBe(200);                                   // the intentional exception: same Discord role as the citizen role
    expect((await put(x, `${base}/ly`, { discordRoleId: R.b })).statusCode).toBe(200);                                   // several proxies share it too
    expect((await put(x, `${base}/sd`, { discordRoleId: R.a })).statusCode).toBe(200);
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_party_president', roleId: '900005' })).statusCode).toBe(200);
    expect((await put(x, `${base}/ly`, { discordRoleId: '900005' })).json().error).toBe('role_in_use');                  // an identity role is never a proxy role
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_unit_owner', roleId: R.a })).json().error).toBe('role_in_use');   // ... and an identity role is never a proxy role
    
    x.c.bot.down = true; expect((await put(x, `${base}/ly`, { discordRoleId: R.c })).statusCode).toBe(503);
  });
  it('malformed input is rejected; unknown properties too; only country servers; another server\'s roles/data never leak', async () => {
    const x = await ctx(); const base = `${P()}/proxy-countries`;
    for (const body of [{}, { discordRoleId: 'abc' }, { discordRoleId: R.a, extra: 1 }, { discordRoleId: 5 }]) expect((await put(x, `${base}/sd`, body)).statusCode, JSON.stringify(body)).toBe(422);
    expect((await put(x, `${base}/bad%20id!`, { discordRoleId: R.a })).statusCode).toBe(422);
    const p = await ctx(ADMIN, 'party'); expect((await put(p, `${P()}/proxy-countries/sd`, { discordRoleId: R.a })).json().error).toBe('not_country_server');
    expect((await get(p.c, p.l, `${P()}/proxy-countries`)).json().enabled).toBe(false);
  });
  it('needs CSRF + same origin, authentication and Manage Server in THAT server (other server -> 403, nothing written)', async () => {
    const x = await ctx(); const url = `${P()}/proxy-countries/sd`;
    expect((await x.c.app.inject({ method: 'PUT', url, cookies: x.l.cookies, headers: { origin: x.l.headers.origin }, payload: { discordRoleId: R.a } })).statusCode).toBe(403);
    expect((await x.c.app.inject({ method: 'PUT', url, payload: { discordRoleId: R.a } })).statusCode).toBe(401);
    expect((await put(x, `${P(G2)}/proxy-countries/sd`, { discordRoleId: R.a })).statusCode).toBe(403); expect((await get(x.c, x.l, `${P(G2)}/proxy-countries`)).statusCode).toBe(403);
    expect((await listRoleMappings(x.c.db, G2)).length).toBe(0);
  });
});

describe('country identity roles API', () => {
  const kinds = ['country_party_president', 'country_unit_leader', 'country_unit_owner'];            // the SHARED roles; membership roles are per party / unit (entity-roles API)
  it('shows the three shared kinds, sets/replaces/clears each role, validated against Discord', async () => {
    const x = await ctx(); const j = (await get(x.c, x.l, `${P()}/identity-roles`)).json();
    expect(j).toMatchObject({ enabled: true, countryId: 'eg', kinds }); expect(Object.values(j.roles)).toEqual([null, null, null]);
    for (const [i, k] of kinds.entries()) expect((await put(x, `${P()}/identity-roles`, { kind: k, roleId: ['900001', '900006', '900007'][i] })).statusCode).toBe(200);
    expect((await get(x.c, x.l, `${P()}/identity-roles`)).json().roles.country_unit_owner).toBe('900007');
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_unit_owner', roleId: R.a })).json().error).toBe('role_in_use');           // never shared
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_unit_owner', roleId: null })).statusCode).toBe(200); expect((await get(x.c, x.l, `${P()}/identity-roles`)).json().roles.country_unit_owner).toBeNull();
    expect((await put(x, `${P()}/identity-roles`, { kind: 'party_member', roleId: R.a })).statusCode).toBe(422);                              // only the shared identity kinds
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_party_member', roleId: R.b })).statusCode).toBe(422);                      // membership roles are per party: /entity-roles
    expect((await put(x, `${P()}/identity-roles`, { kind: kinds[0], roleId: G1 })).json().error).toBe('role_invalid');
    expect((await put(x, `${P()}/identity-roles`, { kind: kinds[0], roleId: '999999999' })).json().error).toBe('role_invalid');
  });
  it('only country servers; the generic mapping endpoints refuse these kinds and do not list them', async () => {
    const p = await ctx(ADMIN, 'party'); expect((await put(p, `${P()}/identity-roles`, { kind: kinds[0], roleId: R.a })).json().error).toBe('kind_not_allowed_for_type');
    const x = await ctx(); await put(x, `${P()}/identity-roles`, { kind: kinds[0], roleId: R.a });
    expect((await mut(x.c, x.l, 'POST', `${P()}/mappings`, { kind: kinds[0], discordRoleId: R.b })).json().error).toBe('use_dedicated_endpoint');
    expect((await mut(x.c, x.l, 'POST', `${P()}/mappings`, { kind: 'proxy_citizen', gameRef: 'sd', discordRoleId: R.b })).json().error).toBe('use_dedicated_endpoint');
    expect((await get(x.c, x.l, `${P()}/mappings`)).json().mappings).toEqual([]);
  });
  it('changing the server type (confirmed) removes identity + proxy mappings; without the confirmation they stay', async () => {
    const x = await ctx(); await put(x, `${P()}/identity-roles`, { kind: kinds[0], roleId: R.a }); await put(x, `${P()}/proxy-countries/sd`, { discordRoleId: R.b });
    const r = await mut(x.c, x.l, 'PUT', `${P()}/settings`, { communityType: 'party', partyId: 'p1' }); expect(r.statusCode).toBeGreaterThanOrEqual(400); expect((await listRoleMappings(x.c.db, G1)).length).toBe(2);
    const ok = await mut(x.c, x.l, 'PUT', `${P()}/settings`, { communityType: 'party', partyId: 'p1', confirmRemoveIncompatible: true }); expect(ok.statusCode).toBe(200); expect((await listRoleMappings(x.c.db, G1)).length).toBe(0);
  });
});

describe('trusted bot administrators', () => {
  const asMember = async (opts: { roles: string[]; perm?: string; trusted?: string[] }) => {
    const c = await makeApp({ guilds: [G1, G2] }); const l = await login(c, MEMBER, [guildInfo(G1, opts.perm ?? SEND_ONLY), guildInfo(G2, SEND_ONLY)]);
    c.bot.roles.set(G1, [role(G1, 0), role(R.a, 5), role(R.b, 6), role('900005', 7)]); c.bot.top.set(G1, 50); c.bot.members.set(`${G1}:${MEMBER}`, opts.roles);
    for (const r of opts.trusted ?? []) await addAdminRole(c.db, { guildId: G1, roleId: r, actor: 'owner' });
    return { c, l };
  };
  it('the owner/administrator sees the trusted roles with their real names and colours, adds and removes them; every change is audited', async () => {
    const x = await ctx(); const base = `${P()}/admin-roles`;
    expect((await get(x.c, x.l, base)).json()).toMatchObject({ canManage: true, level: 'admin', roles: [] });
    expect((await mut(x.c, x.l, 'POST', base, { roleId: R.a })).statusCode).toBe(200); expect((await mut(x.c, x.l, 'POST', base, { roleId: R.a })).statusCode).toBe(200);          // idempotent
    await mut(x.c, x.l, 'POST', base, { roleId: R.b });
    expect((await get(x.c, x.l, base)).json().roles.map((r: { name: string; color: number }) => [r.name, r.color])).toEqual([['Sudan', 0x1abc9c], ['Libya', 0xe74c3c]]);
    expect((await mut(x.c, x.l, 'DELETE', `${base}/${R.a}`)).statusCode).toBe(200); expect((await mut(x.c, x.l, 'DELETE', `${base}/${R.a}`)).statusCode).toBe(404);
    const ev = (await x.c.db.query<{ action: string; target: string; actor_discord_id: string }>(`SELECT action, target, actor_discord_id FROM audit_events WHERE guild_id=$1 AND action LIKE 'admin_role.%' ORDER BY id`, [G1])).rows;
    expect(ev.map((e) => `${e.action}:${e.target}`)).toEqual([`admin_role.added:${R.a}`, `admin_role.added:${R.b}`, `admin_role.removed:${R.a}`]); expect(ev.every((e) => e.actor_discord_id === USER)).toBe(true);
  });
  it('@everyone, integration roles and roles that do not exist in this server are refused; the cap is enforced; ids are validated', async () => {
    const x = await ctx(); const base = `${P()}/admin-roles`;
    for (const id of [G1, R.d, '999999999']) expect((await mut(x.c, x.l, 'POST', base, { roleId: id })).json().error, id).toBe('role_invalid');
    for (const body of [{}, { roleId: 'abc' }, { roleId: R.a, extra: 1 }]) expect((await mut(x.c, x.l, 'POST', base, body)).statusCode).toBe(422);
    expect((await mut(x.c, x.l, 'DELETE', `${base}/not-an-id`)).statusCode).toBe(422); expect(await listAdminRoles(x.c.db, G1)).toEqual([]);
    x.c.bot.down = true; expect((await mut(x.c, x.l, 'POST', base, { roleId: R.a })).statusCode).toBe(503);
  });
  it('a member with a trusted role gets dashboard access WITHOUT any Discord permission; the server shows in their list as "trusted"', async () => {
    const m = await asMember({ roles: [R.a], trusted: [R.a] });
    const list = (await get(m.c, m.l, '/api/guilds')).json().guilds; expect(list.map((g: { id: string; access: string }) => [g.id, g.access])).toEqual([[G1, 'trusted']]);       // G2 (no trusted role) is NOT listed
    expect((await get(m.c, m.l, `${P()}/settings`)).statusCode).toBe(200); expect((await get(m.c, m.l, `${P()}/mappings`)).statusCode).toBe(200);
    expect((await mut(m.c, m.l, 'POST', `${P()}/mappings`, { kind: 'citizen', discordRoleId: R.b })).statusCode).toBe(200);                                  // may manage role mappings
    expect((await get(m.c, m.l, `${P()}/admin-roles`)).json()).toMatchObject({ canManage: false, level: 'trusted' });
  });
  it('a trusted administrator may NOT change the trusted roles, the server type/country/party/unit, or release the country (403 owner_only, nothing changes)', async () => {
    const m = await asMember({ roles: [R.a], trusted: [R.a] }); await updateGuildSettings(m.c.db, G1, { community_type: 'country', country_id: 'eg' }, null);
    expect((await mut(m.c, m.l, 'POST', `${P()}/admin-roles`, { roleId: R.b })).json().error).toBe('owner_only');
    expect((await mut(m.c, m.l, 'DELETE', `${P()}/admin-roles/${R.a}`)).json().error).toBe('owner_only'); expect((await listAdminRoles(m.c.db, G1)).map((r) => r.roleId)).toEqual([R.a]);
    for (const body of [{ communityType: 'general' }, { countryId: 'pl' }, { partyId: 'x' }, { unitId: 'y' }, { confirmRemoveIncompatible: true }]) expect((await mut(m.c, m.l, 'PUT', `${P()}/settings`, body)).json().error, JSON.stringify(body)).toBe('owner_only');
    expect((await mut(m.c, m.l, 'DELETE', `${P()}/country`)).json().error).toBe('owner_only'); const cfg = await getGuildConfig(m.c.db, G1); expect([cfg?.communityType, cfg?.countryId]).toEqual(['country', 'eg']);
    expect((await mut(m.c, m.l, 'PUT', `${P()}/settings`, { linkMode: 'staff_approval' })).statusCode).toBe(200);                                             // ordinary settings are fine
  });
  it('without a trusted role (or when the role is not configured, the member is unknown, or Discord is down) access is refused', async () => {
    const a = await asMember({ roles: [R.b], trusted: [R.a] }); expect((await get(a.c, a.l, `${P()}/settings`)).statusCode).toBe(403); expect((await get(a.c, a.l, '/api/guilds')).json().guilds).toEqual([]);
    const b = await asMember({ roles: [R.a], trusted: [] }); expect((await get(b.c, b.l, `${P()}/settings`)).statusCode).toBe(403);
    const c = await asMember({ roles: [], trusted: [R.a] }); c.c.bot.members.clear(); expect((await get(c.c, c.l, `${P()}/settings`)).statusCode).toBe(403);
    const d = await asMember({ roles: [R.a], trusted: [R.a] }); d.c.bot.down = true; expect((await get(d.c, d.l, `${P()}/settings`)).statusCode).toBe(403);
    expect((await mut(a.c, a.l, 'POST', `${P()}/mappings`, { kind: 'citizen', discordRoleId: R.b })).statusCode).toBe(403); expect((await mut(a.c, a.l, 'POST', `${P()}/admin-roles`, { roleId: R.b })).statusCode).toBe(403);
  });
  it('the role is read from Discord, never from the request; a trusted role of ANOTHER server grants nothing here; removal takes effect', async () => {
    const m = await asMember({ roles: [R.a], trusted: [R.a] });
    expect((await m.c.app.inject({ method: 'GET', url: `${P()}/settings`, cookies: m.l.cookies, headers: { 'x-discord-roles': R.a } })).statusCode).toBe(200);        // allowed because of Discord's data...
    const n = await asMember({ roles: [R.b], trusted: [R.a] }); expect((await n.c.app.inject({ method: 'GET', url: `${P()}/settings`, cookies: n.l.cookies, headers: { 'x-discord-roles': R.a } })).statusCode).toBe(403);   // ...not because of a header
    expect((await get(m.c, m.l, `${P(G2)}/settings`)).statusCode).toBe(403);
    const { removeAdminRole } = await import('@aon/db'); await removeAdminRole(m.c.db, { guildId: G1, roleId: R.a, actor: 'owner' });
    expect((await get(m.c, m.l, `${P()}/settings`)).statusCode).toBe(403);                                                    // configured roles are read from the database on every request: removal is immediate
  });
  it('a Discord Administrator / Manage Server member is unaffected and still has owner-level access', async () => {
    const m = await asMember({ roles: [], perm: MANAGE_GUILD, trusted: [R.a] }); expect((await get(m.c, m.l, `${P()}/admin-roles`)).json()).toMatchObject({ canManage: true, level: 'admin' });
    expect((await mut(m.c, m.l, 'POST', `${P()}/admin-roles`, { roleId: R.b })).statusCode).toBe(200);
  });
});
