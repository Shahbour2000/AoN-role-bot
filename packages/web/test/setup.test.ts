import { describe, expect, it } from 'vitest';
import { addRoleMapping, getGuildConfig, listRoleMappings } from '@aon/db';
import { ADMIN, SEND_ONLY, get, guildInfo, login, makeApp, mut, role, type Ctx, type Login } from './harness.js';

const G1 = '100000001', G2 = '100000002';
const party = (id: string, name: string | null) => ({ id, name, leaderId: null, leaderName: null, members: 1, ruling: false });
const unit = (id: string, name: string | null, countryId = 'eg') => ({ id, name, countryId, ownerId: null, ownerName: null, members: 1, capacity: 10, joinPolicy: null });

async function ctx(userGuilds: [string, string][] = [[G1, ADMIN], [G2, ADMIN]]) {
  const c = await makeApp();
  const l = await login(c, '42', userGuilds.map(([g, p]) => guildInfo(g, p)));
  for (const g of [G1, G2]) { c.bot.roles.set(g, [role(g, 0), role('900001', 5), role('900002', 6), role('900003', 7), role('900004', 8)]); c.bot.top.set(g, 50); }
  return { c, l };
}
const settings = async (c: Ctx, l: Login, g = G1) => ((await get(c, l, `/api/guilds/${g}/settings`)).json() as { settings: Record<string, any> }).settings;
const put = (c: Ctx, l: Login, body: unknown, g = G1) => mut(c, l, 'PUT', `/api/guilds/${g}/settings`, body);
const mappingKinds = async (c: Ctx, g = G1) => (await listRoleMappings(c.db, g)).map((m) => m.kind).sort();
const actions = async (c: Ctx, l: Login, g = G1) => ((await get(c, l, `/api/guilds/${g}/audit`)).json() as { events: { action: string }[] }).events.map((e) => e.action);

describe('server types and what they offer', () => {
  it('settings tell the dashboard what the current type allows, what every type offers, and the reservation state', async () => {
    const { c, l } = await ctx(); await put(c, l, { communityType: 'party' });
    const s = await settings(c, l); expect(s['allowedKinds']).toEqual(['party_leader', 'party_member', 'party_role']); expect(s['allowedModules']).toEqual(['party', 'ranks']);
    expect(s['typeRules']['military_unit']).toEqual({ modules: ['unit', 'ranks'], entity: 'unit' }); expect(s['typeRules']['general'].entity).toBeNull(); expect(s['countryReservation']).toBe('none');
  });
  it('Alliance cannot be chosen as a type or enabled as a module', async () => {
    const { c, l } = await ctx(); expect((await put(c, l, { communityType: 'alliance' })).statusCode).toBe(422);
    expect((await put(c, l, { modules: { government: true, party: false, unit: false, alliance: true, ranks: true } })).statusCode).toBe(422);
  });
  it('modules the chosen type does not offer are switched off and REPORTED, never dropped silently', async () => {
    const { c, l } = await ctx(); const r = await put(c, l, { communityType: 'party', modules: { government: true, party: true, unit: true, alliance: false, ranks: true } });
    expect(r.statusCode).toBe(200); expect(r.json().notices.coercedModules).toEqual(['government', 'unit']);
    expect((await settings(c, l))['modules']).toEqual({ government: false, party: true, unit: false, alliance: false, ranks: true });
  });
  it('a mapping can only be created for a role kind the server type offers', async () => {
    const { c, l } = await ctx(); const post = (kind: string, role = '900001', g = G1) => mut(c, l, 'POST', `/api/guilds/${g}/mappings`, { kind, discordRoleId: role });
    await put(c, l, { communityType: 'party' });
    expect((await post('president')).statusCode).toBe(422); expect((await post('president')).json().error).toBe('kind_not_allowed_for_type'); expect((await post('citizen')).statusCode).toBe(422); expect((await post('unit_member')).statusCode).toBe(422);
    expect((await post('party_member')).statusCode).toBe(200);
    await put(c, l, { communityType: 'military_unit' }, G1).then((r) => expect(r.statusCode).toBe(409));           // party_member would be orphaned: needs confirmation
    await put(c, l, { communityType: 'country' }, G2); expect((await post('party_role', '900002', G2)).statusCode).toBe(422); expect((await post('unit_leader', '900002', G2)).statusCode).toBe(200);
  });
});

