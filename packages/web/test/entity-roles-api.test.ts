import { describe, expect, it } from 'vitest';
import { listRoleMappings, updateGuildSettings, setIdentityRole } from '@aon/db';
import { ADMIN, SEND_ONLY, get, guildInfo, login, makeApp, mut, role, type Ctx, type Login } from './harness.js';

const G1 = '100000001', G2 = '100000002', USER = '42';
const R = { a: '900001', b: '900002', c: '900003', d: '900004', e: '900005' };            // 900003 is above the bot, 900004 is an integration role
const P = (g = G1) => `/api/guilds/${g}`;
type X = { c: Ctx; l: Login };
const put = ({ c, l }: X, url: string, body: unknown) => mut(c, l, 'PUT', url, body);
const del = ({ c, l }: X, url: string) => mut(c, l, 'DELETE', url);
const party = (id: string, name: string) => ({ id, name, leaderId: 'x', leaderName: null, members: 3, ruling: false });
const unit = (id: string, name: string, countryId: string | null, logoUrl: string | null = null) => ({ id, name, countryId, ownerId: 'o', ownerName: null, members: 3, capacity: 10, joinPolicy: null, logoUrl });

/** A game whose lists depend on the country that is asked for (the shared fake ignores the country). */
async function ctx(type: 'country' | 'party' = 'country'): Promise<X> {
  const c = await makeApp({ guilds: [G1, G2] }); const l = await login(c, USER, [guildInfo(G1, ADMIN), guildInfo(G2, SEND_ONLY)]);
  c.bot.roles.set(G1, [role(G1, 0), role(R.a, 5, { name: 'A' }), role(R.b, 6, { name: 'B' }), role(R.c, 60), role(R.d, 2, { managed: true }), role(R.e, 7)]); c.bot.top.set(G1, 50);
  await updateGuildSettings(c.db, G1, type === 'country' ? { community_type: 'country', country_id: 'eg', modules: { government: true, party: true, unit: true, alliance: false, ranks: false } } : { community_type: 'party', party_id: 'p1' }, null);
  const parties: Record<string, unknown[]> = { eg: [party('pa', 'Alpha Party'), party('pb', 'Beta Party'), party('pc', 'Gamma Union')], sd: [party('pf', 'Foreign Party')] };
  const units: Record<string, unknown[]> = {
    eg: [unit('mu1', 'First Field Army', 'eg', 'https://cdn.example/mu1.png'), unit('mu2', 'Second Field Army', 'eg'), unit('muX', 'Smuggled Foreign Unit', 'sd')],           // the game list contains a foreign unit: it must still never be offered
    sd: [unit('muF', 'Sudan Unit', 'sd')],
  };
  c.game.countryParties = (async (id?: string) => { c.game.calls.push(`parties:${id}`); return { status: 'ok', data: parties[id ?? ''] ?? [] }; }) as never;
  c.game.countryUnits = (async (id?: string) => { c.game.calls.push(`units:${id}`); return { status: 'ok', data: units[id ?? ''] ?? [] }; }) as never;
  return { c, l };
}
const names = (r: { json(): { items: { name: string }[] } }) => r.json().items.map((i) => i.name);

