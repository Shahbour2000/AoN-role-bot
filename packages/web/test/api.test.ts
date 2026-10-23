import { describe, expect, it } from 'vitest';
import { addRoleMapping, claimLink, listLinks } from '@aon/db';
import { ADMIN, get, guildInfo, login, makeApp, mut, role, type Ctx, type Login } from './harness.js';

const G1 = '100000001', G2 = '100000002';
type Rank = { key: string; order: number; nameAr: string; nameEn: string; minDamage: number; discordRoleId: string | null; enabled: boolean };

async function ctx(userGuilds: string[] = [G1, G2]) {
  const c = await makeApp();
  const l = await login(c, '42', userGuilds.map((g) => guildInfo(g, ADMIN)));
  for (const g of [G1, G2]) { c.bot.roles.set(g, [role(g, 0), role('900001', 5), role('900002', 6), role('900003', 60), role('900004', 2, { managed: true })]); c.bot.top.set(g, 50); }
  c.bot.roles.set(G1, [...c.bot.roles.get(G1)!, role('910001', 7)]);                     // exists ONLY in guild 1
  return { c, l };
}
const ranksOf = async (c: Ctx, l: Login, g = G1) => ((await get(c, l, `/api/guilds/${g}/ranks`)).json() as { ranks: Rank[] }).ranks;
const seed = async (c: Ctx, l: Login, g = G1) => (await mut(c, l, 'POST', `/api/guilds/${g}/ranks/reset`)).json() as { ranks: Rank[] };
const auditActions = async (c: Ctx, l: Login, g = G1) => ((await get(c, l, `/api/guilds/${g}/audit`)).json() as { events: { action: string; actor: string | null }[] }).events;

