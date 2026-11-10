import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MODULES_BY_TYPE, ENTITY_BY_TYPE, allowedKinds, allowedModules, disallowedEnabledModules, isKindAllowed, type Fetched } from '@aon/core';
import { partyOptions, unitOptions, type EntityOption, type PartySummary, type PlayerIdentity, type UnitSummary } from '@aon/client';
import {
  ROLE_KINDS, BUILD_ROLE_KEYS, CountryReservedError, IncompatibleMappingsError, getCountryReservation, isCountryReservedByOther, releaseCountry, addRoleMapping, getBuildRoles, isBuildKind, setBuildRoles, unlinkWithRoles, cancelSyncJob, countLinksByStatus, createSessionRow, deleteSessionRow, forceLink, getGuildConfig, getLadder, getSessionRow, guildExists,
  getSyncStatus, listAudit, listLinksDetailed, listRoleMappings, listSyncJobs, removeRoleMapping, reviewLink, saveLadder, updateGuildSettings, DEFAULT_LADDER_SEED, type Db,
} from '@aon/db';
import type { WebConfig } from './config.js';
import { open, pkceChallenge, randomToken, safeEqual, seal, sha256 } from './crypto.js';
import { DiscordAuthError, type DiscordBotRest, type DiscordGuildInfo, type DiscordOAuth } from './discord.js';
import { canManageGuild, roleManageability } from './permissions.js';

export interface WebGame {
  playerByName(u: string): Promise<Fetched<PlayerIdentity>>;
  countryParties(id: string): Promise<Fetched<PartySummary[]>>;
  countryUnits(id: string): Promise<Fetched<UnitSummary[]>>;
  /** Optional capabilities for the setup selectors. Missing => the selector reports `game_unavailable` and the dashboard keeps its manual fallback. */
  countryOptions?(): Promise<Fetched<EntityOption[]>>;
  searchUnits?(search: string, countryId?: string): Promise<Fetched<UnitSummary[]>>;
  entityName?(type: 'party' | 'unit', id: string): Promise<Fetched<string>>;
}
export interface WebDeps {
  db: Db; cfg: WebConfig; oauth: DiscordOAuth; botRest: DiscordBotRest; game: WebGame;
  /** Starts a full sync (same code path as /sync all). */
  runSync(guildId: string, actorId: string): Promise<unknown>;
  /** Called after a member was unlinked from the dashboard: take the roles the bot had granted off them (best effort). */
  onUnlinked?(guildId: string, discordUserId: string, roleIds: string[]): Promise<void>;
  health?(): Promise<{ database: boolean; discord: boolean; gameApi: Record<string, number | null> | null }>;
  now?: () => Date; log?: (m: string) => void; publicDir?: string;
}

const SESSION_COOKIE = 'aon_session';
const OAUTH_COOKIE = 'aon_oauth';
const SNOWFLAKE = /^\d{5,25}$/;
const GAME_ID = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json' };

function limiter(max: number, windowMs: number, now: () => number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const t = now(); const h = hits.get(key);
    if (!h || h.reset <= t) { hits.set(key, { n: 1, reset: t + windowMs }); if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); return true; }
    return ++h.n <= max;
  };
}

