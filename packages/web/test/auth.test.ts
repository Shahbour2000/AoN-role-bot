import { describe, expect, it } from 'vitest';
import { loadWebConfig, canManageGuild, roleManageability, seal, open, safeEqual } from '../src/index.js';
import { ADMIN, BASE, MANAGE_GUILD, SEND_ONLY, get, guildInfo, login, makeApp, mut, role } from './harness.js';

const G1 = '100000001', G2 = '100000002', G3 = '100000003';

describe('OAuth2 login flow', () => {
  it('redirects to Discord with state + PKCE(S256) and scope identify guilds; the state cookie is HttpOnly + SameSite=Lax + Secure', async () => {
    const c = await makeApp();
    const r = await c.app.inject({ method: 'GET', url: '/auth/login' });
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers['location'] as string);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256'); expect(u.searchParams.get('state')!.length).toBeGreaterThan(20); expect(u.searchParams.get('scope')).toBe('identify guilds');
    const ck = r.cookies.find((x) => x.name === 'aon_oauth')!;
    expect(ck).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth' });
    expect(ck.value).not.toContain(u.searchParams.get('state')!);          // sealed, not readable
  });
  it('rejects a wrong state, a missing state cookie, and an expired state — and creates NO session', async () => {
    const c = await makeApp(); c.oauth.users.set('c1', { id: '1', username: 'u' });
    const r1 = await c.app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(r1.headers['location'] as string).searchParams.get('state')!;
    const oc = r1.cookies.find((x) => x.name === 'aon_oauth')!.value;
    for (const [url, cookies] of [[`/auth/callback?code=c1&state=WRONG`, { aon_oauth: oc }], [`/auth/callback?code=c1&state=${state}`, {}], ['/auth/callback?state=x', { aon_oauth: oc }]] as const) {
      const r = await c.app.inject({ method: 'GET', url, cookies: { ...cookies } });
      expect(r.headers['location']).toBe('/?error=login_failed'); expect(r.cookies.find((x) => x.name === 'aon_session')).toBeUndefined();
    }
    c.clock.now = new Date(c.clock.now.getTime() + 11 * 60_000);       // state older than 10 minutes
    const late = await c.app.inject({ method: 'GET', url: `/auth/callback?code=c1&state=${state}`, cookies: { aon_oauth: oc } });
    expect(late.headers['location']).toBe('/?error=login_failed');
    expect((await c.db.query('SELECT 1 FROM dashboard_sessions')).rows).toHaveLength(0);
  });
  it('a tampered state cookie is rejected', async () => {
    const c = await makeApp(); c.oauth.users.set('c1', { id: '1', username: 'u' });
    const r1 = await c.app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(r1.headers['location'] as string).searchParams.get('state')!;
    const oc = r1.cookies.find((x) => x.name === 'aon_oauth')!.value;
    const r = await c.app.inject({ method: 'GET', url: `/auth/callback?code=c1&state=${state}`, cookies: { aon_oauth: oc.slice(0, -4) + 'AAAA' } });
    expect(r.headers['location']).toBe('/?error=login_failed');
  });
  it('success: sets HttpOnly/Secure/SameSite=Lax session cookie; the DB stores only a hash and a sealed token', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
    const rows = (await c.db.query<{ token_hash: string; access_token_enc: string; discord_user_id: string }>('SELECT * FROM dashboard_sessions')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(l.cookies['aon_session']); expect(rows[0]!.access_token_enc).not.toContain('tok_code_42');
    const r1 = await c.app.inject({ method: 'GET', url: '/auth/login' });       // fresh login only to inspect cookie flags
    const st = new URL(r1.headers['location'] as string).searchParams.get('state')!;
    const r2 = await c.app.inject({ method: 'GET', url: `/auth/callback?code=code_42&state=${st}`, cookies: { aon_oauth: r1.cookies.find((x) => x.name === 'aon_oauth')!.value } });
    expect(r2.headers['location']).toBe('/app');
    expect(r2.cookies.find((x) => x.name === 'aon_session')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  });
  it('every login issues a brand-new session token (no fixation) and a replayed state is useless', async () => {
    const c = await makeApp(); const a = await login(c, '42', [], 'k1'); const b = await login(c, '42', [], 'k2');
    expect(a.cookies['aon_session']).not.toBe(b.cookies['aon_session']);
    const r1 = await c.app.inject({ method: 'GET', url: '/auth/login' });
    const st = new URL(r1.headers['location'] as string).searchParams.get('state')!; const oc = r1.cookies.find((x) => x.name === 'aon_oauth')!.value;
    c.oauth.users.set('k3', { id: '42', username: 'u' });
    await c.app.inject({ method: 'GET', url: `/auth/callback?code=k3&state=${st}`, cookies: { aon_oauth: oc } });
    const replay = await c.app.inject({ method: 'GET', url: `/auth/callback?code=k3&state=${st}`, cookies: {} });  // browser dropped the cleared cookie
    expect(replay.headers['location']).toBe('/?error=login_failed');
  });
  it('a failed code exchange bounces without a session, and secrets never reach the logs', async () => {
    const c = await makeApp(); c.oauth.failExchange = true; c.oauth.users.set('c1', { id: '1', username: 'u' });
    const r1 = await c.app.inject({ method: 'GET', url: '/auth/login' });
    const st = new URL(r1.headers['location'] as string).searchParams.get('state')!;
    const r = await c.app.inject({ method: 'GET', url: `/auth/callback?code=c1&state=${st}`, cookies: { aon_oauth: r1.cookies.find((x) => x.name === 'aon_oauth')!.value } });
    expect(r.headers['location']).toBe('/?error=login_failed');
    const all = c.logs.join(' '); expect(all).not.toMatch(/c1|tok_|client-secret|bot-token/);
  });
  it('rate-limits the auth endpoints', async () => {
    const c = await makeApp(); let last = 0;
    for (let i = 0; i < 25; i++) last = (await c.app.inject({ method: 'GET', url: '/auth/login' })).statusCode;
    expect(last).toBe(429);
  });
});