describe('changing the server type with existing mappings', () => {
  const withMappings = async () => {
    const { c, l } = await ctx(); await put(c, l, { communityType: 'country', countryId: 'eg' });
    for (const [i, k] of (['president', 'citizen', 'party_member', 'unit_leader'] as const).entries()) await addRoleMapping(c.db, { guildId: G1, kind: k, discordRoleId: `90000${i + 1}`, actor: '42' });
    await c.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'alliance_member','','900010')`, [G1]);
    return { c, l };
  };
  it('is refused with the list of affected mappings until the user confirms; nothing is saved by the refused request', async () => {
    const { c, l } = await withMappings(); const before = await mappingKinds(c);
    const r = await put(c, l, { communityType: 'party', language: 'en' });
    expect(r.statusCode).toBe(409); expect(r.json().error).toBe('incompatible_mappings'); expect((r.json().mappings as { kind: string }[]).map((m) => m.kind).sort()).toEqual(['citizen', 'president', 'unit_leader']);
    expect(await mappingKinds(c)).toEqual(before); const s = await settings(c, l); expect(s['communityType']).toBe('country'); expect(s['language']).toBe('ar'); expect(s['countryReservation']).toBe('held');
  });
  it('after explicit confirmation only the incompatible mappings are removed; compatible and legacy alliance mappings are preserved; the reservation is released; it is audited', async () => {
    const { c, l } = await withMappings();
    const r = await put(c, l, { communityType: 'party', confirmRemoveIncompatible: true });
    expect(r.statusCode).toBe(200); expect(r.json().notices.removedMappings).toBe(3);
    expect(await mappingKinds(c)).toEqual(['alliance_member', 'party_member']); expect((await settings(c, l))['communityType']).toBe('party'); expect((await settings(c, l))['countryReservation']).toBe('none');
    expect(await actions(c, l)).toContain('mapping.removed_by_type_change');
    expect((await put(c, l, { communityType: 'country', countryId: 'eg' }, G2)).statusCode).toBe(200);          // the country is free for another server again
  });
  it('confirmation is ignored when nothing needs removing, and a legacy alliance server keeps its type and mappings through unrelated saves', async () => {
    const { c, l } = await ctx(); await c.db.query(`UPDATE guilds SET community_type='alliance', alliance_id='al1' WHERE guild_id=$1`, [G1]);
    await c.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'alliance_leader','','900001')`, [G1]);
    expect((await put(c, l, { language: 'en', demotionMode: 'never', confirmRemoveIncompatible: true })).statusCode).toBe(200);
    const s = await settings(c, l); expect(s['communityType']).toBe('alliance'); expect(s['allianceId']).toBe('al1'); expect(s['allowedKinds']).toEqual([]); expect(await mappingKinds(c)).toEqual(['alliance_leader']);
    expect((await put(c, l, { communityType: 'general' })).statusCode).toBe(200); expect(await mappingKinds(c)).toEqual(['alliance_leader']);     // leaving a legacy type never deletes alliance data
  });
  it('build-role mappings are never treated as incompatible', async () => {
    const { c, l } = await ctx(); await c.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'build_war','','900003')`, [G1]);
    expect((await put(c, l, { communityType: 'military_unit' })).statusCode).toBe(200); expect(await mappingKinds(c)).toEqual(['build_war']);
  });
});

describe('country reservation through the dashboard API', () => {
  it('the first server holds the country; a second server gets a clear conflict, nothing is saved, and the other server is not identified', async () => {
    const { c, l } = await ctx();
    expect((await put(c, l, { communityType: 'country', countryId: 'eg' })).statusCode).toBe(200); expect((await settings(c, l))['countryReservation']).toBe('held');
    const r = await put(c, l, { communityType: 'country', countryId: 'EG', language: 'en' }, G2);
    expect(r.statusCode).toBe(409); expect(r.json().error).toBe('country_reserved'); expect(JSON.stringify(r.json())).not.toContain(G1);
    const s2 = await settings(c, l, G2); expect(s2['countryId']).toBeNull(); expect(s2['communityType']).toBe('general'); expect(s2['language']).toBe('ar');
  });
  it('concurrent claims through the API: exactly one server wins', async () => {
    const { c, l } = await ctx(); const rs = await Promise.all([put(c, l, { communityType: 'country', countryId: 'eg' }, G1), put(c, l, { communityType: 'country', countryId: 'eg' }, G2)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const cfgs = await Promise.all([G1, G2].map((g) => getGuildConfig(c.db, g))); expect(cfgs.filter((x) => x?.countryId === 'eg')).toHaveLength(1);
  });
  it('saving an empty country field never releases it; changing it to another free country moves the reservation atomically', async () => {
    const { c, l } = await ctx(); await put(c, l, { communityType: 'country', countryId: 'eg' });
    const r = await put(c, l, { countryId: null }); expect(r.statusCode).toBe(422); expect(r.json().error).toBe('use_release_endpoint'); expect((await settings(c, l))['countryId']).toBe('eg');
    expect((await put(c, l, { countryId: 'pl' })).statusCode).toBe(200); expect((await put(c, l, { communityType: 'country', countryId: 'eg' }, G2)).statusCode).toBe(200);
    expect((await put(c, l, { communityType: 'country', countryId: 'pl' }, G2)).statusCode).toBe(409);
  });
  it('release is an authorized, audited, CSRF-protected action that frees the country and affects only this server', async () => {
    const { c, l } = await ctx(); await put(c, l, { communityType: 'country', countryId: 'eg' }); await put(c, l, { communityType: 'country', countryId: 'pl' }, G2);
    const noCsrf = await c.app.inject({ method: 'DELETE', url: `/api/guilds/${G1}/country`, cookies: l.cookies, headers: { origin: l.headers['origin']! } }); expect(noCsrf.statusCode).toBe(403);
    expect((await settings(c, l))['countryId']).toBe('eg');
    const r = await mut(c, l, 'DELETE', `/api/guilds/${G1}/country`); expect(r.statusCode).toBe(200); expect(r.json().settings.countryId).toBeNull(); expect(r.json().settings.countryReservation).toBe('none');
    expect((await settings(c, l, G2))['countryReservation']).toBe('held'); expect(await actions(c, l)).toContain('country.released');
    expect((await mut(c, l, 'DELETE', `/api/guilds/${G1}/country`)).statusCode).toBe(409);               // nothing left to release
    expect((await put(c, l, { communityType: 'country', countryId: 'eg' }, G2)).statusCode).toBe(200);   // eg is free now, so G2 may move to it (and thereby frees pl)
    expect((await settings(c, l, G2))['countryId']).toBe('eg');
  });
  it('a user without Manage Server on a guild cannot release (or claim) its country; other guilds are untouched', async () => {
    const { c, l } = await ctx([[G1, ADMIN], [G2, SEND_ONLY]]); await put(c, l, { communityType: 'country', countryId: 'eg' });
    expect((await mut(c, l, 'DELETE', `/api/guilds/${G2}/country`)).statusCode).toBe(403); expect((await put(c, l, { communityType: 'country', countryId: 'pl' }, G2)).statusCode).toBe(403);
    expect((await getGuildConfig(c.db, G2))?.countryId).toBeNull(); expect((await settings(c, l))['countryReservation']).toBe('held');
    const anon = await c.app.inject({ method: 'DELETE', url: `/api/guilds/${G1}/country` }); expect(anon.statusCode).toBe(401);
  });
  it('an existing duplicate (migrated data) keeps working, is told it holds no reservation, and cannot claim another taken country', async () => {
    const { c, l } = await ctx(); await put(c, l, { communityType: 'country', countryId: 'eg' });
    await c.db.query('ALTER TABLE guilds DISABLE TRIGGER guilds_country_reservation'); await c.db.query(`UPDATE guilds SET community_type='country', country_id='eg' WHERE guild_id=$1`, [G2]); await c.db.query('ALTER TABLE guilds ENABLE TRIGGER guilds_country_reservation');
    expect((await settings(c, l, G2))['countryReservation']).toBe('held_by_other');
    expect((await put(c, l, { countryId: 'eg', language: 'en' }, G2)).statusCode).toBe(200); expect((await settings(c, l, G2))['language']).toBe('en');
    expect((await put(c, l, { countryId: 'pl' }, G2)).statusCode).toBe(200);                                  // moving to a FREE country is fine and now reserves it
    expect((await settings(c, l, G2))['countryReservation']).toBe('held');
  });
  it('party / unit / general servers can store a country filter without reserving it', async () => {
    const { c, l } = await ctx(); expect((await put(c, l, { communityType: 'party', countryId: 'eg' }, G1)).statusCode).toBe(200); expect((await put(c, l, { communityType: 'country', countryId: 'eg' }, G2)).statusCode).toBe(200);
  });
});

describe('entity selector API', () => {
  const ent = (c: Ctx, l: Login, type: string, qs = '', g = G1) => get(c, l, `/api/guilds/${g}/entities/${type}${qs ? `?${qs}` : ''}`);
  it('countries: server-side search (prefix matches first), pagination and the unverified flag; only id+name leave the server', async () => {
    const { c, l } = await ctx(); const all = await ent(c, l, 'country'); expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ total: 4, hasMore: false, verified: false, items: [{ id: 'ee', name: 'Estonia' }, { id: 'eg', name: 'Egypt' }, { id: 'de', name: 'Germany' }, { id: 'pl', name: 'Poland' }].sort((a, b) => a.name.localeCompare(b.name)) });
    const q = await ent(c, l, 'country', 'q=eg'); expect(q.json().items.map((i: { id: string }) => i.id)).toEqual(['eg']);
    const prefix = await ent(c, l, 'country', 'q=e'); expect(prefix.json().items.map((i: { name: string }) => i.name)).toEqual(['Egypt', 'Estonia', 'Germany']);       // Egypt/Estonia start with "e"; Germany merely contains it
    const p1 = await ent(c, l, 'country', 'limit=2&offset=0'); const p2 = await ent(c, l, 'country', 'limit=2&offset=2');
    expect(p1.json()).toMatchObject({ hasMore: true, total: 4 }); expect(p2.json()).toMatchObject({ hasMore: false }); expect([...p1.json().items, ...p2.json().items].map((i: { id: string }) => i.id)).toEqual(['eg', 'ee', 'de', 'pl'].sort((a, b) => (all.json().items as { id: string }[]).findIndex((x) => x.id === a) - (all.json().items as { id: string }[]).findIndex((x) => x.id === b)));
    for (const i of all.json().items) expect(Object.keys(i).sort()).toEqual(['id', 'name']);
  });
  it('is case-insensitive and Arabic-safe, and rejects malformed input', async () => {
    const { c, l } = await ctx(); (c.game as any).countriesRes = { status: 'ok', data: [{ id: 'eg', name: 'مصر' }, { id: 'sa', name: 'السعودية' }] };
    expect((await ent(c, l, 'country', `q=${encodeURIComponent('مص')}`)).json().items).toEqual([{ id: 'eg', name: 'مصر' }]);
    expect((await ent(c, l, 'country', 'limit=51')).statusCode).toBe(422); expect((await ent(c, l, 'country', 'offset=-1')).statusCode).toBe(422); expect((await ent(c, l, 'country', `q=${'x'.repeat(41)}`)).statusCode).toBe(422);
    expect((await ent(c, l, 'alliance')).statusCode).toBe(422); expect((await ent(c, l, 'country', 'nope=1')).statusCode).toBe(422);
  });
  it('parties come from the verified per-country list, need a country, drop unnamed entries and are cached', async () => {
    const { c, l } = await ctx(); (c.game as any).parties = { status: 'ok', data: [party('pty_1', 'Ummah Caliphate Party'), party('pty_2', null), party('pty_3', 'National Party')] };
    expect((await ent(c, l, 'party')).json().error).toBe('country_required');
    const r = await ent(c, l, 'party', 'countryId=eg&q=part'); expect(r.json()).toMatchObject({ verified: true, total: 2 }); expect(r.json().items.map((i: { name: string }) => i.name)).toEqual(['Ummah Caliphate Party', 'National Party'].sort((a, b) => (Number(b.toLowerCase().startsWith('part')) - Number(a.toLowerCase().startsWith('part'))) || a.localeCompare(b)));
    await ent(c, l, 'party', 'countryId=eg'); await ent(c, l, 'party', 'countryId=eg&q=u'); expect((c.game as any).calls.filter((x: string) => x === 'parties:eg')).toHaveLength(1);          // cached
    await ent(c, l, 'party', 'countryId=pl'); expect((c.game as any).calls.filter((x: string) => x.startsWith('parties:'))).toHaveLength(2);
  });
  it('units: per-country list when a country is given; otherwise the game search which needs 2+ characters and is flagged unverified', async () => {
    const { c, l } = await ctx(); (c.game as any).unitsList = { status: 'ok', data: [unit('mu_1', 'ALQAHERA'), unit('mu_2', 'Black Flags')] }; (c.game as any).searchRes = { status: 'ok', data: [unit('mu_9', 'Black Eagles', 'pl')] };
    expect((await ent(c, l, 'unit', 'countryId=eg')).json()).toMatchObject({ verified: true, total: 2 });
    expect((await ent(c, l, 'unit')).json()).toMatchObject({ items: [], needsQuery: true }); expect((await ent(c, l, 'unit', 'q=b')).json().needsQuery).toBe(true);
    const s = await ent(c, l, 'unit', 'q=black'); expect(s.json()).toMatchObject({ verified: false, items: [{ id: 'mu_9', name: 'Black Eagles' }] }); expect((c.game as any).calls).toContain('search:black:');
  });
  it('upstream trouble is reported distinctly so the dashboard can retry or fall back to manual input; nothing is invented', async () => {
    const { c, l } = await ctx(); const g = c.game as any;
    g.countriesRes = { status: 'rate_limited', retryAfterMs: 5000 }; expect((await ent(c, l, 'country')).json().error).toBe('game_rate_limited');
    g.countriesRes = { status: 'incomplete', missing: ['countries (unrecognised shape)'] }; const inc = await ent(c, l, 'country'); expect(inc.statusCode).toBe(503); expect(inc.json().error).toBe('game_incomplete');
    g.countriesRes = { status: 'error', message: 'boom' }; expect((await ent(c, l, 'country')).json().error).toBe('game_error');
    g.parties = { status: 'not_found' }; expect((await ent(c, l, 'party', 'countryId=zz')).statusCode).toBe(404);
    g.countriesRes = undefined; (g as any).countryOptions = undefined; expect((await ent(c, l, 'country')).json().error).toBe('game_unavailable');
  });
  it('failures are not cached (a later retry reaches the game again), successes are', async () => {
    const { c, l } = await ctx(); const g = c.game as any; g.countriesRes = { status: 'error', message: 'x' }; await ent(c, l, 'country'); g.countriesRes = { status: 'ok', data: [{ id: 'eg', name: 'Egypt' }] };
    expect((await ent(c, l, 'country')).statusCode).toBe(200); await ent(c, l, 'country'); expect(g.calls.filter((x: string) => x === 'countries')).toHaveLength(2);
  });
  it('resolves the selected entity name without ever failing the page', async () => {
    const { c, l } = await ctx(); const g = c.game as any; g.names['party:pty_1'] = { status: 'ok', data: 'Ummah' };
    expect((await get(c, l, `/api/guilds/${G1}/entities/country/EG`)).json()).toEqual({ id: 'EG', name: 'Egypt' });
    expect((await get(c, l, `/api/guilds/${G1}/entities/party/pty_1`)).json()).toEqual({ id: 'pty_1', name: 'Ummah' });
    expect((await get(c, l, `/api/guilds/${G1}/entities/unit/mu_404`)).json()).toEqual({ id: 'mu_404', name: null });
    expect((await get(c, l, `/api/guilds/${G1}/entities/country/zz`)).json()).toEqual({ id: 'zz', name: null });
    expect((await get(c, l, `/api/guilds/${G1}/entities/party/..%2Fx`)).statusCode).toBe(422);
  });
  it('requires a signed-in manager of THIS guild, and is rate limited', async () => {
    const { c, l } = await ctx([[G1, ADMIN], [G2, SEND_ONLY]]);
    expect((await c.app.inject({ method: 'GET', url: `/api/guilds/${G1}/entities/country` })).statusCode).toBe(401); expect((await ent(c, l, 'country', '', G2)).statusCode).toBe(403);
    let last = 200; for (let i = 0; i < 125 && last !== 429; i++) last = (await ent(c, l, 'country')).statusCode; expect(last).toBe(429);
  });
});