describe('country-scoped entity selector (server decides the country)', () => {
  it('lists ONLY the server\'s own country\'s parties and units; searchable; paginated; image only when the game gave one', async () => {
    const x = await ctx();
    expect(names(await get(x.c, x.l, `${P()}/country-entities/party`))).toEqual(['Alpha Party', 'Beta Party', 'Gamma Union']);
    expect(names(await get(x.c, x.l, `${P()}/country-entities/party?q=beta`))).toEqual(['Beta Party']);
    const units = await get(x.c, x.l, `${P()}/country-entities/unit`); expect(names(units)).toEqual(['First Field Army', 'Second Field Army']);             // the foreign unit inside Egypt's list is dropped
    expect(units.json().items[0]).toMatchObject({ id: 'mu1', imageUrl: 'https://cdn.example/mu1.png' }); expect(units.json().items[1].imageUrl).toBeUndefined();
    const page = (await get(x.c, x.l, `${P()}/country-entities/party?limit=2&offset=2`)).json(); expect(page).toMatchObject({ total: 3, hasMore: false }); expect(page.items.map((i: { name: string }) => i.name)).toEqual(['Gamma Union']);
    expect(JSON.stringify([...(await get(x.c, x.l, `${P()}/country-entities/party`)).json().items])).not.toContain('Foreign');
  });
  it('a browser-supplied country is refused, never honoured; no country configured / not a country server => 409', async () => {
    const x = await ctx(); expect((await get(x.c, x.l, `${P()}/country-entities/party?countryId=sd`)).statusCode).toBe(422);
    expect(x.c.game.calls.filter((c) => c === 'parties:sd')).toEqual([]);                                                                                    // the foreign country was never even requested
    const p = await ctx('party'); expect((await get(p.c, p.l, `${P()}/country-entities/party`)).statusCode).toBe(409);
    expect((await get(x.c, x.l, `${P()}/country-entities/bogus`)).statusCode).toBe(422);
  });
  it('the game list being down is a clear 503, not an empty list', async () => {
    const x = await ctx(); x.c.game.countryParties = (async () => ({ status: 'error', message: 'down' })) as never;
    expect((await get(x.c, x.l, `${P()}/country-entities/party`)).statusCode).toBe(503);
  });
  it('another server is not reachable (403) and results are cached (one upstream call per country)', async () => {
    const x = await ctx(); expect((await get(x.c, x.l, `${P(G2)}/country-entities/party`)).statusCode).toBe(403);
    await get(x.c, x.l, `${P()}/country-entities/party`); await get(x.c, x.l, `${P()}/country-entities/party?q=a`); expect(x.c.game.calls.filter((c) => c === 'parties:eg')).toHaveLength(1);
  });
});

