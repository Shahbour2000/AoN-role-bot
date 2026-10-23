import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Fetched } from '@aon/core';
import { ensureGuild, type Db } from '@aon/db';
import { freshDb } from '../../db/test/helpers.js';
import { DiscordAuthError, buildApp, pkceChallenge, type DiscordBotRest, type DiscordGuildInfo, type DiscordOAuth, type DiscordRole, type WebConfig, type WebDeps } from '../src/index.js';

export const BASE = 'https://dash.example.test';
export const cfgOf = (over: Partial<WebConfig> = {}): WebConfig => ({
  appBaseUrl: BASE, clientId: '111111111', clientSecret: 'client-secret-xyz', redirectUri: `${BASE}/auth/callback`, sessionSecret: 'a'.repeat(40) + 'S3CRET',
  botToken: 'bot-token-xyz', secureCookies: true, sessionTtlMs: 6 * 3_600_000, trustProxy: false, ...over,
});

export const ADMIN = String(0x8), MANAGE_GUILD = String(0x20), SEND_ONLY = String(0x800);
export const guildInfo = (id: string, permissions: string, owner = false): DiscordGuildInfo => ({ id, name: `Guild ${id}`, icon: null, owner, permissions });

export class FakeOAuth implements DiscordOAuth {
  challenges = new Map<string, string>();          // state -> code_challenge
  users = new Map<string, { id: string; username: string }>();   // code -> user
  guildsByUser = new Map<string, DiscordGuildInfo[]>();
  revoked = new Set<string>();                    // access tokens Discord rejects
  failExchange = false; guildFetches = 0;
  authorizeUrl({ state, challenge }: { state: string; challenge: string }) { this.challenges.set(state, challenge); return `https://discord.test/authorize?state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=identify+guilds`; }
  private verifiers = new Map<string, string>();
  async exchangeCode(code: string, verifier: string) {
    if (this.failExchange) throw new DiscordAuthError(400);
    const ok = [...this.challenges.values()].some((c) => c === pkceChallenge(verifier));      // PKCE must match a challenge we issued
    if (!ok || !this.users.has(code)) throw new DiscordAuthError(400);
    this.verifiers.set(code, verifier);
    return { accessToken: `tok_${code}` };
  }
  async fetchUser(token: string) { const u = this.users.get(token.replace('tok_', '')); if (!u) throw new DiscordAuthError(401); return { ...u, avatar: null }; }
  async fetchGuilds(token: string) {
    this.guildFetches++;
    if (this.revoked.has(token)) throw new DiscordAuthError(401);
    const u = this.users.get(token.replace('tok_', ''));
    return this.guildsByUser.get(u?.id ?? '') ?? [];
  }
}

export class FakeBotRest implements DiscordBotRest {
  roles = new Map<string, DiscordRole[]>();
  top = new Map<string, number>();
  down = false;
  async listRoles(g: string) { return this.down ? null : this.roles.get(g) ?? null; }
  async botTopRolePosition(g: string) { return this.down ? null : this.top.get(g) ?? 0; }
}
export const role = (id: string, position: number, over: Partial<DiscordRole> = {}): DiscordRole => ({ id, name: `role-${id}`, position, managed: false, color: 0, permissions: '0', ...over });

export interface Ctx { unlinked: [string, string, string[]][]; app: FastifyInstance; db: Db; oauth: FakeOAuth; bot: FakeBotRest; clock: { now: Date }; syncCalls: [string, string][]; logs: string[]; pub: string; game: FakeGameWeb }
export class FakeGameWeb {
  player: Fetched<{ id: string; username: string | null }> = { status: 'ok', data: { id: 'usr_p1', username: 'Alpha' } };
  parties: Fetched<never[]> = { status: 'ok', data: [] };
  async playerByName() { return this.player; }
  async countryParties() { return this.parties as never; }
  async countryUnits() { return this.parties as never; }
}

export async function makeApp(over: { cfg?: Partial<WebConfig>; guilds?: string[]; publicDir?: string } = {}): Promise<Ctx> {
  const db = await freshDb();
  for (const g of over.guilds ?? ['100000001', '100000002']) await ensureGuild(db, g, `Guild ${g}`);
  const oauth = new FakeOAuth(); const bot = new FakeBotRest(); const game = new FakeGameWeb();
  const clock = { now: new Date('2026-10-17T12:00:00Z') };
  const syncCalls: [string, string][] = []; const logs: string[] = []; const unlinked: [string, string, string[]][] = [];
  const pub = mkdtempSync(join(tmpdir(), 'aonpub-'));
  writeFileSync(join(pub, 'landing.html'), '<h1>landing</h1>'); writeFileSync(join(pub, 'app.html'), '<h1>app</h1>'); writeFileSync(join(pub, 'x.css'), 'body{}'); writeFileSync(join(pub, 'x.exe'), 'nope');
  const deps: WebDeps = { db, cfg: cfgOf(over.cfg), oauth, botRest: bot, game: game as never, runSync: async (g, a) => { syncCalls.push([g, a]); }, onUnlinked: async (g, u, roles) => { unlinked.push([g, u, roles]); }, now: () => clock.now, log: (m) => logs.push(m), publicDir: over.publicDir ?? pub };
  return { app: await buildApp(deps), db, oauth, bot, clock, syncCalls, logs, pub, game, unlinked };
}

export interface Login { cookies: Record<string, string>; csrf: string; headers: Record<string, string> }
export async function login(c: Ctx, userId: string, guilds: DiscordGuildInfo[], code = `code_${userId}`): Promise<Login> {
  c.oauth.users.set(code, { id: userId, username: `user${userId}` }); c.oauth.guildsByUser.set(userId, guilds);
  const r1 = await c.app.inject({ method: 'GET', url: '/auth/login' });
  const state = new URL(r1.headers['location'] as string).searchParams.get('state')!;
  const oc = r1.cookies.find((x) => x.name === 'aon_oauth')!.value;
  const r2 = await c.app.inject({ method: 'GET', url: `/auth/callback?code=${code}&state=${state}`, cookies: { aon_oauth: oc } });
  const sc = r2.cookies.find((x) => x.name === 'aon_session');
  if (!sc) throw new Error(`login failed: ${r2.headers['location']}`);
  const me = await c.app.inject({ method: 'GET', url: '/api/session', cookies: { aon_session: sc.value } });
  const csrf = (me.json() as { csrfToken: string }).csrfToken;
  return { cookies: { aon_session: sc.value }, csrf, headers: { origin: BASE, 'x-csrf-token': csrf } };
}
export const get = (c: Ctx, l: Login, url: string) => c.app.inject({ method: 'GET', url, cookies: l.cookies });
export const mut = (c: Ctx, l: Login, method: 'POST' | 'PUT' | 'DELETE', url: string, body: unknown = {}) =>
  c.app.inject({ method, url, cookies: l.cookies, headers: l.headers, ...(method === 'DELETE' ? {} : { payload: body as object }) });