describe('military rank editor API', () => {
  it('reset seeds the 17 starter ranks (Arabic + English names, thresholds as specified by the owner)', async () => {
    const { c, l } = await ctx();
    expect(await ranksOf(c, l)).toEqual([]);
    const r = await seed(c, l);
    expect(r.ranks).toHaveLength(17);
    expect(r.ranks[0]).toMatchObject({ key: 'soldier', nameAr: 'عسكري', minDamage: 10_000, enabled: true, discordRoleId: null });
    expect(r.ranks[16]).toMatchObject({ key: 'field_marshal', nameAr: 'مشير', minDamage: 250_000_000 });
  });
  it('saves edits: rename, re-threshold, disable, map to real guild roles', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    const edited = ranks.map((r) => r.key === 'captain' ? { ...r, nameAr: 'نقيب ركن', minDamage: 6_000_000, discordRoleId: '900001' } : r.key === 'major' ? { ...r, enabled: false } : r);
    const res = await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: edited });
    expect(res.statusCode).toBe(200);
    const back = await ranksOf(c, l);
    expect(back.find((r) => r.key === 'captain')).toMatchObject({ nameAr: 'نقيب ركن', minDamage: 6_000_000, discordRoleId: '900001' });
    expect(back.find((r) => r.key === 'major')!.enabled).toBe(false);
    expect((await auditActions(c, l)).filter((e) => e.action === 'ranks.update').every((e) => e.actor === '42')).toBe(true);
  });
  it('a ladder with any number of ranks is accepted (custom 3-rank ladder)', async () => {
    const { c, l } = await ctx();
    const custom: Rank[] = [1, 2, 3].map((i) => ({ key: `r${i}`, order: i, nameAr: `ر${i}`, nameEn: `R${i}`, minDamage: i * 1000, discordRoleId: null, enabled: true }));
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: custom })).statusCode).toBe(200);
    expect(await ranksOf(c, l)).toHaveLength(3);
  });
  it('REJECTS a higher rank with a lower threshold (422 + issue codes), leaves the stored ladder unchanged, and audits the rejection', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    const bad = ranks.map((r) => (r.key === 'lieutenant_colonel' ? { ...r, minDamage: 4_000_000 } : r));
    const res = await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: bad });
    expect(res.statusCode).toBe(422);
    const j = res.json() as { error: string; issues: { code: string; rankKey: string }[] };
    expect(j.error).toBe('invalid_ladder'); expect(j.issues).toContainEqual(expect.objectContaining({ code: 'THRESHOLD_NOT_INCREASING', rankKey: 'lieutenant_colonel' }));
    expect(await ranksOf(c, l)).toEqual(ranks);
    expect((await auditActions(c, l)).map((e) => e.action)).toContain('ranks.update_rejected');
  });
  it('rejects equal thresholds, duplicate keys/orders, and one Discord role on two ranks', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    const put = (r: Rank[]) => mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: r });
    expect((await put(ranks.map((r) => (r.key === 'major' ? { ...r, minDamage: 5_000_000 } : r)))).statusCode).toBe(422);
    expect((await put(ranks.map((r) => (r.key === 'major' ? { ...r, key: 'captain' } : r)))).statusCode).toBe(422);
    expect((await put(ranks.map((r) => (r.key === 'major' ? { ...r, order: 3 } : r)))).statusCode).toBe(422);
    const dup = await put(ranks.map((r) => (r.order <= 2 ? { ...r, discordRoleId: '900001' } : r)));
    expect(dup.statusCode).toBe(422); expect((dup.json() as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain('DUPLICATE_ROLE');
  });
  it('schema-level validation: strings for numbers, unknown fields, empty and oversized ladders, bad role ids', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    const put = (r: unknown) => mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: r });
    expect((await put(ranks.map((r, i) => (i === 0 ? { ...r, minDamage: '10000' } : r)))).statusCode).toBe(422);
    expect((await put(ranks.map((r, i) => (i === 0 ? { ...r, hacked: true } : r)))).statusCode).toBe(422);
    expect((await put([])).statusCode).toBe(422);
    expect((await put(Array.from({ length: 101 }, (_, i) => ({ ...ranks[0], key: `k${i}`, order: i + 1 })))).statusCode).toBe(422);
    expect((await put(ranks.map((r, i) => (i === 0 ? { ...r, discordRoleId: 'not-a-snowflake' } : r)))).statusCode).toBe(422);
    expect(await ranksOf(c, l)).toEqual(ranks);
  });
  it('role ids must exist in THIS guild; @everyone and integration roles are refused; above-bot roles are allowed but flagged', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    const withRole = (id: string) => ranks.map((r, i) => (i === 0 ? { ...r, discordRoleId: id } : r));
    const put = (id: string) => mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: withRole(id) });
    expect((await put('999999999')).statusCode).toBe(422);                    // unknown id
    expect((await put(G1)).statusCode).toBe(422);                              // @everyone
    expect((await put('900004')).statusCode).toBe(422);                        // managed/integration
    expect((await put('900003')).statusCode).toBe(200);                        // above the bot: config allowed ...
    const roles = ((await get(c, l, `/api/guilds/${G1}/roles`)).json() as { roles: { id: string; manageable: boolean; reason: string | null }[] }).roles;
    expect(roles.find((r) => r.id === '900003')).toMatchObject({ manageable: false, reason: 'above_bot_role' });   // ... and the UI is told why it will not work
    expect(roles.find((r) => r.id === '900001')).toMatchObject({ manageable: true });
  });
  it('a role that exists only in ANOTHER guild is refused', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l, G2)).ranks;
    const res = await mut(c, l, 'PUT', `/api/guilds/${G2}/ranks`, { ranks: ranks.map((r, i) => (i === 0 ? { ...r, discordRoleId: '910001' } : r)) });   // 910001 exists only in G1
    expect(res.statusCode).toBe(422);
  });
  it('Discord unreachable: role-bearing saves fail with 503, role-free saves still work', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks; c.bot.down = true;
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.map((r, i) => (i === 0 ? { ...r, discordRoleId: '900001' } : r)) })).statusCode).toBe(503);
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks })).statusCode).toBe(200);
  });
  it('reset restores default names/thresholds but KEEPS the mapped Discord roles', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.map((r) => (r.key === 'soldier' ? { ...r, discordRoleId: '900001', minDamage: 12_345, nameEn: 'X' } : r)) });
    const back = (await mut(c, l, 'POST', `/api/guilds/${G1}/ranks/reset`)).json() as { ranks: Rank[] };
    expect(back.ranks[0]).toMatchObject({ key: 'soldier', minDamage: 10_000, nameEn: 'Soldier', discordRoleId: '900001' });
  });
});

