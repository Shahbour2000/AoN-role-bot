import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Fetched, PanelMessage } from '@aon/core';
import { PanelPublishError, type PanelPublisher } from '@aon/sync';
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
  channels = new Map<string, { id: string; name: string; type: number; position: number }[]>();
  async listChannels(g: string) { return this.down ? null : this.channels.get(g) ?? []; }
  async listRoles(g: string) { return this.down ? null : this.roles.get(g) ?? null; }
  async botTopRolePosition(g: string) { return this.down ? null : this.top.get(g) ?? 0; }
}
export const role = (id: string, position: number, over: Partial<DiscordRole> = {}): DiscordRole => ({ id, name: `role-${id}`, position, managed: false, color: 0, permissions: '0', ...over });

/** Fake Discord side of the panel: remembers messages per channel and lets a test inject failures. Never touches the network. */
export class FakePanelPublisher implements PanelPublisher {
  n = 0; messages = new Map<string, { guildId: string; channelId: string; message: PanelMessage }>(); calls: string[] = [];
  failWith: PanelPublishError | null = null; gate: Promise<void> | null = null;
  async post(guildId: string, channelId: string, message: PanelMessage) { this.calls.push(`post:${guildId}:${channelId}`); if (this.gate) await this.gate; if (this.failWith) throw this.failWith; const id = `9000${++this.n}`; this.messages.set(id, { guildId, channelId, message }); return { messageId: id }; }
  async edit(guildId: string, channelId: string, id: string, message: PanelMessage) { this.calls.push(`edit:${id}`); if (this.failWith) throw this.failWith; const m = this.messages.get(id); if (!m || m.channelId !== channelId || m.guildId !== guildId) return false; m.message = message; return true; }
  async remove(_g: string, _c: string, id: string) { this.calls.push(`remove:${id}`); this.messages.delete(id); }
}
export interface Ctx { panel: FakePanelPublisher; unlinked: [string, string, string[]][]; app: FastifyInstance; db: Db; oauth: FakeOAuth; bot: FakeBotRest; clock: { now: Date }; syncCalls: [string, string][]; logs: string[]; pub: string; game: FakeGameWeb }
export class FakeGameWeb {
  player: Fetched<{ id: string; username: string | null }> = { status: 'ok', data: { id: 'usr_p1', username: 'Alpha' } };
  parties: Fetched<never[]> = { status: 'ok', data: [] };
  /** Phase 3 selectors. `calls` records every upstream request so tests can prove caching. */
  calls: string[] = [];
  countriesRes: Fetched<{ id: string; name: string }[]> | undefined = { status: 'ok', data: [{ id: 'pl', name: 'Poland' }, { id: 'eg', name: 'Egypt' }, { id: 'de', name: 'Germany' }, { id: 'ee', name: 'Estonia' }] };
  unitsList: Fetched<unknown[]> | null = null;
  searchRes: Fetched<unknown[]> = { status: 'ok', data: [] };
  names: Record<string, Fetched<string>> = {};
  async playerByName() { return this.player; }
  async countryParties(id?: string) { this.calls.push(`parties:${id}`); return this.parties as never; }
  async countryUnits(id?: string) { this.calls.push(`units:${id}`); return (this.unitsList ?? this.parties) as never; }
  async countryOptions() { this.calls.push('countries'); return this.countriesRes as never; }
  async searchUnits(q: string, cid?: string) { this.calls.push(`search:${q}:${cid ?? ''}`); return this.searchRes as never; }
  async entityName(t: string, id: string) { this.calls.push(`name:${t}:${id}`); return this.names[`${t}:${id}`] ?? ({ status: 'incomplete', missing: ['name'] } as never); }
}

export async function makeApp(over: { cfg?: Partial<WebConfig>; guilds?: string[]; publicDir?: string; noPanelPublisher?: boolean } = {}): Promise<Ctx> {
  const db = await freshDb();
  for (const g of over.guilds ?? ['100000001', '100000002']) await ensureGuild(db, g, `Guild ${g}`);
  const oauth = new FakeOAuth(); const bot = new FakeBotRest(); const game = new FakeGameWeb(); const panel = new FakePanelPublisher();
  const clock = { now: new Date('2026-10-17T12:00:00Z') };
  const syncCalls: [string, string][] = []; const logs: string[] = []; const unlinked: [string, string, string[]][] = [];
  const pub = mkdtempSync(join(tmpdir(), 'aonpub-'));
  writeFileSync(join(pub, 'landing.html'), '<h1>landing</h1>'); writeFileSync(join(pub, 'app.html'), '<h1>app</h1>'); writeFileSync(join(pub, 'x.css'), 'body{}'); writeFileSync(join(pub, 'x.exe'), 'nope');
  const deps: WebDeps = { db, cfg: cfgOf(over.cfg), oauth, botRest: bot, ...(over.noPanelPublisher ? {} : { panelPublisher: panel }), game: game as never, runSync: async (g, a) => { syncCalls.push([g, a]); }, onUnlinked: async (g, u, roles) => { unlinked.push([g, u, roles]); }, now: () => clock.now, log: (m) => logs.push(m), publicDir: over.publicDir ?? pub };
  return { panel, app: await buildApp(deps), db, oauth, bot, clock, syncCalls, logs, pub, game, unlinked };
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