describe('entity-roles API: per-party / per-unit membership roles', () => {
  it('sets, lists (with names and images), replaces and removes the role of ONE party / unit; audited with the actor', async () => {
    const x = await ctx(); const base = `${P()}/entity-roles`;
    expect((await put(x, `${base}/party/pa`, { discordRoleId: R.a })).json()).toMatchObject({ ok: true, entityId: 'pa', name: 'Alpha Party' });
    expect((await put(x, `${base}/party/pb`, { discordRoleId: R.b })).statusCode).toBe(200);
    expect((await put(x, `${base}/unit/mu1`, { discordRoleId: R.e })).json()).toMatchObject({ ok: true, name: 'First Field Army' });
    const j = (await get(x.c, x.l, base)).json();
    expect(j).toMatchObject({ enabled: true, countryId: 'eg', legacy: [] });
    expect(j.parties.items).toEqual([{ entityId: 'pa', name: 'Alpha Party', imageUrl: null, discordRoleId: R.a, inCountry: true }, { entityId: 'pb', name: 'Beta Party', imageUrl: null, discordRoleId: R.b, inCountry: true }]);
    expect(j.units.items).toEqual([{ entityId: 'mu1', name: 'First Field Army', imageUrl: 'https://cdn.example/mu1.png', discordRoleId: R.e, inCountry: true }]);
    expect((await put(x, `${base}/party/pa`, { discordRoleId: R.b })).json().error).toBe('role_in_use');                       // two parties never share a role
    expect((await del(x, `${base}/party/pa`)).statusCode).toBe(200); expect((await del(x, `${base}/party/pa`)).statusCode).toBe(404);
    expect((await get(x.c, x.l, base)).json().parties.items.map((i: { entityId: string }) => i.entityId)).toEqual(['pb']);
    const ev = (await x.c.db.query<{ action: string; actor_discord_id: string }>(`SELECT action, actor_discord_id FROM audit_events WHERE guild_id=$1 AND action LIKE 'entity_role.%' ORDER BY id`, [G1])).rows;
    expect(ev.map((e) => e.action)).toEqual(['entity_role.set', 'entity_role.set', 'entity_role.set', 'entity_role.removed']); expect(ev.every((e) => e.actor_discord_id === USER)).toBe(true);
  });
  it('COUNTRY ISOLATION on the server: a foreign party / unit (or one smuggled into the list) can never be assigned; nothing is saved', async () => {
    const x = await ctx(); const base = `${P()}/entity-roles`;
    expect((await put(x, `${base}/party/pf`, { discordRoleId: R.a })).json().error).toBe('entity_not_in_country');             // Sudan's party
    expect((await put(x, `${base}/unit/muF`, { discordRoleId: R.a })).json().error).toBe('entity_not_in_country');              // Sudan's unit
    expect((await put(x, `${base}/unit/muX`, { discordRoleId: R.a })).json().error).toBe('entity_not_in_country');              // foreign unit present in Egypt's own list
    expect((await put(x, `${base}/party/nope`, { discordRoleId: R.a })).json().error).toBe('entity_not_in_country');
    expect((await put(x, `${base}/unit/pa`, { discordRoleId: R.a })).json().error).toBe('entity_not_in_country');               // a party id used as a unit id
    expect((await listRoleMappings(x.c.db, G1)).length).toBe(0);
  });
  it('validation: malformed ids / bodies, unknown types, roles that do not exist or are not usable, other server types, game list down', async () => {
    const x = await ctx(); const base = `${P()}/entity-roles`;
    for (const body of [{}, { discordRoleId: 'abc' }, { discordRoleId: R.a, extra: 1 }, { discordRoleId: 5 }]) expect((await put(x, `${base}/party/pa`, body)).statusCode, JSON.stringify(body)).toBe(422);
    expect((await put(x, `${base}/party/bad%20id!`, { discordRoleId: R.a })).statusCode).toBe(422); expect((await put(x, `${base}/alliance/pa`, { discordRoleId: R.a })).statusCode).toBe(422);
    for (const id of ['999999999', G1, R.d]) expect((await put(x, `${base}/party/pa`, { discordRoleId: id })).json().error, id).toBe('role_invalid');
    const p = await ctx('party'); expect((await put(p, `${P()}/entity-roles/party/pa`, { discordRoleId: R.a })).json().error).toBe('not_country_server');
    const y = await ctx(); y.c.game.countryParties = (async () => ({ status: 'incomplete', missing: ['parties[]'] })) as never; expect((await put(y, `${P()}/entity-roles/party/pa`, { discordRoleId: R.a })).statusCode).toBe(503);   // never saved on a guess
    expect((await listRoleMappings(y.c.db, G1)).length).toBe(0);
    x.c.bot.down = true; expect((await put(x, `${base}/party/pa`, { discordRoleId: R.a })).statusCode).toBe(503);
  });
  it('a role is exclusive across party roles, unit roles, shared roles and proxy roles; the citizen role may be shared with proxies only', async () => {
    const x = await ctx(); const base = `${P()}/entity-roles`;
    await put(x, `${base}/party/pa`, { discordRoleId: R.a });
    expect((await put(x, `${base}/unit/mu1`, { discordRoleId: R.a })).json().error).toBe('role_in_use');
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_unit_owner', roleId: R.a })).json().error).toBe('role_in_use');
    expect((await put(x, `${P()}/proxy-countries/pl`, { discordRoleId: R.a })).json().error).toBe('role_in_use');
    await put(x, `${P()}/identity-roles`, { kind: 'country_party_president', roleId: R.b });
    expect((await put(x, `${base}/party/pb`, { discordRoleId: R.b })).json().error).toBe('role_in_use');
    await mut(x.c, x.l, 'POST', `${P()}/mappings`, { kind: 'citizen', discordRoleId: R.e });
    expect((await put(x, `${P()}/proxy-countries/pl`, { discordRoleId: R.e })).statusCode).toBe(200);                       // shared citizen role
  });
  it('listing flags an entity that is no longer in the country list, and never fails when the game is down', async () => {
    const x = await ctx(); await put(x, `${P()}/entity-roles/party/pa`, { discordRoleId: R.a });
    await x.c.db.query(`SELECT 1`);                                                                                               // (the list cache is per app instance: use fresh apps for the changed game data)
    const gone = await ctx(); await mut(gone.c, gone.l, 'PUT', `${P()}/entity-roles/party/pa`, { discordRoleId: R.a });
    await gone.c.db.query(`DELETE FROM role_mappings WHERE guild_id=$1`, [G1]); await gone.c.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'country_party_member','pz',$2)`, [G1, R.a]);
    expect((await get(gone.c, gone.l, `${P()}/entity-roles`)).json().parties.items[0]).toMatchObject({ entityId: 'pz', name: null, inCountry: false });        // configured earlier, no longer in the country
    const fresh = await ctx(); fresh.c.game.countryParties = (async () => ({ status: 'error', message: 'down' })) as never;
    await fresh.c.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'country_party_member','pa',$2)`, [G1, R.a]);
    const down = await get(fresh.c, fresh.l, `${P()}/entity-roles`); expect(down.statusCode).toBe(200); expect(down.json().parties.items[0]).toMatchObject({ entityId: 'pa', name: null, inCountry: null });
  });
  it('legacy general rows are reported and can be removed without touching per-entity roles', async () => {
    const x = await ctx(); await put(x, `${P()}/entity-roles/party/pa`, { discordRoleId: R.a });
    await x.c.db.query(`ALTER TABLE role_mappings DROP CONSTRAINT role_mappings_entity_member_ref`);
    await x.c.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'country_party_member','',$2)`, [G1, R.b]);
    expect((await get(x.c, x.l, `${P()}/entity-roles`)).json().legacy).toEqual([{ kind: 'country_party_member', discordRoleId: R.b }]);
    expect((await del(x, `${P()}/entity-roles/party/legacy`)).statusCode).toBe(200);
    const j = (await get(x.c, x.l, `${P()}/entity-roles`)).json(); expect(j.legacy).toEqual([]); expect(j.parties.items).toHaveLength(1);
  });
  it('authorization: another server\'s dashboard is forbidden, writes without CSRF / from a foreign origin are refused', async () => {
    const x = await ctx(); expect((await get(x.c, x.l, `${P(G2)}/entity-roles`)).statusCode).toBe(403);
    expect((await put(x, `${P(G2)}/entity-roles/party/pa`, { discordRoleId: R.a })).statusCode).toBe(403);
    const noCsrf = await x.c.app.inject({ method: 'PUT', url: `${P()}/entity-roles/party/pa`, cookies: x.l.cookies, headers: { origin: 'http://localhost' }, payload: { discordRoleId: R.a } }); expect(noCsrf.statusCode).toBeGreaterThanOrEqual(400);
    expect((await listRoleMappings(x.c.db, G1)).length).toBe(0);
  });
  it('the generic mapping endpoint cannot smuggle in a foreign party / unit for a country server either', async () => {
    const x = await ctx(); const post = (body: unknown) => mut(x.c, x.l, 'POST', `${P()}/mappings`, body);
    expect((await post({ kind: 'party_member', gameRef: 'pf', discordRoleId: R.a })).json().error).toBe('entity_not_in_country');
    expect((await post({ kind: 'unit_leader', gameRef: 'muF', discordRoleId: R.a })).json().error).toBe('entity_not_in_country');
    expect((await post({ kind: 'unit_member', gameRef: 'muX', discordRoleId: R.a })).json().error).toBe('entity_not_in_country');
    expect((await post({ kind: 'party_member', gameRef: 'pa', discordRoleId: R.a })).statusCode).toBe(200);
    expect((await listRoleMappings(x.c.db, G1)).map((m) => m.gameRef)).toEqual(['pa']);
    const y = await ctx(); y.c.game.countryParties = (async () => ({ status: 'error', message: 'down' })) as never;
    expect((await mut(y.c, y.l, 'POST', `${P()}/mappings`, { kind: 'party_leader', gameRef: 'pb', discordRoleId: R.b })).statusCode).toBe(503);        // cannot be proven => refused, not guessed
    expect((await listRoleMappings(y.c.db, G1)).length).toBe(0);
  });
  it('the shared roles are untouched by all of this: president / leader / owner still use the identity-roles endpoint', async () => {
    const x = await ctx(); expect((await setIdentityRole(x.c.db, { guildId: G1, kind: 'country_unit_owner', discordRoleId: R.e, actor: null })).ok).toBe(true);
    expect((await get(x.c, x.l, `${P()}/identity-roles`)).json().roles).toEqual({ country_party_president: null, country_unit_leader: null, country_unit_owner: R.e });
  });
});

describe('M1.1: one membership role per party / unit, across the generic and the country mapping', () => {
  it('a party that already has a membership role (either kind) cannot get a second one: 409 role_entity_duplicate; a different party still can', async () => {
    const x = await ctx(); const post = (body: unknown) => mut(x.c, x.l, 'POST', `${P()}/mappings`, body);
    expect((await put(x, `${P()}/entity-roles/party/pa`, { discordRoleId: R.a })).statusCode).toBe(200);
    const dup = await post({ kind: 'party_member', gameRef: 'pa', discordRoleId: R.b }); expect(dup.statusCode).toBe(409); expect(dup.json().error).toBe('role_entity_duplicate');
    expect((await post({ kind: 'party_member', gameRef: 'pb', discordRoleId: R.b })).statusCode).toBe(200);
    const dup2 = await put(x, `${P()}/entity-roles/party/pb`, { discordRoleId: R.e }); expect(dup2.statusCode).toBe(409); expect(dup2.json().error).toBe('role_entity_duplicate');
    expect((await listRoleMappings(x.c.db, G1)).map((m) => `${m.kind}:${m.gameRef}`).sort()).toEqual(['country_party_member:pa', 'party_member:pb']);
  });
});

describe('M5a: read-only API data probe (shape of the linked account\'s profile and stats; never personal values)', () => {
  const PROFILE = { id: 'usr_SECRET_ID', username: 'SecretName', bio: 'a private bio', joinedAt: '2026-01-01T00:00:00Z', level: 29, party: { id: 'pa', name: 'Secret Party', role: 'leader' }, militaryUnit: null };
  const link = async (x: X, playerId = 'player-123') => x.c.db.query(`INSERT INTO global_links (discord_user_id, player_id, player_username, method, verified_in_guild) VALUES ($1,$2,'SecretName','admin_forced',$3)`, [USER, playerId, G1]);
  it('needs a linked account (409), takes the player id from the link (never from the browser) and reports shape only', async () => {
    const x = await ctx(); const asked: string[] = [];
    x.c.game.playerRaw = (async (id: string) => { asked.push(id); return { profile: { status: 'ok', data: { ...PROFILE, skills: [{ code: 'attack', level: 4, maxLevel: 10 }] } }, stats: { status: 'ok', data: { level: 29, damage: { all: 5 }, name: 'SecretName' } } }; }) as never;
    expect((await get(x.c, x.l, `${P()}/diagnostics/api-shape`)).json().error).toBe('not_linked'); expect(asked).toEqual([]);
    await link(x); const r = await get(x.c, x.l, `${P()}/diagnostics/api-shape`); expect(r.statusCode).toBe(200); expect(asked).toEqual(['player-123']);
    const j = r.json(); expect(j.profile.status).toBe('ok'); expect(j.profile.skillKeysPresent).toBe(true); expect(j.stats.skillKeysPresent).toBe(false);
    expect(j.profile.skillHints).toContainEqual({ path: 'skills[0].code', value: 'attack' }); expect(j.profile.skillHints).toContainEqual({ path: 'level', value: 29 });
    const text = JSON.stringify(j); for (const secret of ['usr_SECRET_ID', 'SecretName', 'a private bio', '2026-01-01', 'Secret Party', 'player-123']) expect(text, secret).not.toContain(secret);
    expect((await x.c.db.query(`SELECT details FROM audit_events WHERE guild_id=$1 AND action='diagnostics.api_shape'`, [G1])).rows).toHaveLength(1);
    expect((await get(x.c, x.l, `${P()}/diagnostics/api-shape?playerId=other`)).statusCode).toBeLessThan(500);              // a browser-supplied id is simply ignored
    expect(asked.every((a) => a === 'player-123')).toBe(true);
  });
  it('a failing endpoint is reported per part; no capability => 503; another server => 403; no session => 401', async () => {
    const x = await ctx(); await link(x);
    x.c.game.playerRaw = (async () => ({ profile: { status: 'error', message: 'down' }, stats: { status: 'ok', data: { level: 1 } } })) as never;
    const j = (await get(x.c, x.l, `${P()}/diagnostics/api-shape`)).json(); expect(j.profile).toEqual({ status: 'error' }); expect(j.stats.status).toBe('ok');
    delete (x.c.game as { playerRaw?: unknown }).playerRaw; expect((await get(x.c, x.l, `${P()}/diagnostics/api-shape`)).json().error).toBe('probe_unavailable');
    expect((await get(x.c, x.l, `${P(G2)}/diagnostics/api-shape`)).statusCode).toBe(403);
    expect((await x.c.app.inject({ method: 'GET', url: `${P()}/diagnostics/api-shape` })).statusCode).toBe(401);
  });
});

describe('M2a: optional Unverified-role removal setting', () => {
  const uv = (x: X, body: unknown) => put(x, `${P()}/verification/unverified-role`, body);
  it('is disabled by default; saving enables it for a usable role of THIS server; the setting is returned with the verification stats and audited', async () => {
    const x = await ctx(); expect((await get(x.c, x.l, `${P()}/verification`)).json().unverifiedRole).toEqual({ enabled: false, roleId: null });
    expect((await uv(x, { enabled: true, roleId: R.e })).json()).toMatchObject({ ok: true, unverifiedRole: { enabled: true, roleId: R.e } });
    expect((await get(x.c, x.l, `${P()}/verification`)).json().unverifiedRole).toEqual({ enabled: true, roleId: R.e });
    expect((await uv(x, { enabled: false, roleId: R.e })).statusCode).toBe(200); expect((await get(x.c, x.l, `${P()}/verification`)).json().unverifiedRole).toEqual({ enabled: false, roleId: R.e });
    const ev = (await x.c.db.query<{ actor_discord_id: string; details: { enabled: boolean } }>(`SELECT actor_discord_id, details FROM audit_events WHERE guild_id=$1 AND action='verification.unverified_role.set' ORDER BY id`, [G1])).rows;
    expect(ev.map((e) => e.details.enabled)).toEqual([true, false]); expect(ev.every((e) => e.actor_discord_id === USER)).toBe(true);
  });
  it('validation: shape, missing role, roles that do not exist / are @everyone / managed / above the bot; a disabled setting may keep a role that no longer exists', async () => {
    const x = await ctx();
    for (const body of [{}, { enabled: true }, { enabled: 'yes', roleId: R.e }, { enabled: true, roleId: 'abc' }, { enabled: true, roleId: R.e, extra: 1 }]) expect((await uv(x, body)).statusCode, JSON.stringify(body)).toBe(422);
    expect((await uv(x, { enabled: true, roleId: null })).json().error).toBe('role_required');
    for (const id of ['999999999', G1, R.d]) expect((await uv(x, { enabled: true, roleId: id })).json().error, id).toBe('role_invalid');
    expect((await uv(x, { enabled: true, roleId: R.c })).json().error).toBe('role_not_removable');                                  // above the bot: it could never be removed
    expect((await get(x.c, x.l, `${P()}/verification`)).json().unverifiedRole).toEqual({ enabled: false, roleId: null });                // nothing was saved
    expect((await uv(x, { enabled: false, roleId: '999999999' })).statusCode).toBe(200);
    x.c.bot.down = true; expect((await uv(x, { enabled: true, roleId: R.e })).statusCode).toBe(503); expect((await uv(x, { enabled: false, roleId: null })).statusCode).toBe(200);
  });
  it('a role the bot manages (citizen, proxy, party, ...) is refused with 409, and once enabled the mapping endpoints refuse that role', async () => {
    const x = await ctx(); await mut(x.c, x.l, 'POST', `${P()}/mappings`, { kind: 'citizen', discordRoleId: R.a });
    expect((await uv(x, { enabled: true, roleId: R.a })).json().error).toBe('role_conflict'); expect((await uv(x, { enabled: true, roleId: R.a })).statusCode).toBe(409);
    expect((await uv(x, { enabled: true, roleId: R.b })).statusCode).toBe(200);
    const pm = await mut(x.c, x.l, 'POST', `${P()}/mappings`, { kind: 'president', discordRoleId: R.b }); expect([pm.statusCode, pm.json().error]).toEqual([409, 'role_conflict']);
    expect((await put(x, `${P()}/proxy-countries/pl`, { discordRoleId: R.b })).statusCode).toBe(409);
    expect((await put(x, `${P()}/entity-roles/party/pa`, { discordRoleId: R.b })).statusCode).toBe(409);
    expect((await put(x, `${P()}/identity-roles`, { kind: 'country_unit_owner', roleId: R.b })).statusCode).toBe(409);
  });
  it('authorization: another server is forbidden, a write without the CSRF token is refused, nothing is saved', async () => {
    const x = await ctx(); expect((await uv({ ...x }, { enabled: true, roleId: R.e })).statusCode).toBe(200);
    const y = await ctx(); expect((await put(y, `${P(G2)}/verification/unverified-role`, { enabled: true, roleId: R.e })).statusCode).toBe(403);
    const noCsrf = await y.c.app.inject({ method: 'PUT', url: `${P()}/verification/unverified-role`, cookies: y.l.cookies, headers: { origin: 'http://localhost' }, payload: { enabled: true, roleId: R.e } }); expect(noCsrf.statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(y.c, y.l, `${P()}/verification`)).json().unverifiedRole.enabled).toBe(false);
  });
});