describe('cross-guild isolation', () => {
  it('edits to one guild never touch another guild the same admin manages', async () => {
    const { c, l } = await ctx(); await seed(c, l, G1); const g2 = await seed(c, l, G2);
    const g1r = await ranksOf(c, l, G1);
    await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: g1r.map((r) => (r.key === 'captain' ? { ...r, minDamage: 6_000_000 } : r)) });
    expect(await ranksOf(c, l, G2)).toEqual(g2.ranks);
    await mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, { kind: 'president', discordRoleId: '900001' });
    expect(((await get(c, l, `/api/guilds/${G2}/mappings`)).json() as { mappings: unknown[] }).mappings).toEqual([]);
    expect((await auditActions(c, l, G2)).some((e) => e.action === 'mapping.added')).toBe(false);
  });
  it('an admin of guild 1 only can neither read nor write guild 2 (every route)', async () => {
    const { c, l } = await ctx([G1]); await seed(c, l, G1);
    for (const p of ['settings', 'ranks', 'mappings', 'links', 'audit', 'roles', 'overview', 'sync/jobs', 'diagnostics']) expect((await get(c, l, `/api/guilds/${G2}/${p}`)).statusCode, p).toBe(403);
    expect((await mut(c, l, 'PUT', `/api/guilds/${G2}/ranks`, { ranks: [] })).statusCode).toBe(403);
    expect((await mut(c, l, 'POST', `/api/guilds/${G2}/ranks/reset`)).statusCode).toBe(403);
    expect((await mut(c, l, 'POST', `/api/guilds/${G2}/sync`)).statusCode).toBe(403);
    expect((await mut(c, l, 'POST', `/api/guilds/${G2}/links/force`, { discordUserId: '123456', playerName: 'x' })).statusCode).toBe(403);
    expect(c.syncCalls).toEqual([]);
  });
  it('object ids from guild 2 cannot be used through guild 1 (links, mappings)', async () => {
    const { c, l } = await ctx([G1]);
    const claim = await claimLink(c.db, { guildId: G2, discordUserId: '555555', playerId: 'p9', username: 'x' }) as { linkId: string };
    await addRoleMapping(c.db, { guildId: G2, kind: 'president', discordRoleId: '900001', actor: null });
    const mapId = (await c.db.query<{ id: string }>(`SELECT id FROM role_mappings WHERE guild_id='${G2}'`)).rows[0]!.id;
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/links/${claim.linkId}/approve`)).statusCode).toBe(404);
    expect((await mut(c, l, 'DELETE', `/api/guilds/${G1}/mappings/${mapId}`)).statusCode).toBe(404);
    expect((await listLinks(c.db, G2, 'pending'))).toHaveLength(1);
    expect((await c.db.query(`SELECT 1 FROM role_mappings WHERE guild_id='${G2}'`)).rows).toHaveLength(1);
  });
});

describe('settings', () => {
  it('partial update persists, and is audited with the actor', async () => {
    const { c, l } = await ctx();
    const r = await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { language: 'en', countryId: 'eg', demotionMode: 'grace', demotionGraceDays: 14, modules: { government: true, party: true, unit: false, alliance: false, ranks: true } });
    expect(r.statusCode).toBe(200);
    const s = ((await get(c, l, `/api/guilds/${G1}/settings`)).json() as { settings: Record<string, unknown> }).settings;
    expect(s).toMatchObject({ language: 'en', countryId: 'eg', demotion: { mode: 'grace', graceDays: 14 } });
    expect((await auditActions(c, l)).find((e) => e.action === 'settings.updated')!.actor).toBe('42');
  });
  it('validates: id format, strict modules, unknown keys, bad enums', async () => {
    const { c, l } = await ctx(); const put = (b: unknown) => mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, b);
    for (const bad of [{ countryId: 'bad id!' }, { modules: { government: true } }, { modules: { government: true, party: true, unit: true, alliance: true, ranks: true, evil: true } }, { language: 'fr' }, { demotionGraceDays: 0 }, { requireStaffApproval: false }, { guild_id: 'x' }]) {
      expect((await put(bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect((await put({})).statusCode).toBe(200);
  });
  it('write endpoints are rate limited per session', async () => {
    const { c, l } = await ctx(); let last = 200;
    for (let i = 0; i < 95; i++) last = (await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { language: i % 2 ? 'en' : 'ar' })).statusCode;
    expect(last).toBe(429);
  });
});

describe('automatic sync schedule (3 / 6 / 12 / 24 hours)', () => {
  const put = (c: Ctx, l: Login, b: unknown, g = G1) => mut(c, l, 'PUT', `/api/guilds/${g}/settings`, b);
  const status = async (c: Ctx, l: Login, g = G1) => (await get(c, l, `/api/guilds/${g}/sync/status`)).json() as { enabled: boolean; intervalHours: number; nextSyncAt: string | null; running: boolean; lastSuccess: unknown; lastJob: unknown };
  it.each([3, 6, 12, 24])('accepts %i hours, persists it, and schedules the next run that far ahead', async (h) => {
    const { c, l } = await ctx();
    const r = await put(c, l, { autoSyncEnabled: true, syncIntervalHours: h });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { settings: Record<string, unknown> }).settings).toMatchObject({ autoSyncEnabled: true, syncIntervalHours: h, syncIntervalMinutes: h * 60 });
    const st = await status(c, l);
    expect(st).toMatchObject({ enabled: true, intervalHours: h, running: false, lastSuccess: null });
    expect(new Date(st.nextSyncAt!).getTime() - c.clock.now.getTime()).toBe(h * 3_600_000);
  });
  it('rejects every other interval (hours or minutes), strings and the old minutes field', async () => {
    const { c, l } = await ctx();
    for (const bad of [{ syncIntervalHours: 1 }, { syncIntervalHours: 5 }, { syncIntervalHours: 48 }, { syncIntervalHours: 0 }, { syncIntervalHours: '6' }, { syncIntervalHours: 6.5 }, { syncIntervalMinutes: 360 }, { sync_interval_minutes: 360 }]) {
      expect((await put(c, l, bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect((await status(c, l)).intervalHours).toBe(6);                                           // default untouched
  });
  it('changing the interval moves the single next run; disabling clears it; the choice survives a re-read', async () => {
    const { c, l } = await ctx();
    await put(c, l, { autoSyncEnabled: true, syncIntervalHours: 24 });
    c.clock.now = new Date(c.clock.now.getTime() + 3_600_000);
    await put(c, l, { syncIntervalHours: 6 });
    const st = await status(c, l); expect(new Date(st.nextSyncAt!).getTime() - c.clock.now.getTime()).toBe(6 * 3_600_000);
    expect(((await get(c, l, `/api/guilds/${G1}/settings`)).json() as { settings: { syncIntervalHours: number } }).settings.syncIntervalHours).toBe(6);
    await put(c, l, { autoSyncEnabled: false });
    expect(await status(c, l)).toMatchObject({ enabled: false, nextSyncAt: null, intervalHours: 6 });
  });
  it('Sync Now works with the schedule off and leaves the schedule untouched when on', async () => {
    const { c, l } = await ctx();
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/sync`)).statusCode).toBe(202);               // auto-sync is off
    await put(c, l, { autoSyncEnabled: true, syncIntervalHours: 12 }); const before = (await status(c, l)).nextSyncAt;
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/sync`)).statusCode).toBe(202);
    expect(c.syncCalls).toEqual([[G1, '42'], [G1, '42']]); expect((await status(c, l)).nextSyncAt).toBe(before);
  });
  it('status exposes the last SUCCESSFUL run and the last result with roles added/removed', async () => {
    const { c, l } = await ctx();
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status, created_at, finished_at, counts, details) VALUES ($1,'scheduled','succeeded', now() - interval '3 hours', now() - interval '3 hours', $2::jsonb, '{}'::jsonb)`, [G1, JSON.stringify({ rolesAdded: 4, rolesRemoved: 2 })]);
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status, created_at, finished_at, counts, details, error) VALUES ($1,'all','failed', now() - interval '1 hours', now() - interval '1 hours', '{}'::jsonb, $2::jsonb, 'rate_limited: stopped early')`, [G1, JSON.stringify({ lookupFailures: { 'roster:rate_limited': 3 } })]);
    const st = await status(c, l) as unknown as { lastSuccess: { counts: Record<string, number> }; lastJob: { status: string; details: { lookupFailures: Record<string, number> } } };
    expect(st.lastSuccess.counts).toMatchObject({ rolesAdded: 4, rolesRemoved: 2 }); expect(st.lastJob.status).toBe('failed'); expect(st.lastJob.details.lookupFailures).toEqual({ 'roster:rate_limited': 3 });
  });
  it('only managers of the guild can read or change it; another guild\'s schedule is untouched', async () => {
    const { c, l } = await ctx([G1]);
    expect((await get(c, l, `/api/guilds/${G2}/sync/status`)).statusCode).toBe(403);
    expect((await put(c, l, { autoSyncEnabled: true, syncIntervalHours: 3 }, G2)).statusCode).toBe(403);
    expect((await mut(c, l, 'POST', `/api/guilds/${G2}/sync`)).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'GET', url: `/api/guilds/${G1}/sync/status` })).statusCode).toBe(401);
    const noCsrf = await c.app.inject({ method: 'PUT', url: `/api/guilds/${G1}/settings`, cookies: l.cookies, payload: { autoSyncEnabled: true, syncIntervalHours: 3 } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await c.db.query(`SELECT count(*)::int AS n FROM guilds WHERE auto_sync_enabled`)).rows[0]).toEqual({ n: 0 });
  });
  it('two guilds keep independent schedules', async () => {
    const { c, l } = await ctx();
    await put(c, l, { autoSyncEnabled: true, syncIntervalHours: 3 }, G1); await put(c, l, { autoSyncEnabled: true, syncIntervalHours: 24 }, G2);
    expect((await status(c, l, G1)).intervalHours).toBe(3); expect((await status(c, l, G2)).intervalHours).toBe(24);
    await put(c, l, { syncIntervalHours: 12 }, G1);
    expect((await status(c, l, G2)).intervalHours).toBe(24);
  });
});

describe('role mappings', () => {
  it('adds, lists and removes mappings; validates kind, role and required game reference', async () => {
    const { c, l } = await ctx();
    const post = (b: unknown) => mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, b);
    expect((await post({ kind: 'president', discordRoleId: '900001' })).statusCode).toBe(200);
    expect((await post({ kind: 'government_role', gameRef: 'ministerForeign', discordRoleId: '900002' })).statusCode).toBe(200);
    expect((await post({ kind: 'government_role', discordRoleId: '900002' })).statusCode).toBe(422);          // raw role required
    expect((await post({ kind: 'god_mode', discordRoleId: '900001' })).statusCode).toBe(422);
    expect((await post({ kind: 'president', discordRoleId: '999999999' })).statusCode).toBe(422);              // not a role of this guild
    expect((await post({ kind: 'president', discordRoleId: G1 })).statusCode).toBe(422);                       // @everyone
    const above = await post({ kind: 'congress', discordRoleId: '900003' });
    expect(above.statusCode).toBe(200); expect((above.json() as { warning: string }).warning).toBe('above_bot_role');
    const list = ((await get(c, l, `/api/guilds/${G1}/mappings`)).json() as { mappings: { id: string; kind: string }[] }).mappings;
    expect(list).toHaveLength(3);
    expect((await mut(c, l, 'DELETE', `/api/guilds/${G1}/mappings/${list[0]!.id}`)).statusCode).toBe(200);
    expect((await mut(c, l, 'DELETE', `/api/guilds/${G1}/mappings/not-a-uuid`)).statusCode).toBe(400);
  });
});

describe('player accounts', () => {
  it('lists, approves, rejects, unlinks and force-links, each audited with the dashboard user', async () => {
    const { c, l } = await ctx();
    const a = await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: 'One' }) as { linkId: string };
    const b = await claimLink(c.db, { guildId: G1, discordUserId: '555552', playerId: 'p2', username: 'Two' }) as { linkId: string };
    expect(((await get(c, l, `/api/guilds/${G1}/links?status=pending`)).json() as { links: unknown[] }).links).toHaveLength(2);
    expect((await get(c, l, `/api/guilds/${G1}/links?status=hax`)).statusCode).toBe(400);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/links/${a.linkId}/approve`, { reason: 'checked in voice' })).statusCode).toBe(200);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/links/${a.linkId}/approve`)).statusCode).toBe(409);       // already reviewed
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/links/${b.linkId}/reject`)).statusCode).toBe(200);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/links/unlink`, { discordUserId: '555551' })).statusCode).toBe(200);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/links/unlink`, { discordUserId: '555551' })).statusCode).toBe(404);
    const acts = await auditActions(c, l);
    for (const x of ['link.approved', 'link.rejected', 'link.unlinked']) expect(acts.find((e) => e.action === x)?.actor, x).toBe('42');
  });
  it('force link: resolves the player, refuses to displace an existing link unless replace is explicit, handles API failures', async () => {
    const { c, l } = await ctx();
    const force = (b: object) => mut(c, l, 'POST', `/api/guilds/${G1}/links/force`, { playerName: 'Alpha', ...b });
    expect((await force({ discordUserId: '555551', reason: 'vc' })).statusCode).toBe(200);
    expect((await force({ discordUserId: '555552' })).statusCode).toBe(409);                                       // same player already linked
    expect((await force({ discordUserId: '555552', replace: true })).statusCode).toBe(200);
    c.game.player = { status: 'not_found' }; expect((await force({ discordUserId: '555553' })).statusCode).toBe(404);
    c.game.player = { status: 'rate_limited' }; expect((await force({ discordUserId: '555553' })).statusCode).toBe(503);
    expect((await force({ discordUserId: 'abc' })).statusCode).toBe(422);
    const rows = ((await get(c, l, `/api/guilds/${G1}/links?status=admin_linked`)).json() as { links: { discordUserId: string; method: string }[] }).links;
    expect(rows.map((r) => [r.discordUserId, r.method])).toEqual([['555552', 'admin_forced']]);
  });
});