describe('sessions', () => {
  it('no cookie / garbage cookie / expired session => 401', async () => {
    const c = await makeApp(); const l = await login(c, '42', []);
    expect((await c.app.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'GET', url: '/api/session', cookies: { aon_session: 'x'.repeat(40) } })).statusCode).toBe(401);
    expect((await get(c, l, '/api/session')).statusCode).toBe(200);
    c.clock.now = new Date(c.clock.now.getTime() + 7 * 3_600_000);
    expect((await get(c, l, '/api/session')).statusCode).toBe(401);
  });
  it('logout needs CSRF, then really invalidates the session', async () => {
    const c = await makeApp(); const l = await login(c, '42', []);
    expect((await c.app.inject({ method: 'POST', url: '/auth/logout', cookies: l.cookies, payload: {} })).statusCode).toBe(403);
    expect((await mut(c, l, 'POST', '/auth/logout')).statusCode).toBe(200);
    expect((await get(c, l, '/api/session')).statusCode).toBe(401);
  });
});

describe('guild authorization (live, server-side)', () => {
  it('lists ONLY guilds the user can manage (owner / Administrator / Manage Server), with install state + invite link', async () => {
    const c = await makeApp();
    const l = await login(c, '42', [guildInfo(G1, ADMIN), guildInfo(G2, SEND_ONLY), guildInfo(G3, '0', true), guildInfo('100000009', MANAGE_GUILD)]);
    const j = (await get(c, l, '/api/guilds')).json() as { guilds: { id: string; installed: boolean; inviteUrl?: string }[] };
    expect(j.guilds.map((g) => g.id).sort()).toEqual([G1, G3, '100000009'].sort());
    expect(j.guilds.find((g) => g.id === G1)!.installed).toBe(true);
    const un = j.guilds.find((g) => g.id === '100000009')!; expect(un.installed).toBe(false); expect(un.inviteUrl).toContain('permissions=268435456');
    expect(un.inviteUrl).not.toContain('permissions=8');                       // never requests Administrator
  });
  it('403 for a guild the user cannot manage, and the SAME 403 for a guild that does not exist (no existence leak)', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN), guildInfo(G2, SEND_ONLY)]);
    const a = await get(c, l, `/api/guilds/${G2}/settings`); const b = await get(c, l, '/api/guilds/999999999/settings');
    expect([a.statusCode, b.statusCode]).toEqual([403, 403]); expect(a.body).toBe(b.body);
  });
  it('manageable but bot not installed => 404; malformed guild id => 400; unauthenticated => 401', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo('100000009', ADMIN)]);
    expect((await get(c, l, '/api/guilds/100000009/settings')).statusCode).toBe(404);
    expect((await get(c, l, '/api/guilds/1%20OR%201=1/settings')).statusCode).toBe(400);
    expect((await c.app.inject({ method: 'GET', url: `/api/guilds/${G1}/settings` })).statusCode).toBe(401);
  });
  it('permissions are re-read from Discord: revoked rights stop working once the short cache expires', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
    expect((await get(c, l, `/api/guilds/${G1}/settings`)).statusCode).toBe(200);
    c.oauth.guildsByUser.set('42', [guildInfo(G1, SEND_ONLY)]);               // demoted in Discord
    expect((await get(c, l, `/api/guilds/${G1}/settings`)).statusCode).toBe(200);   // within the 30 s cache window
    c.clock.now = new Date(c.clock.now.getTime() + 31_000);
    expect((await get(c, l, `/api/guilds/${G1}/settings`)).statusCode).toBe(403);
  });
  it('a revoked Discord token ends the session (401) and deletes it', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
    c.oauth.revoked.add('tok_code_42'); c.clock.now = new Date(c.clock.now.getTime() + 31_000);
    expect((await get(c, l, `/api/guilds/${G1}/settings`)).statusCode).toBe(401);
    expect((await c.db.query('SELECT 1 FROM dashboard_sessions')).rows).toHaveLength(0);
  });
  it('a client-supplied guild id in the body/query never widens access', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
    const r = await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { guildId: G2, language: 'en' });
    expect(r.statusCode).toBe(422);                                              // unknown keys rejected (strict schema)
  });
});