export async function buildApp(deps: WebDeps): Promise<FastifyInstance> {
  const { db, cfg } = deps;
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const authLimit = limiter(20, 60_000, () => clock().getTime());
  const writeLimit = limiter(90, 60_000, () => clock().getTime());
  const guildCache = new Map<string, { at: number; guilds: DiscordGuildInfo[] }>();
  const origin = cfg.appBaseUrl;

  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy, bodyLimit: 256 * 1024 });
  await app.register(fastifyCookie);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (cfg.secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api') || req.url.startsWith('/auth')) reply.header('cache-control', 'no-store');
  });

  const cookieOpts = (maxAgeSec: number, path = '/') => ({ httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax' as const, path, maxAge: maxAgeSec });
  const fail = (reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) => reply.code(status).send({ error, ...extra });

  // ------------------------------------------------------------------ sessions
  async function currentSession(req: FastifyRequest) {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw || raw.length > 100) return null;
    return getSessionRow(db, sha256(raw), clock());
  }
  type Session = NonNullable<Awaited<ReturnType<typeof currentSession>>>;

  /** Mutations need: same-origin Origin header AND a matching CSRF token bound to the session. */
  function csrfOk(req: FastifyRequest, s: Session): boolean {
    const o = req.headers['origin'];
    if (typeof o !== 'string' || o !== origin) return false;
    const t = req.headers['x-csrf-token'];
    return typeof t === 'string' && safeEqual(t, s.csrfToken);
  }

  async function liveGuilds(s: Session): Promise<DiscordGuildInfo[] | null> {
    const hit = guildCache.get(s.tokenHash);
    if (hit && clock().getTime() - hit.at < 30_000) return hit.guilds;   // short cache only; permissions are re-read from Discord, never trusted from the client
    const token = open(cfg.sessionSecret, s.accessTokenEnc);
    if (!token) return null;
    try {
      const guilds = await deps.oauth.fetchGuilds(token);
      guildCache.set(s.tokenHash, { at: clock().getTime(), guilds });
      return guilds;
    } catch (e) {
      if (e instanceof DiscordAuthError) { await deleteSessionRow(db, s.tokenHash); guildCache.delete(s.tokenHash); return null; }   // token revoked/expired => end session
      throw e;
    }
  }

  /** The single authorization gate for every /api/guilds/:guildId/* route. Replies and returns null on failure. */
  async function guard(req: FastifyRequest, reply: FastifyReply, opts: { write?: boolean } = {}) {
    const guildId = (req.params as { guildId?: string }).guildId ?? '';
    if (!SNOWFLAKE.test(guildId)) { await fail(reply, 400, 'invalid_guild_id'); return null; }
    const s = await currentSession(req);
    if (!s) { await fail(reply, 401, 'unauthenticated'); return null; }
    if (opts.write) {
      if (!csrfOk(req, s)) { await fail(reply, 403, 'csrf'); return null; }
      if (!writeLimit(`w:${s.tokenHash}`)) { await fail(reply, 429, 'rate_limited'); return null; }
    }
    let guilds: DiscordGuildInfo[] | null;
    try { guilds = await liveGuilds(s); } catch { await fail(reply, 503, 'discord_unavailable'); return null; }
    if (!guilds) { await fail(reply, 401, 'unauthenticated'); return null; }
    const g = guilds.find((x) => x.id === guildId);
    if (!g || !canManageGuild(g)) { await fail(reply, 403, 'forbidden'); return null; }         // same answer whether or not the guild exists
    if (!(await guildExists(db, guildId))) { await fail(reply, 404, 'bot_not_installed'); return null; }
    return { session: s, guildId, guild: g };
  }

  // ------------------------------------------------------------------ auth
  app.get('/auth/login', async (req, reply) => {
    if (!authLimit(`a:${req.ip}`)) return fail(reply, 429, 'rate_limited');
    const state = randomToken(24), verifier = randomToken(48);
    reply.setCookie(OAUTH_COOKIE, seal(cfg.sessionSecret, JSON.stringify({ state, verifier, exp: clock().getTime() + 600_000 })), cookieOpts(600, '/auth'));
    return reply.redirect(deps.oauth.authorizeUrl({ state, challenge: pkceChallenge(verifier) }), 302);
  });

  app.get('/auth/callback', async (req, reply) => {
    if (!authLimit(`a:${req.ip}`)) return fail(reply, 429, 'rate_limited');
    const q = req.query as { code?: unknown; state?: unknown; error?: unknown };
    const sealed = req.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: '/auth' });
    const bounce = (why: string) => { log(`oauth callback rejected: ${why}`); return reply.redirect('/?error=login_failed', 302); };
    if (typeof q.error === 'string') return bounce('user_denied');
    if (typeof q.code !== 'string' || typeof q.state !== 'string' || !sealed || q.code.length > 512 || q.state.length > 200) return bounce('missing_params');
    const saved = (() => { try { return JSON.parse(open(cfg.sessionSecret, sealed) ?? 'null') as { state: string; verifier: string; exp: number } | null; } catch { return null; } })();
    if (!saved || saved.exp < clock().getTime() || !safeEqual(saved.state, q.state)) return bounce('state_mismatch');     // CSRF on the login flow
    try {
      const { accessToken } = await deps.oauth.exchangeCode(q.code, saved.verifier);
      const user = await deps.oauth.fetchUser(accessToken);
      const token = randomToken(32);                                                    // fresh token every login (no session fixation)
      await createSessionRow(db, { tokenHash: sha256(token), discordUserId: user.id, username: user.username.slice(0, 80), avatar: user.avatar, accessTokenEnc: seal(cfg.sessionSecret, accessToken), csrfToken: randomToken(24), ttlMs: cfg.sessionTtlMs, now: clock() });
      reply.setCookie(SESSION_COOKIE, token, cookieOpts(Math.floor(cfg.sessionTtlMs / 1000)));
      return reply.redirect('/app', 302);
    } catch (e) { return bounce(e instanceof Error ? e.message.slice(0, 60) : 'exchange_failed'); }   // never logs tokens or codes
  });

  app.post('/auth/logout', async (req, reply) => {
    const s = await currentSession(req);
    if (s) { if (!csrfOk(req, s)) return fail(reply, 403, 'csrf'); await deleteSessionRow(db, s.tokenHash); guildCache.delete(s.tokenHash); }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/session', async (req, reply) => {
    const s = await currentSession(req);
    if (!s) return fail(reply, 401, 'unauthenticated');
    return { user: { id: s.discordUserId, username: s.username, avatar: s.avatar }, csrfToken: s.csrfToken };
  });

  app.get('/api/guilds', async (req, reply) => {
    const s = await currentSession(req);
    if (!s) return fail(reply, 401, 'unauthenticated');
    let guilds: DiscordGuildInfo[] | null;
    try { guilds = await liveGuilds(s); } catch { return fail(reply, 503, 'discord_unavailable'); }
    if (!guilds) return fail(reply, 401, 'unauthenticated');
    const manageable = guilds.filter(canManageGuild);       // ONLY guilds the user may manage are ever returned
    const out = [];
    for (const g of manageable) {
      const installed = await guildExists(db, g.id);
      out.push({ id: g.id, name: g.name, icon: g.icon, installed, ...(installed ? {} : { inviteUrl: `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: cfg.clientId, scope: 'bot applications.commands', permissions: String(0x10000000), guild_id: g.id, disable_guild_select: 'true' })}` }) });
    }
    return { guilds: out };
  });

  // ------------------------------------------------------------------ overview / diagnostics
  app.get('/api/guilds/:guildId/overview', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const [cfgG, counts, jobs, audit, ladder, mappings] = await Promise.all([getGuildConfig(db, a.guildId), countLinksByStatus(db, a.guildId), listSyncJobs(db, a.guildId, 5), listAudit(db, a.guildId, { limit: 10 }), getLadder(db, a.guildId), listRoleMappings(db, a.guildId)]);
    const warnings: string[] = [];
    if (cfgG && !cfgG.countryId && mappings.some((m) => !m.kind.startsWith('party') && !m.kind.startsWith('unit') && !m.kind.startsWith('alliance'))) warnings.push('country_not_set');
    if (cfgG?.modules.ranks && ladder.some((r) => r.enabled && !r.discordRoleId)) warnings.push('rank_roles_unmapped');
    if (!mappings.length && !ladder.some((r) => r.discordRoleId)) warnings.push('nothing_configured');
    if ((counts['pending'] ?? 0) > 0) warnings.push('pending_requests');
    const builds = await getBuildRoles(db, a.guildId);
    return { settings: cfgG && { ...cfgG, syncIntervalHours: cfgG.syncIntervalMinutes / 60 }, links: { active: (counts['verified'] ?? 0) + (counts['admin_linked'] ?? 0), pending: counts['pending'] ?? 0 }, lastJob: jobs[0] ?? null, recentJobs: jobs, recentAudit: audit, warnings, modules: cfgG?.modules ?? null, builds: { configured: BUILD_ROLE_KEYS.filter((k) => builds[k]).length, total: BUILD_ROLE_KEYS.length }, mappingsCount: mappings.filter((m) => !isBuildKind(m.kind)).length };
  });

  app.get('/api/guilds/:guildId/diagnostics', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const h = deps.health ? await deps.health() : null;
    return { database: h?.database ?? true, discord: h?.discord ?? null, gameApi: h?.gameApi ?? null };     // no secrets, no tokens
  });

  // ------------------------------------------------------------------ settings
  /** Settings as the dashboard sees them: interval in hours plus the next scheduled run. */
  const settingsView = async (guildId: string) => {
    const c = await getGuildConfig(db, guildId); if (!c) return c;
    // Reservation status for the dashboard. It never reveals WHICH other server holds a country, only that one does.
    let countryReservation: 'none' | 'held' | 'held_by_other' = 'none';
    if (c.communityType === 'country' && c.countryId) countryReservation = (await getCountryReservation(db, guildId)) ? 'held' : (await isCountryReservedByOther(db, guildId, c.countryId)) ? 'held_by_other' : 'none';
    return { ...c, syncIntervalHours: c.syncIntervalMinutes / 60, countryReservation, allowedKinds: allowedKinds(c.communityType), allowedModules: allowedModules(c.communityType),
      typeRules: Object.fromEntries(Object.entries(MODULES_BY_TYPE).map(([t, m]) => [t, { modules: m, entity: ENTITY_BY_TYPE[t as keyof typeof ENTITY_BY_TYPE] }])) };
  };
  const idOrNull = GAME_ID.nullable();
  const SettingsBody = z.object({
    language: z.enum(['ar', 'en']), communityType: z.enum(['country', 'party', 'military_unit', 'general']),          // alliance servers are not configurable (no verified data)
    countryId: idOrNull, partyId: idOrNull, unitId: idOrNull, allianceId: idOrNull,
    // `alliance` can only be false: alliance roles have no backing implementation yet (the game API data is not available), so the dashboard must not offer it.
    modules: z.object({ government: z.boolean(), party: z.boolean(), unit: z.boolean(), alliance: z.literal(false), ranks: z.boolean() }).strict(),
    linkMode: z.enum(['direct', 'staff_approval']), unitLeaderReplacesMember: z.boolean(),
    demotionMode: z.enum(['never', 'immediate', 'grace']), demotionGraceDays: z.number().int().min(1).max(365),
    /** Must be true to apply a server-type change that makes existing role mappings inapplicable (they are then removed). */
    confirmRemoveIncompatible: z.boolean(),
    autoSyncEnabled: z.boolean(), syncIntervalHours: z.union([z.literal(3), z.literal(6), z.literal(12), z.literal(24)]),
  }).partial().strict();

  app.get('/api/guilds/:guildId/settings', async (req, reply) => { const a = await guard(req, reply); if (!a) return; return { settings: await settingsView(a.guildId) }; });
  app.put('/api/guilds/:guildId/settings', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const p = SettingsBody.safeParse(req.body);
    if (!p.success) return fail(reply, 422, 'validation', { issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const b = p.data;
    const cur = await getGuildConfig(db, a.guildId); if (!cur) return fail(reply, 404, 'bot_not_installed');
    const newType = b.communityType ?? cur.communityType;
    // A country server gives its country up ONLY through the explicit release action (DELETE .../country), never by saving an empty field.
    if (b.countryId === null && newType === 'country' && cur.communityType === 'country' && cur.countryId) return fail(reply, 422, 'use_release_endpoint');
    // Modules the chosen type does not offer are switched off, and the response says which ones (never dropped silently).
    const coercedModules = b.modules ? disallowedEnabledModules(newType, b.modules) : [];
    if (b.modules && coercedModules.length) b.modules = { ...b.modules, ...Object.fromEntries(coercedModules.map((k) => [k, false])) } as typeof b.modules;
    const patch: Parameters<typeof updateGuildSettings>[2] = {};
    if (b.language !== undefined) patch.language = b.language;
    if (b.communityType !== undefined) patch.community_type = b.communityType;
    if (b.countryId !== undefined) patch.country_id = b.countryId;
    if (b.partyId !== undefined) patch.party_id = b.partyId;
    if (b.unitId !== undefined) patch.unit_id = b.unitId;
    if (b.allianceId !== undefined) patch.alliance_id = b.allianceId;
    if (b.modules !== undefined) patch.modules = b.modules;
    if (b.demotionMode !== undefined) patch.demotion_mode = b.demotionMode;
    if (b.demotionGraceDays !== undefined) patch.demotion_grace_days = b.demotionGraceDays;
    if (b.autoSyncEnabled !== undefined) patch.auto_sync_enabled = b.autoSyncEnabled;
    if (b.syncIntervalHours !== undefined) patch.sync_interval_minutes = b.syncIntervalHours * 60;
    if (b.linkMode !== undefined) patch.require_staff_approval = b.linkMode === 'staff_approval';
    if (b.unitLeaderReplacesMember !== undefined) patch.unit_leader_replaces_member = b.unitLeaderReplacesMember;
    let removedMappings = 0;
    try { removedMappings = (await updateGuildSettings(db, a.guildId, patch, a.session.discordUserId, clock(), { confirmRemoveIncompatible: b.confirmRemoveIncompatible === true })).removedMappings.length; }   // re-anchors the durable schedule atomically
    catch (e) {
      if (e instanceof CountryReservedError) return fail(reply, 409, 'country_reserved');                          // nothing was saved
      if (e instanceof IncompatibleMappingsError) return fail(reply, 409, 'incompatible_mappings', { mappings: e.mappings });   // nothing was saved; resend with confirmRemoveIncompatible
      throw e;
    }
    // Enabling the optional military-rank system on a server that has no ladder yet creates the 17 starter ranks (no Discord roles mapped).
    if (b.modules?.ranks && (await getLadder(db, a.guildId)).length === 0) await saveLadder(db, a.guildId, DEFAULT_LADDER_SEED, a.session.discordUserId);
    return { settings: await settingsView(a.guildId), notices: { coercedModules, removedMappings } };
  });

  // The explicit, audited "unlink": the only way a country server gives its country (and therefore the reservation) up.
  app.delete('/api/guilds/:guildId/country', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    return (await releaseCountry(db, a.guildId, a.session.discordUserId)) ? { settings: await settingsView(a.guildId) } : fail(reply, 409, 'no_country');
  });

  // ------------------------------------------------------------------ roles (live from Discord, via the bot)
  async function rolesFor(guildId: string) {
    const [roles, top] = await Promise.all([deps.botRest.listRoles(guildId), deps.botRest.botTopRolePosition(guildId)]);
    if (!roles) return null;
    return roles.sort((x, y) => y.position - x.position).map((r) => ({ id: r.id, name: r.name, position: r.position, color: r.color, ...roleManageability(guildId, r, top) }));
  }
  /** A role may be used for mapping only if it exists in THIS guild and is neither @everyone, an integration role, nor carries admin-like permissions. */
  const unusableRoles = (roles: Awaited<ReturnType<typeof rolesFor>>, ids: string[]) => {
    const byId = new Map((roles ?? []).map((r) => [r.id, r]));
    return ids.filter((id) => { const r = byId.get(id); return !r || r.reason === 'everyone_role' || r.reason === 'integration_managed' || r.reason === 'dangerous_permissions'; });
  };
  app.get('/api/guilds/:guildId/roles', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const roles = await rolesFor(a.guildId);
    return roles ? { roles } : fail(reply, 503, 'discord_unavailable');
  });

  // ------------------------------------------------------------------ military ranks
  const RankBody = z.object({ ranks: z.array(z.object({
    key: z.string().min(1).max(40), order: z.number().int().min(1).max(1000), nameAr: z.string().min(1).max(60), nameEn: z.string().min(1).max(60),
    minDamage: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), discordRoleId: z.string().regex(SNOWFLAKE).nullable(), enabled: z.boolean(),
  }).strict()).min(1).max(100), reset: z.undefined().optional() }).strict();

  app.get('/api/guilds/:guildId/ranks', async (req, reply) => { const a = await guard(req, reply); if (!a) return; return { ranks: await getLadder(db, a.guildId) }; });
  app.put('/api/guilds/:guildId/ranks', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const p = RankBody.safeParse(req.body);
    if (!p.success) return fail(reply, 422, 'validation', { issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const wanted = p.data.ranks.map((r) => r.discordRoleId).filter((x): x is string => x !== null);
    if (wanted.length) {
      const roles = await rolesFor(a.guildId);
      if (!roles) return fail(reply, 503, 'discord_unavailable');
      const bad = unusableRoles(roles, wanted);
      if (bad.length) return fail(reply, 422, 'role_invalid', { roleIds: bad });             // must exist in THIS guild and be safe to manage
    }
    const res = await saveLadder(db, a.guildId, p.data.ranks, a.session.discordUserId);
    if (!res.ok && res.code === 'SYNC_RUNNING') return fail(reply, 409, 'sync_running');
    if (!res.ok && res.code === 'ROLE_CONFLICT') return fail(reply, 409, 'role_conflict', { roleIds: res.roleIds });
    if (!res.ok) return fail(reply, 422, 'invalid_ladder', { issues: res.issues });          // backend validation is authoritative
    return { ranks: await getLadder(db, a.guildId) };
  });
  app.post('/api/guilds/:guildId/ranks/reset', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const keep = new Map((await getLadder(db, a.guildId)).map((r) => [r.key, r.discordRoleId]));
    const res = await saveLadder(db, a.guildId, DEFAULT_LADDER_SEED.map((r) => ({ ...r, discordRoleId: keep.get(r.key) ?? null })), a.session.discordUserId);
    if (!res.ok && res.code === 'SYNC_RUNNING') return fail(reply, 409, 'sync_running');
    if (!res.ok && res.code === 'ROLE_CONFLICT') return fail(reply, 409, 'role_conflict', { roleIds: res.roleIds });
    return res.ok ? { ranks: await getLadder(db, a.guildId) } : fail(reply, 422, 'invalid_ladder', { issues: res.issues });
  });

  // ------------------------------------------------------------------ role mappings
  const MappingBody = z.object({ kind: z.enum(ROLE_KINDS), gameRef: z.string().regex(/^[A-Za-z0-9_-]{0,80}$/).optional(), discordRoleId: z.string().regex(SNOWFLAKE) }).strict();
  app.get('/api/guilds/:guildId/mappings', async (req, reply) => { const a = await guard(req, reply); if (!a) return; return { mappings: (await listRoleMappings(db, a.guildId)).filter((m) => !isBuildKind(m.kind)) }; });
  app.post('/api/guilds/:guildId/mappings', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const p = MappingBody.safeParse(req.body);
    if (!p.success) return fail(reply, 422, 'validation', { issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (isBuildKind(p.data.kind)) return fail(reply, 422, 'use_builds_endpoint');             // build roles have their own permanent settings
    if (p.data.kind.startsWith('alliance_')) return fail(reply, 422, 'feature_unavailable');     // no backing implementation: the game API exposes no verified alliance data
    const cfgM = await getGuildConfig(db, a.guildId);
    if (!cfgM || !isKindAllowed(cfgM.communityType, p.data.kind)) return fail(reply, 422, 'kind_not_allowed_for_type');   // the server type decides which roles exist
    const roles = await rolesFor(a.guildId);
    if (!roles) return fail(reply, 503, 'discord_unavailable');
    const role = roles.find((r) => r.id === p.data.discordRoleId);
    if (!role || unusableRoles(roles, [p.data.discordRoleId]).length) return fail(reply, 422, 'role_invalid');
    const res = await addRoleMapping(db, { guildId: a.guildId, kind: p.data.kind, ...(p.data.gameRef ? { gameRef: p.data.gameRef } : {}), discordRoleId: p.data.discordRoleId, actor: a.session.discordUserId });
    return res.ok ? { mappings: (await listRoleMappings(db, a.guildId)).filter((m) => !isBuildKind(m.kind)), warning: role.manageable ? null : role.reason } : fail(reply, res.code === 'ROLE_CONFLICT' ? 409 : 422, res.code.toLowerCase());
  });
  app.delete('/api/guilds/:guildId/mappings/:mappingId', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const id = (req.params as { mappingId: string }).mappingId;
    if (!/^[0-9a-f-]{36}$/.test(id)) return fail(reply, 400, 'invalid_id');
    return (await removeRoleMapping(db, { guildId: a.guildId, mappingId: id, actor: a.session.discordUserId })) ? { ok: true } : fail(reply, 404, 'not_found');
  });

  // ------------------------------------------------------------------ player accounts
  app.get('/api/guilds/:guildId/links', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const q = req.query as { status?: string; limit?: string; offset?: string };
    if (q.status !== undefined && !['pending', 'verified', 'admin_linked', 'rejected', 'unlinked'].includes(q.status)) return fail(reply, 400, 'invalid_status');
    return { links: await listLinksDetailed(db, a.guildId, { ...(q.status ? { status: q.status } : {}), limit: Math.min(Number(q.limit) || 50, 200), offset: Math.max(Number(q.offset) || 0, 0) }) };
  });
  const LinkId = z.string().regex(/^[0-9a-f-]{36}$/);
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/api/guilds/:guildId/links/:linkId/${action}`, async (req, reply) => {
      const a = await guard(req, reply, { write: true }); if (!a) return;
      const id = LinkId.safeParse((req.params as { linkId: string }).linkId);
      if (!id.success) return fail(reply, 400, 'invalid_id');
      const note = z.object({ reason: z.string().max(200).optional() }).strict().safeParse(req.body ?? {});
      if (!note.success) return fail(reply, 422, 'validation');
      const res = await reviewLink(db, { guildId: a.guildId, linkId: id.data, reviewerId: a.session.discordUserId, approve: action === 'approve', ...(note.data.reason ? { reason: note.data.reason } : {}) });
      return res.ok ? { ok: true } : fail(reply, res.code === 'NOT_FOUND' ? 404 : 409, res.code.toLowerCase());
    });
  }
  app.post('/api/guilds/:guildId/links/unlink', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const b = z.object({ discordUserId: z.string().regex(SNOWFLAKE) }).strict().safeParse(req.body);
    if (!b.success) return fail(reply, 422, 'validation');
    const removed = await unlinkWithRoles(db, { guildId: a.guildId, actorId: a.session.discordUserId, discordUserId: b.data.discordUserId });
    if (!removed.length) return fail(reply, 404, 'not_found');
    const granted = removed.flatMap((r) => r.managedRoleIds);
    if (granted.length && deps.onUnlinked) await deps.onUnlinked(a.guildId, b.data.discordUserId, granted).catch((e) => log(`unlink cleanup failed: ${e instanceof Error ? e.message.slice(0, 80) : 'error'}`));
    return { ok: true, rolesToRemove: granted.length };
  });
  app.post('/api/guilds/:guildId/links/force', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const b = z.object({ discordUserId: z.string().regex(SNOWFLAKE), playerName: z.string().min(1).max(40), reason: z.string().max(200).optional(), replace: z.boolean().optional() }).strict().safeParse(req.body);
    if (!b.success) return fail(reply, 422, 'validation');
    const player = await deps.game.playerByName(b.data.playerName);
    if (player.status === 'not_found') return fail(reply, 404, 'player_not_found');
    if (player.status !== 'ok') return fail(reply, 503, 'game_api_unavailable');
    const res = await forceLink(db, { guildId: a.guildId, adminId: a.session.discordUserId, discordUserId: b.data.discordUserId, playerId: player.data.id, username: player.data.username, ...(b.data.reason ? { reason: b.data.reason } : {}), ...(b.data.replace ? { replace: true } : {}) });
    return res.ok ? { ok: true, player: player.data, replaced: res.replaced } : fail(reply, 409, 'conflict_requires_replace');
  });

  // ------------------------------------------------------------------ player build roles (War / Eco / Hybrid)
  /** The three entries always exist (even unset). `status` tells the dashboard what to show: ok | unset | missing_in_discord | unmanageable | unknown. */
  app.get('/api/guilds/:guildId/builds', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const [cur, roles] = await Promise.all([getBuildRoles(db, a.guildId), rolesFor(a.guildId)]);
    const byId = new Map((roles ?? []).map((r) => [r.id, r]));
    const builds = BUILD_ROLE_KEYS.map((key) => {
      const id = cur[key]; const r = id ? byId.get(id) : undefined;
      const status = !id ? 'unset' : !roles ? 'unknown' : !r ? 'missing_in_discord' : r.manageable ? 'ok' : 'unmanageable';
      return { key, roleId: id, roleName: r?.name ?? null, roleColor: r?.color ?? null, status, reason: r && !r.manageable ? r.reason : null };
    });
    return { builds, discordAvailable: roles !== null };
  });
  const BuildsBody = z.object({ war: z.string().regex(SNOWFLAKE).nullable(), eco: z.string().regex(SNOWFLAKE).nullable(), hybrid: z.string().regex(SNOWFLAKE).nullable() }).partial().strict();
  app.put('/api/guilds/:guildId/builds', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const p = BuildsBody.safeParse(req.body);
    if (!p.success) return fail(reply, 422, 'validation', { issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const ids = Object.values(p.data).filter((x): x is string => typeof x === 'string');
    if (ids.length) {
      const roles = await rolesFor(a.guildId);
      if (!roles) return fail(reply, 503, 'discord_unavailable');
      const bad = unusableRoles(roles, ids);                                                       // must exist in THIS server and be safe to manage
      if (bad.length) return fail(reply, 422, 'role_invalid', { roleIds: bad });
    }
    const roles: Partial<Record<(typeof BUILD_ROLE_KEYS)[number], string | null>> = {};
    for (const k of BUILD_ROLE_KEYS) { const v = p.data[k]; if (v !== undefined) roles[k] = v; }          // only the builds that were sent
    const res = await setBuildRoles(db, { guildId: a.guildId, roles, actor: a.session.discordUserId });
    if (!res.ok) return fail(reply, res.code === 'ROLE_CONFLICT' ? 409 : 422, res.code === 'ROLE_CONFLICT' ? 'role_conflict' : res.code === 'DUPLICATE_ROLE' ? 'duplicate_role' : 'role_invalid', { roleIds: res.roleIds });
    return { ok: true };
  });

  // ------------------------------------------------------------------ searchable entity selectors (setup page)
  // Lists are cached 5 minutes (the game API allows 60 requests/minute/IP) and searched/paginated HERE, so the browser never receives a whole country list.
  // Verified sources: a country's parties and units. UNVERIFIED sources (flagged `verified:false`): the country list and the global unit search.
  const entityCache = new Map<string, { at: number; value: EntityOption[] }>();
  const ENTITY_TTL_MS = 5 * 60_000;
  const entityLimit = limiter(120, 60_000, () => clock().getTime());
  async function cachedOptions(key: string, load: () => Promise<Fetched<EntityOption[]>>): Promise<Fetched<EntityOption[]>> {
    const t = clock().getTime(); const hit = entityCache.get(key);
    if (hit && t - hit.at < ENTITY_TTL_MS) return { status: 'ok', data: hit.value };
    const r = await load();
    if (r.status === 'ok') { entityCache.set(key, { at: t, value: r.data }); if (entityCache.size > 300) entityCache.delete(entityCache.keys().next().value as string); }
    return r;
  }
  const norm = (x: string) => x.normalize('NFKC').toLocaleLowerCase();
  const EntityQuery = z.object({ q: z.string().max(40).default(''), limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(5000).default(0), countryId: GAME_ID.optional() }).strict();
  const EntityType = z.enum(['country', 'party', 'unit']);

  app.get('/api/guilds/:guildId/entities/:type', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    if (!entityLimit(`e:${a.session.discordUserId}`)) return fail(reply, 429, 'rate_limited');
    const type = EntityType.safeParse((req.params as { type: string }).type); const q = EntityQuery.safeParse(req.query);
    if (!type.success || !q.success) return fail(reply, 422, 'validation');
    const { q: term, limit, offset, countryId } = q.data; const g = deps.game;
    let res: Fetched<EntityOption[]>; let verified = true;
    if (type.data === 'country') {
      if (!g.countryOptions) return fail(reply, 503, 'game_unavailable');
      verified = false; res = await cachedOptions('countries', () => g.countryOptions!());
    } else if (type.data === 'party') {
      if (!countryId) return fail(reply, 422, 'country_required');
      res = await cachedOptions(`parties:${countryId}`, async () => { const r = await g.countryParties(countryId); return r.status === 'ok' ? { status: 'ok', data: partyOptions(r.data) } : r; });
    } else if (countryId) {
      res = await cachedOptions(`units:${countryId}`, async () => { const r = await g.countryUnits(countryId); return r.status === 'ok' ? { status: 'ok', data: unitOptions(r.data) } : r; });
    } else {
      // No country filter: the game API's own search (documented, shape unverified). Needs a term so we never page the whole world.
      if (norm(term).trim().length < 2) return { items: [], total: 0, offset, limit, hasMore: false, verified: false, needsQuery: true };
      if (!g.searchUnits) return fail(reply, 503, 'game_unavailable');
      verified = false; res = await cachedOptions(`unitsearch:${norm(term).trim()}`, async () => { const r = await g.searchUnits!(term); return r.status === 'ok' ? { status: 'ok', data: unitOptions(r.data) } : r; });
    }
    if (res.status !== 'ok') return fail(reply, res.status === 'not_found' ? 404 : 503, `game_${res.status}`);   // `game_incomplete` = response not recognised => dashboard falls back to manual input
    const n = norm(term).trim();
    const hits = (n ? res.data.filter((o) => norm(o.name).includes(n)) : [...res.data]).sort((x, y) => (Number(norm(y.name).startsWith(n)) - Number(norm(x.name).startsWith(n))) || x.name.localeCompare(y.name));
    return { items: hits.slice(offset, offset + limit), total: hits.length, offset, limit, hasMore: offset + limit < hits.length, verified };
  });

  // Display name of the currently selected entity (never fails the page: unknown => name:null).
  app.get('/api/guilds/:guildId/entities/:type/:id', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    if (!entityLimit(`e:${a.session.discordUserId}`)) return fail(reply, 429, 'rate_limited');
    const { type, id } = req.params as { type: string; id: string }; const t = EntityType.safeParse(type);
    if (!t.success || !GAME_ID.safeParse(id).success) return fail(reply, 422, 'validation');
    let name: string | null = null; const g = deps.game;
    try {
      if (t.data === 'country' && g.countryOptions) { const r = await cachedOptions('countries', () => g.countryOptions!()); if (r.status === 'ok') name = r.data.find((o) => o.id.toLowerCase() === id.toLowerCase())?.name ?? null; }
      else if (t.data !== 'country' && g.entityName) { const r = await cachedOptions(`name:${t.data}:${id}`, async () => { const x = await g.entityName!(t.data as 'party' | 'unit', id); return x.status === 'ok' ? { status: 'ok', data: [{ id, name: x.data }] } : x; }); if (r.status === 'ok') name = r.data[0]?.name ?? null; }
    } catch { name = null; }
    return { id, name };
  });

  // ------------------------------------------------------------------ game entity pickers (verified mappers only)
  app.get('/api/guilds/:guildId/game/parties', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const c = await getGuildConfig(db, a.guildId);
    if (!c?.countryId) return fail(reply, 409, 'country_not_set');
    const r = await deps.game.countryParties(c.countryId);
    return r.status === 'ok' ? { parties: r.data } : fail(reply, r.status === 'not_found' ? 404 : 503, `game_${r.status}`);
  });
  app.get('/api/guilds/:guildId/game/units', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const c = await getGuildConfig(db, a.guildId);
    if (!c?.countryId) return fail(reply, 409, 'country_not_set');
    const r = await deps.game.countryUnits(c.countryId);
    return r.status === 'ok' ? { units: r.data } : fail(reply, r.status === 'not_found' ? 404 : 503, `game_${r.status}`);
  });

  // ------------------------------------------------------------------ sync + audit
  /** Schedule + last result, in one call: interval, enabled, next run, last SUCCESSFUL run, last result, running flag. */
  app.get('/api/guilds/:guildId/sync/status', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const st = await getSyncStatus(db, a.guildId);
    return st ? { enabled: st.enabled, intervalHours: st.intervalMinutes / 60, nextSyncAt: st.nextSyncAt, running: st.running, lastSuccess: st.lastSuccess, lastJob: st.lastJob } : fail(reply, 404, 'not_found');
  });
  app.get('/api/guilds/:guildId/sync/jobs', async (req, reply) => { const a = await guard(req, reply); if (!a) return; return { jobs: await listSyncJobs(db, a.guildId, 20) }; });
  app.post('/api/guilds/:guildId/sync', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    const running = await db.query(`SELECT 1 FROM sync_jobs WHERE guild_id=$1 AND status IN ('queued','running') AND kind IN ('all','scheduled')`, [a.guildId]);
    if (running.rows.length) return fail(reply, 409, 'already_running');
    void deps.runSync(a.guildId, a.session.discordUserId).catch((e) => log(`dashboard sync failed: ${e instanceof Error ? e.message : 'error'}`));
    return reply.code(202).send({ started: true });
  });
  app.post('/api/guilds/:guildId/sync/cancel', async (req, reply) => {
    const a = await guard(req, reply, { write: true }); if (!a) return;
    return (await cancelSyncJob(db, a.guildId, a.session.discordUserId)) ? { ok: true } : fail(reply, 404, 'nothing_running');
  });
  app.get('/api/guilds/:guildId/audit', async (req, reply) => {
    const a = await guard(req, reply); if (!a) return;
    const q = req.query as { limit?: string; before?: string };
    const before = q.before !== undefined ? Number(q.before) : undefined;
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) return fail(reply, 400, 'invalid_cursor');
    const rows = await listAudit(db, a.guildId, { limit: Math.min(Number(q.limit) || 50, 200), ...(before !== undefined ? { beforeId: before } : {}) });
    return { events: rows, nextBefore: rows.length ? rows[rows.length - 1]!.id : null };
  });

  app.get('/healthz', async (_req, reply) => {
    const h = deps.health ? await deps.health() : { database: true, discord: true, gameApi: null };
    return reply.code(h.database && h.discord ? 200 : 503).send({ database: h.database, discord: h.discord });       // no secrets, no data
  });

  // Public, unauthenticated: only builds the bot invite link (Manage Roles; never Administrator).
  app.get('/api/public', async () => ({ inviteUrl: `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: cfg.clientId, scope: 'bot applications.commands', permissions: String(0x10000000) })}` }));

  // ------------------------------------------------------------------ static site (landing + dashboard shell)
  const pub = deps.publicDir;
  async function serve(reply: FastifyReply, rel: string) {
    if (!pub) return fail(reply, 404, 'not_found');
    const safe = normalize(rel).replace(/^([/\\])+/, '');
    if (safe.includes('..')) return fail(reply, 400, 'bad_path');
    const type = MIME[extname(safe)];
    if (!type) return fail(reply, 404, 'not_found');
    let body: Buffer;
    try { body = await readFile(join(pub, safe)); } catch { return fail(reply, 404, 'not_found'); }   // read FIRST: no content-type is set on a miss
    return reply.header('content-type', type).header('cache-control', 'public, max-age=300').send(body);
  }
  app.get('/', (_req, reply) => serve(reply, 'landing.html'));
  app.get('/app', (_req, reply) => serve(reply, 'app.html'));
  app.get('/favicon.ico', (_req, reply) => serve(reply, 'brand/favicon.ico'));
  app.get('/static/*', (req, reply) => serve(reply, (req.params as { '*': string })['*']));
  app.setNotFoundHandler((_req, reply) => fail(reply, 404, 'not_found'));
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { message?: string; statusCode?: number };
    log(`unhandled: ${(e.message ?? 'error').slice(0, 120)}`);                    // details only in logs, never in the response
    return fail(reply, e.statusCode && e.statusCode < 500 ? e.statusCode : 500, e.statusCode && e.statusCode < 500 ? 'bad_request' : 'internal');
  });

  return app;
}