describe('sync, audit, overview, diagnostics', () => {
  it('starts a sync as the dashboard user (202), refuses a concurrent one (409), supports cancel', async () => {
    const { c, l } = await ctx();
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/sync`)).statusCode).toBe(202);
    expect(c.syncCalls).toEqual([[G1, '42']]);
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status) VALUES ($1,'all','running')`, [G1]);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/sync`)).statusCode).toBe(409);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/sync/cancel`)).statusCode).toBe(200);
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/sync/cancel`)).statusCode).toBe(404);
    expect(((await get(c, l, `/api/guilds/${G1}/sync/jobs`)).json() as { jobs: { status: string }[] }).jobs[0]!.status).toBe('cancelled');
  });
  it('audit log is newest-first, attributes the actor, and paginates with a cursor', async () => {
    const { c, l } = await ctx();
    for (let i = 0; i < 4; i++) await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { language: i % 2 ? 'en' : 'ar' });
    const p1 = (await get(c, l, `/api/guilds/${G1}/audit?limit=2`)).json() as { events: { id: number; actor: string }[]; nextBefore: number };
    expect(p1.events).toHaveLength(2); expect(p1.events[0]!.id).toBeGreaterThan(p1.events[1]!.id); expect(p1.events.every((e) => e.actor === '42')).toBe(true);
    const p2 = (await get(c, l, `/api/guilds/${G1}/audit?limit=2&before=${p1.nextBefore}`)).json() as { events: { id: number }[] };
    expect(p2.events.every((e) => e.id < p1.nextBefore)).toBe(true);
    expect((await get(c, l, `/api/guilds/${G1}/audit?before=abc`)).statusCode).toBe(400);
  });
  it('overview reports counts and configuration warnings', async () => {
    const { c, l } = await ctx(); await seed(c, l);
    await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { modules: { government: true, party: false, unit: false, alliance: false, ranks: true } });   // the rank system is optional
    await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: 'One' });
    const o = (await get(c, l, `/api/guilds/${G1}/overview`)).json() as { links: { active: number; pending: number }; warnings: string[] };
    expect(o.links).toEqual({ active: 0, pending: 1 });
    expect(o.warnings).toEqual(expect.arrayContaining(['pending_requests', 'rank_roles_unmapped', 'nothing_configured']));
  });
  it('game pickers need a configured country; diagnostics expose no secrets', async () => {
    const { c, l } = await ctx();
    expect((await get(c, l, `/api/guilds/${G1}/game/parties`)).statusCode).toBe(409);
    await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { countryId: 'eg' });
    expect((await get(c, l, `/api/guilds/${G1}/game/parties`)).statusCode).toBe(200);
    const d = (await get(c, l, `/api/guilds/${G1}/diagnostics`)).body;
    expect(d).not.toMatch(/secret|token|S3CRET|bot-token/i);
  });
});


const dangerous = (id: string, bits: number) => role(id, 3, { permissions: String(bits) });

describe('optional military-rank system', () => {
  const put = (c: Ctx, l: Login, b: unknown, g = G1) => mut(c, l, 'PUT', `/api/guilds/${g}/settings`, b);
  const mods = (ranks: boolean) => ({ government: true, party: false, unit: false, alliance: false, ranks });
  it('is OFF with no ranks for a new server; turning it ON creates the 17 starter ranks once; turning it off keeps the configuration', async () => {
    const { c, l } = await ctx();
    expect((await get(c, l, `/api/guilds/${G1}/settings`)).json()).toMatchObject({ settings: { modules: { ranks: false } } });
    expect(await ranksOf(c, l)).toEqual([]);
    expect((await put(c, l, { modules: mods(true) })).statusCode).toBe(200);
    const created = await ranksOf(c, l); expect(created).toHaveLength(17);
    await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: created.map((r) => (r.key === 'captain' ? { ...r, minDamage: 6_000_000 } : r)) });
    await put(c, l, { modules: mods(false) }); await put(c, l, { modules: mods(true) });                        // off, then on again
    expect((await ranksOf(c, l)).find((r) => r.key === 'captain')!.minDamage).toBe(6_000_000);               // edits survive; not re-seeded
    expect((await ranksOf(c, l, G2))).toEqual([]);                                                            // another server is untouched
  });
  it('alliance features cannot be switched on or mapped (no backing implementation), and the dashboard is told why', async () => {
    const { c, l } = await ctx();
    expect((await put(c, l, { modules: { government: true, party: false, unit: false, alliance: true, ranks: false } })).statusCode).toBe(422);
    for (const kind of ['alliance_member', 'alliance_leader']) {
      const r = await mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, { kind, discordRoleId: '900001' });
      expect(r.statusCode).toBe(422); expect(r.json()).toMatchObject({ error: 'feature_unavailable' });
    }
    expect(((await get(c, l, `/api/guilds/${G1}/mappings`)).json() as { mappings: unknown[] }).mappings).toEqual([]);
  });
  it('link mode and the unit-leader option are saved per server and validated', async () => {
    const { c, l } = await ctx();
    expect((await put(c, l, { linkMode: 'staff_approval', unitLeaderReplacesMember: true })).statusCode).toBe(200);
    expect((await get(c, l, `/api/guilds/${G1}/settings`)).json()).toMatchObject({ settings: { linkMode: 'staff_approval', requireStaffApproval: true, unitLeaderReplacesMember: true } });
    expect((await get(c, l, `/api/guilds/${G2}/settings`)).json()).toMatchObject({ settings: { linkMode: 'direct', unitLeaderReplacesMember: false } });
    for (const bad of [{ linkMode: 'anything' }, { linkMode: true }, { unitLeaderReplacesMember: 'yes' }]) expect((await put(c, l, bad)).statusCode, JSON.stringify(bad)).toBe(422);
  });
});

describe('role safety rules', () => {
  it('sensitive roles (Administrator / Manage Server / Manage Roles) cannot be used for mappings or ranks', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    c.bot.roles.set(G1, [...c.bot.roles.get(G1)!, dangerous('930001', 0x8), dangerous('930002', 0x20), dangerous('930003', 0x10000000)]);
    for (const id of ['930001', '930002', '930003']) {
      const m = await mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, { kind: 'president', discordRoleId: id }); expect(m.statusCode, id).toBe(422); expect(m.json()).toMatchObject({ error: 'role_invalid' });
      const r = await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.map((x, i) => (i === 0 ? { ...x, discordRoleId: id } : x)) }); expect(r.statusCode, id).toBe(422);
    }
    const listed = ((await get(c, l, `/api/guilds/${G1}/roles`)).json() as { roles: { id: string; manageable: boolean; reason: string }[] }).roles;
    expect(listed.find((x) => x.id === '930001')).toMatchObject({ manageable: false, reason: 'dangerous_permissions' });
  });
  it('a Discord role is either a rank role or a mapped role: both directions are refused with 409', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    expect((await mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, { kind: 'president', discordRoleId: '900001' })).statusCode).toBe(200);
    const r = await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.map((x, i) => (i === 0 ? { ...x, discordRoleId: '900001' } : x)) });
    expect(r.statusCode).toBe(409); expect(r.json()).toMatchObject({ error: 'role_conflict', roleIds: ['900001'] });
    await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.map((x, i) => (i === 0 ? { ...x, discordRoleId: '900002' } : x)) });
    const m = await mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, { kind: 'congress', discordRoleId: '900002' });
    expect(m.statusCode).toBe(409); expect(m.json()).toMatchObject({ error: 'role_conflict' });
  });
  it('ranks cannot be deleted while a synchronization is running (409), but other edits still work', async () => {
    const { c, l } = await ctx(); const ranks = (await seed(c, l)).ranks;
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status) VALUES ($1,'all','running')`, [G1]);
    const del = await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.filter((r) => r.key !== 'corporal') });
    expect(del.statusCode).toBe(409); expect(del.json()).toMatchObject({ error: 'sync_running' }); expect(await ranksOf(c, l)).toHaveLength(17);
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.map((r) => (r.key === 'captain' ? { ...r, minDamage: 6_000_000 } : r)) })).statusCode).toBe(200);
    await c.db.query(`UPDATE sync_jobs SET status='succeeded', finished_at=now()`);
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/ranks`, { ranks: ranks.filter((r) => r.key !== 'corporal') })).statusCode).toBe(200);
  });
});

describe('party / unit mappings and unlink', () => {
  it('party roles beyond the leader (treasurer, council) are mapped through the game\'s role value; the value is mandatory', async () => {
    const { c, l } = await ctx(); const post = (b: unknown) => mut(c, l, 'POST', `/api/guilds/${G1}/mappings`, b);
    const bad = await post({ kind: 'party_role', discordRoleId: '900001' }); expect(bad.statusCode).toBe(422); expect(bad.json()).toMatchObject({ error: 'game_ref_required' });
    expect((await post({ kind: 'party_role', gameRef: 'treasurer', discordRoleId: '900001' })).statusCode).toBe(200);
    expect((await post({ kind: 'party_role', gameRef: 'council', discordRoleId: '900002' })).statusCode).toBe(200);
    expect((await post({ kind: 'party_leader', discordRoleId: '910001' })).statusCode).toBe(200);
    const list = ((await get(c, l, `/api/guilds/${G1}/mappings`)).json() as { mappings: { kind: string; gameRef: string }[] }).mappings;
    expect(list.map((m) => [m.kind, m.gameRef]).sort()).toEqual([['party_leader', ''], ['party_role', 'council'], ['party_role', 'treasurer']]);
  });
  it('the sync status exposes the role values the game reported, so admins know what to map', async () => {
    const { c, l } = await ctx();
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status, finished_at, counts, details) VALUES ($1,'all','succeeded', now(), '{}'::jsonb, $2::jsonb)`, [G1, JSON.stringify({ seenRoles: { party: { leader: 1, treasurer: 2 }, unit: { commander: 1 }, governmentUnknown: ['ministerForeign'] } })]);
    const st = (await get(c, l, `/api/guilds/${G1}/sync/status`)).json() as { lastSuccess: { details: { seenRoles: { party: Record<string, number>; governmentUnknown: string[] } } } };
    expect(st.lastSuccess.details.seenRoles.party).toEqual({ leader: 1, treasurer: 2 }); expect(st.lastSuccess.details.seenRoles.governmentUnknown).toEqual(['ministerForeign']);
  });
  it('unlinking from the dashboard hands the roles the bot granted to the cleanup hook, and a failing hook does not undo the unlink', async () => {
    const { c, l } = await ctx();
    await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: 'One', direct: true });
    await c.db.query(`UPDATE account_links SET managed_role_ids=ARRAY['900001','900002'] WHERE guild_id=$1`, [G1]);
    const r = await mut(c, l, 'POST', `/api/guilds/${G1}/links/unlink`, { discordUserId: '555551' });
    expect(r.statusCode).toBe(200); expect(c.unlinked).toEqual([[G1, '555551', ['900001', '900002']]]);
    expect((await listLinks(c.db, G1, 'unlinked'))).toHaveLength(1);
  });
  it('the players list tells how each link was made (direct links are flagged as name-only)', async () => {
    const { c, l } = await ctx();
    await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: 'One', direct: true });
    const rows = ((await get(c, l, `/api/guilds/${G1}/links`)).json() as { links: { method: string }[] }).links;
    expect(rows[0]!.method).toBe('self_direct');
  });
});