describe('CSRF protection', () => {
  it('mutations need BOTH a same-origin Origin header and the session CSRF token', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]); const url = `/api/guilds/${G1}/settings`; const body = { language: 'en' };
    const send = (headers: Record<string, string>) => c.app.inject({ method: 'PUT', url, cookies: l.cookies, headers, payload: body });
    expect((await send({})).statusCode).toBe(403);
    expect((await send({ origin: BASE })).statusCode).toBe(403);
    expect((await send({ 'x-csrf-token': l.csrf })).statusCode).toBe(403);
    expect((await send({ origin: 'https://evil.example', 'x-csrf-token': l.csrf })).statusCode).toBe(403);
    expect((await send({ origin: BASE, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await send({ origin: BASE, 'x-csrf-token': l.csrf })).statusCode).toBe(200);
  });
  it('another user\'s CSRF token does not work', async () => {
    const c = await makeApp(); const a = await login(c, '42', [guildInfo(G1, ADMIN)]); const b = await login(c, '43', [guildInfo(G1, ADMIN)]);
    const r = await c.app.inject({ method: 'PUT', url: `/api/guilds/${G1}/settings`, cookies: a.cookies, headers: { origin: BASE, 'x-csrf-token': b.csrf }, payload: { language: 'en' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('response hardening', () => {
  it('sets CSP / nosniff / frame protections / HSTS and no-store on API responses', async () => {
    const c = await makeApp(); const r = await c.app.inject({ method: 'GET', url: '/api/session' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'"); expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['strict-transport-security']).toBeTruthy();
  });
  it('serves the landing page and static assets, refuses traversal and unknown file types', async () => {
    const c = await makeApp();
    expect((await c.app.inject({ method: 'GET', url: '/' })).body).toContain('landing');
    expect((await c.app.inject({ method: 'GET', url: '/app' })).body).toContain('app');
    const css = await c.app.inject({ method: 'GET', url: '/static/x.css' }); expect(css.statusCode).toBe(200); expect(css.headers['content-type']).toContain('text/css');
    for (const u of ['/static/..%2F..%2Fetc%2Fpasswd', '/static/../../etc/passwd', '/static/x.exe', '/static/missing.css']) expect([400, 404]).toContain((await c.app.inject({ method: 'GET', url: u })).statusCode);
  });
  it('internal errors never leak details', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
    const r = await c.app.inject({ method: 'PUT', url: `/api/guilds/${G1}/settings`, cookies: l.cookies, headers: { ...l.headers, 'content-type': 'application/json' }, payload: '{not json' });
    expect(r.statusCode).toBe(400); expect(r.body).not.toMatch(/Unexpected|SyntaxError|node_modules/);
  });
});

describe('config / crypto / permission helpers', () => {
  it('loadWebConfig lists every problem and never echoes secrets', () => {
    expect(() => loadWebConfig({})).toThrow(/APP_BASE_URL is required[\s\S]*SESSION_SECRET is required/);
    let msg = ''; try { loadWebConfig({ APP_BASE_URL: 'http://prod.example.com', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'SUPERSECRETVALUE', SESSION_SECRET: 'short', DISCORD_BOT_TOKEN: 'BOTTOKENVALUE' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/must be https/); expect(msg).toMatch(/at least 32/); expect(msg).not.toMatch(/SUPERSECRETVALUE|BOTTOKENVALUE/);
    const ok = loadWebConfig({ APP_BASE_URL: 'https://dash.example.com/', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'x'.repeat(32), DISCORD_BOT_TOKEN: 't' });
    expect(ok).toMatchObject({ appBaseUrl: 'https://dash.example.com', redirectUri: 'https://dash.example.com/auth/callback', secureCookies: true });
    expect(loadWebConfig({ APP_BASE_URL: 'http://localhost:3000', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'x'.repeat(32), DISCORD_BOT_TOKEN: 't' }).secureCookies).toBe(false);
  });
  it('seal/open round-trips, and rejects tampering and a different key', () => {
    const s = seal('k'.repeat(32), 'hello'); expect(open('k'.repeat(32), s)).toBe('hello');
    expect(open('k'.repeat(32), s.slice(0, -2) + 'AA')).toBeNull(); expect(open('z'.repeat(32), s)).toBeNull(); expect(open('k'.repeat(32), 'short')).toBeNull();
    expect(safeEqual('abc', 'abc')).toBe(true); expect(safeEqual('abc', 'abd')).toBe(false); expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('canManageGuild / roleManageability', () => {
    expect(canManageGuild({ owner: false, permissions: ADMIN })).toBe(true); expect(canManageGuild({ owner: false, permissions: MANAGE_GUILD })).toBe(true);
    expect(canManageGuild({ owner: true, permissions: '0' })).toBe(true); expect(canManageGuild({ owner: false, permissions: SEND_ONLY })).toBe(false); expect(canManageGuild({ owner: false, permissions: 'garbage' })).toBe(false);
    expect(roleManageability(G1, role('5', 1), 10)).toEqual({ manageable: true, reason: null });
    expect(roleManageability(G1, role('5', 10), 10).reason).toBe('above_bot_role');
    expect(roleManageability(G1, role(G1, 0), 10).reason).toBe('everyone_role');
    expect(roleManageability(G1, role('5', 1, { managed: true }), 10).reason).toBe('integration_managed');
    expect(roleManageability(G1, role('5', 1, { permissions: ADMIN }), 10).reason).toBe('dangerous_permissions');
    expect(roleManageability(G1, role('5', 1), null).reason).toBe('bot_position_unknown');
  });
});
