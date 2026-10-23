import { randomBytes } from 'node:crypto';
import type { Fetched } from '@aon/core';
import type { HttpStats, PlayerIdentity, ProfileCard, StatsCard } from '@aon/client';
import {
  claimLink, ensureGuild, findLinkForUser, forceLink, getGuildConfig, getLadder, listActiveLinks, listPendingLinks, listRoleMappings, reviewLink, unlinkWithRoles,
  type Db,
} from '@aon/db';
import { syncGuild, syncOneUser, type DiscordGateway, type GameData, type GuildSyncDeps, type UserSyncResult } from '@aon/sync';
import { t, type Lang, type MsgKey } from './messages.js';
import { buildProfileEmbed, type EmbedJson } from './profile-card.js';

export interface Reply { content: string; buttons?: { id: string; label: string; primary?: boolean }[]; embed?: EmbedJson }

/**
 * Pluggable ownership check run before a link is created. The default is NAME-ONLY: it accepts any existing game player, which does
 * NOT prove ownership (the game API is read-only). A stronger verifier (e.g. a challenge the player must put on their profile, or a
 * ticket reviewed by staff) can be supplied through BotDeps.verifier without changing the link tables or the sync engine.
 */
export interface OwnershipVerifier { id: string; verify(ctx: { guildId: string; discordUserId: string; playerId: string; username: string | null }): Promise<{ ok: true; proof: string } | { ok: false; reason: string }> }
export const nameOnlyVerifier: OwnershipVerifier = { id: 'name_only', async verify() { return { ok: true, proof: 'none' }; } };
export interface Invocation {
  guildId: string | null; guildName: string; userId: string;
  /** Computed by Discord for this interaction (ManageGuild or Administrator). Authoritative; never taken from options. */
  canManageGuild: boolean;
  group: string | null; sub: string;
  str(name: string): string | undefined; user(name: string): string | undefined; bool(name: string): boolean | undefined;
  /** `public: true` makes the (deferred) reply visible to the channel; everything else is private to the caller. */
  defer(opts?: { public?: boolean }): Promise<void>;
  /** Replies (or edits the deferred reply). Always ephemeral. */
  reply(r: Reply): Promise<void>;
}
export interface ButtonInvocation {
  guildId: string | null; userId: string; canManageGuild: boolean; customId: string;
  update(r: Reply): Promise<void>;
}
export interface BotDeps {
  db: Db;
  game: GameData & {
    playerByName(u: string): Promise<Fetched<PlayerIdentity>>; playerProfile(id: string): Promise<Fetched<{ id: string; username: string | null }>>;
    playerCard(id: string): Promise<{ profile: Fetched<ProfileCard>; stats: Fetched<StatsCard> }>;
  };
  verifier?: OwnershipVerifier;
  /** Where relative avatar paths live (UNVERIFIED assumption about the game's media host; configurable). */
  mediaBaseUrl?: string;
  discord: DiscordGateway;
  now?: () => Date;
  httpStats?: () => HttpStats;
  log?: (m: string) => void;
  cooldownMs?: number;
}

type Pending =
  | { kind: 'link'; userId: string; playerId: string; username: string | null; expires: number }
  | { kind: 'unlink'; userId: string; name: string; expires: number }
  | { kind: 'force'; adminId: string; targetUserId: string; playerId: string; username: string | null; reason: string | undefined; replace: boolean; expires: number };

const pending = new Map<string, Pending>();
const cooldowns = new Map<string, number>();
const TTL_MS = 5 * 60_000;
const token = () => randomBytes(6).toString('hex');
function sweep(now: number) { for (const [k, v] of pending) if (v.expires < now) pending.delete(k); }

/** Registers a freshly installed guild (idempotent). */
export async function onGuildInstalled(db: Db, guildId: string, name: string): Promise<void> {
  await ensureGuild(db, guildId, name);          // the optional military-rank system gets its 17 starter ranks only when an admin enables it
}

/** Takes the roles the bot had granted off a member who was unlinked. Only roles the bot is currently able to manage are touched. */
async function removeGrantedRoles(deps: BotDeps, guildId: string, userId: string, roleIds: string[]): Promise<number> {
  if (!roleIds.length) return 0;
  const assignable = await deps.discord.assignableRoles(guildId).catch(() => new Set<string>());
  let n = 0;
  for (const r of roleIds) {
    if (!assignable.has(r)) continue;
    try { await deps.discord.removeRole(guildId, userId, r, 'AoN role bot: account unlinked'); n++; } catch (e) { deps.log?.(`unlink cleanup: could not remove ${r} from ${userId}: ${e instanceof Error ? e.message.slice(0, 80) : 'error'}`); }
  }
  return n;
}

const esc = (x: string): string => x.replace(/[\\*_~`|>[\]()#-]/g, (c) => `\\${c}`).replace(/@/g, '@\u200b');
const roleList = (ids: string[]) => (ids.length ? ids.map((r) => `<@&${r}>`).join(' ') : '—');

function describeSync(lang: Lang, r: UserSyncResult): string {
  const parts: string[] = [];
  if (r.outcome === 'failed') return t(lang, 'sync_failed');
  if (r.outcome === 'skipped') return t(lang, 'sync_skipped_member');
  if (r.added.length || r.removed.length) parts.push(t(lang, 'sync_done', { added: roleList(r.added), removed: roleList(r.removed) }));
  else if (r.outcome === 'unchanged') parts.push(t(lang, 'sync_nochange'));
  if (r.outcome === 'partial') parts.push(t(lang, 'sync_partial'));
  if (r.blocked.length) parts.push(t(lang, 'sync_blocked', { n: r.blocked.length }));
  return parts.join('\n') || t(lang, 'sync_nochange');
}

function gameFailure(lang: Lang, res: Fetched<unknown>): string | null {
  if (res.status === 'ok') return null;
  return res.status === 'not_found' ? t(lang, 'player_not_found') : t(lang, 'api_down');
}

function onCooldown(deps: BotDeps, userId: string, scope: string): boolean {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const key = `${scope}:${userId}`;
  const last = cooldowns.get(key);
  if (last !== undefined && now - last < (deps.cooldownMs ?? 10_000)) return true;
  cooldowns.set(key, now);
  return false;
}

export async function handleCommand(deps: BotDeps, inv: Invocation): Promise<void> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  sweep(nowMs);
  const name = inv.group ?? inv.sub;
  if (name === 'help') { const lang = inv.guildId ? (await getGuildConfig(deps.db, inv.guildId))?.language ?? 'en' : 'en'; return inv.reply({ content: t(lang, 'help') }); }
  if (!inv.guildId) return inv.reply({ content: t('en', 'guild_only') });

  await onGuildInstalled(deps.db, inv.guildId, inv.guildName);
  const cfg = (await getGuildConfig(deps.db, inv.guildId))!;
  const lang = cfg.language;
  const needAdmin = async () => { if (inv.canManageGuild) return true; await inv.reply({ content: t(lang, 'not_admin') }); return false; }; // enforced server-side, per call

  switch (`${inv.group}/${inv.sub}`) {
    case 'link/link': {
      if (onCooldown(deps, inv.userId, 'link')) return inv.reply({ content: t(lang, 'cooldown') });
      const mine = await findLinkForUser(deps.db, inv.guildId, inv.userId);
      if (mine && mine.status !== 'pending') return inv.reply({ content: t(lang, 'link_already_self') });   // re-linking needs an explicit /unlink first
      await inv.defer();
      const res = await deps.game.playerByName(inv.str('username') ?? '');
      const fail = gameFailure(lang, res);
      if (fail || res.status !== 'ok') return inv.reply({ content: fail ?? t(lang, 'api_down') });
      const tk = token();
      pending.set(tk, { kind: 'link', userId: inv.userId, playerId: res.data.id, username: res.data.username, expires: nowMs + TTL_MS });
      return inv.reply({ content: t(lang, 'link_preview', { name: esc(res.data.username ?? res.data.id), id: res.data.id }), buttons: [{ id: `lc:${tk}`, label: t(lang, 'link_confirm_btn'), primary: true }, { id: `lx:${tk}`, label: t(lang, 'link_cancel_btn') }] });
    }
    case 'unlink/unlink': {
      const mine = await findLinkForUser(deps.db, inv.guildId, inv.userId);
      if (!mine) return inv.reply({ content: t(lang, 'unlink_self_none') });
      const tk = token(); const nm = mine.username ?? mine.playerId;
      pending.set(tk, { kind: 'unlink', userId: inv.userId, name: nm, expires: nowMs + TTL_MS });
      return inv.reply({ content: t(lang, 'unlink_confirm', { name: esc(nm) }), buttons: [{ id: `ul:${tk}`, label: t(lang, 'link_confirm_btn'), primary: true }, { id: `lx:${tk}`, label: t(lang, 'link_cancel_btn') }] });
    }
    case 'profile/profile': {
      const target = inv.user('user') ?? inv.userId; const mine = target === inv.userId;
      const link = await findLinkForUser(deps.db, inv.guildId, target);
      if (!link) return inv.reply({ content: mine ? t(lang, 'profile_not_linked') : t(lang, 'profile_other_not_linked', { user: target }) });
      if (link.status === 'pending') return inv.reply({ content: t(lang, 'profile_pending') });
      if (onCooldown(deps, inv.userId, 'profile')) return inv.reply({ content: t(lang, 'cooldown') });
      await inv.defer({ public: inv.bool('private') !== true });
      const card = await deps.game.playerCard(link.playerId);
      if (card.profile.status === 'not_found') return inv.reply({ content: t(lang, 'profile_player_missing') });   // the link is kept
      if (card.profile.status !== 'ok') return inv.reply({ content: t(lang, 'api_down') });
      const ranksEnabled = cfg.modules.ranks;
      const embed = buildProfileEmbed({ lang, profile: card.profile.data, stats: card.stats.status === 'ok' ? card.stats.data : null, ladder: ranksEnabled ? await getLadder(deps.db, inv.guildId) : [], ranksEnabled, mediaBaseUrl: deps.mediaBaseUrl ?? 'https://app.ageofnations.world', now: (deps.now ?? (() => new Date()))() });
      return inv.reply({ content: '', embed });
    }
    case 'link-status/link-status': {
      const l = await findLinkForUser(deps.db, inv.guildId, inv.userId);
      if (!l) return inv.reply({ content: t(lang, 'status_none') });
      const nm = esc(l.username ?? l.playerId);
      return inv.reply({ content: l.status === 'pending' ? t(lang, 'status_pending', { name: nm, id: l.playerId }) : t(lang, 'status_linked', { name: nm, id: l.playerId, sync: l.lastSyncedAt ? `<t:${Math.floor(l.lastSyncedAt.getTime() / 1000)}:R>` : t(lang, 'never') }) });
    }
    case 'sync/me': {
      const l = await findLinkForUser(deps.db, inv.guildId, inv.userId);
      if (!l) return inv.reply({ content: t(lang, 'sync_need_link') });
      if (l.status === 'pending') return inv.reply({ content: t(lang, 'sync_need_approval') });
      if (onCooldown(deps, inv.userId, 'sync')) return inv.reply({ content: t(lang, 'cooldown') });
      await inv.defer();
      const r = await syncOneUser(syncDeps(deps), inv.guildId, inv.userId);
      if ('error' in r) return inv.reply({ content: r.error === 'BUSY' ? t(lang, 'busy') : t(lang, 'sync_need_link') });
      return inv.reply({ content: describeSync(lang, r) });
    }
    case 'sync/all': {
      if (!(await needAdmin())) return;
      await inv.defer();
      await inv.reply({ content: t(lang, 'syncall_started') });
      const res = await syncGuild(syncDeps(deps), { guildId: inv.guildId, kind: 'all', requestedBy: inv.userId });
      if (!res.ok) return inv.reply({ content: res.code === 'ALREADY_RUNNING' ? t(lang, 'syncall_running') : t(lang, 'syncall_notconfigured') });
      return inv.reply({ content: t(lang, 'syncall_done', { status: res.status, ...res.counts }) + (res.error ? `\n${res.error}` : '') });
    }
    case 'force/link': {
      if (!(await needAdmin())) return;
      const target = inv.user('user');
      if (!target) return inv.reply({ content: t(lang, 'status_none') });
      await inv.defer();
      const res = await deps.game.playerByName(inv.str('player') ?? '');
      const fail = gameFailure(lang, res);
      if (fail || res.status !== 'ok') return inv.reply({ content: fail ?? t(lang, 'api_down') });
      const replace = inv.bool('replace') === true;
      const tk = token();
      pending.set(tk, { kind: 'force', adminId: inv.userId, targetUserId: target, playerId: res.data.id, username: res.data.username, reason: inv.str('reason'), replace, expires: nowMs + TTL_MS });
      return inv.reply({ content: t(lang, 'force_preview', { user: target, name: res.data.username ?? res.data.id, id: res.data.id, replace: replace ? t(lang, 'force_replace_note') : '' }), buttons: [{ id: `fl:${tk}`, label: t(lang, 'force_btn'), primary: true }, { id: `lx:${tk}`, label: t(lang, 'link_cancel_btn') }] });
    }
    case 'admin/pending': {
      if (!(await needAdmin())) return;
      const rows = await listPendingLinks(deps.db, inv.guildId);
      if (!rows.length) return inv.reply({ content: t(lang, 'pending_none') });
      return inv.reply({ content: [t(lang, 'pending_header'), ...rows.map((p) => `<@${p.discordUserId}> → **${p.username ?? p.playerId}** (\`${p.playerId}\`)${p.conflict ? ' ⚠️' : ''}`)].join('\n') });
    }
    case 'admin/approve': case 'admin/reject': {
      if (!(await needAdmin())) return;
      const target = inv.user('user');
      const row = target ? (await listPendingLinks(deps.db, inv.guildId, 200)).find((p) => p.discordUserId === target) : undefined;
      if (!target || !row) return inv.reply({ content: t(lang, 'review_not_found') });
      const link = await findLinkForUser(deps.db, inv.guildId, target);
      if (!link) return inv.reply({ content: t(lang, 'review_not_found') });
      const approve = inv.sub === 'approve';
      const out = await reviewLink(deps.db, { guildId: inv.guildId, linkId: link.id, reviewerId: inv.userId, approve, ...(inv.str('reason') ? { reason: inv.str('reason')! } : {}) });
      if (!out.ok) return inv.reply({ content: out.code === 'PLAYER_ALREADY_LINKED' ? t(lang, 'review_player_linked') : out.code === 'USER_ALREADY_LINKED' ? t(lang, 'review_user_linked') : t(lang, 'review_not_found') });
      return inv.reply({ content: t(lang, approve ? 'approve_done' : 'reject_done') });
    }
    case 'admin/unlink': {
      if (!(await needAdmin())) return;
      const target = inv.user('user');
      const removed = target ? await unlinkWithRoles(deps.db, { guildId: inv.guildId, actorId: inv.userId, discordUserId: target }) : [];
      if (target && removed.length) await removeGrantedRoles(deps, inv.guildId, target, removed.flatMap((r) => r.managedRoleIds));
      return inv.reply({ content: t(lang, removed.length ? 'unlink_done' : 'unlink_none') });
    }
    case 'admin/diagnostics': {
      if (!(await needAdmin())) return;
      const [maps, ladder, links, pend] = await Promise.all([listRoleMappings(deps.db, inv.guildId), getLadder(deps.db, inv.guildId), listActiveLinks(deps.db, inv.guildId), listPendingLinks(deps.db, inv.guildId, 1000)]);
      const s = deps.httpStats?.();
      const mods = Object.entries(cfg.modules).filter(([, v]) => v).map(([k]) => k).join(', ') || '—';
      return inv.reply({ content: t(lang, 'diag', {
        guild: cfg.name || inv.guildName, country: cfg.countryId ?? t(lang, 'not_configured_hint'), modules: mods,
        mappings: maps.length, ranks: ladder.filter((r) => r.discordRoleId).length, links: links.length, pending: pend.length,
        sent: s?.requestsSent ?? 0, hits: s?.cacheHits ?? 0, rl: s?.rateLimited ?? 0, auto: cfg.autoSyncEnabled ? `${cfg.syncIntervalMinutes / 60} h` : 'off',
      }) });
    }
    default:
      return inv.reply({ content: t(lang, 'help') });
  }
}

export async function handleButton(deps: BotDeps, inv: ButtonInvocation): Promise<void> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  sweep(nowMs);
  const [kind, tk] = inv.customId.split(':');
  const lang: Lang = inv.guildId ? (await getGuildConfig(deps.db, inv.guildId))?.language ?? 'en' : 'en';
  const p = tk ? pending.get(tk) : undefined;
  if (!inv.guildId || !p || p.expires < nowMs) return inv.update({ content: t(lang, 'link_expired') });

  const owner = p.kind === 'force' ? p.adminId : p.userId;
  if (owner !== inv.userId) return inv.update({ content: t(lang, 'link_not_yours') }); // button pressed by someone else
  if (kind === 'lx') { pending.delete(tk!); return inv.update({ content: '✖' }); }

  if (kind === 'lc' && p.kind === 'link') {
    pending.delete(tk!);
    const cfg = await getGuildConfig(deps.db, inv.guildId);
    const direct = cfg ? !cfg.requireStaffApproval : false;
    const nm = p.username ?? p.playerId;
    const v = await (deps.verifier ?? nameOnlyVerifier).verify({ guildId: inv.guildId, discordUserId: p.userId, playerId: p.playerId, username: p.username });
    if (!v.ok) return inv.update({ content: t(lang, 'link_verify_failed', { reason: v.reason }) });
    const r = await claimLink(deps.db, { guildId: inv.guildId, discordUserId: p.userId, playerId: p.playerId, username: p.username, direct });
    if (!r.ok) return inv.update({ content: t(lang, r.code === 'ALREADY_LINKED_SELF' ? 'link_already_self' : r.code === 'PLAYER_ALREADY_LINKED' ? 'link_player_taken' : 'link_dup_pending') });
    if (!r.direct) return inv.update({ content: t(lang, r.conflict ? 'link_pending_conflict' : 'link_pending', { name: esc(nm) }) });
    // Direct link: active immediately. Refresh the member's roles right away (best effort; failures never undo the link).
    let note = t(lang, 'link_sync_later');
    try {
      const s = await syncOneUser(syncDeps(deps), inv.guildId, p.userId);
      if (!('error' in s) && (s.outcome === 'updated' || s.outcome === 'unchanged' || s.outcome === 'partial')) note = `${t(lang, 'link_synced_note')} ${describeSync(lang, s)}`;
    } catch { /* keep the "later" note */ }
    return inv.update({ content: `${t(lang, 'link_direct_done', { name: esc(nm), id: p.playerId })}\n${note}` });
  }
  if (kind === 'ul' && p.kind === 'unlink') {
    pending.delete(tk!);
    const removed = await unlinkWithRoles(deps.db, { guildId: inv.guildId, actorId: p.userId, discordUserId: p.userId, action: 'link.unlinked_self' });
    if (!removed.length) return inv.update({ content: t(lang, 'unlink_self_none') });
    const n = await removeGrantedRoles(deps, inv.guildId, p.userId, removed.flatMap((x) => x.managedRoleIds));
    return inv.update({ content: t(lang, 'unlink_self_done', { n }) });
  }
  if (kind === 'fl' && p.kind === 'force') {
    if (!inv.canManageGuild) return inv.update({ content: t(lang, 'not_admin') }); // re-checked at click time
    pending.delete(tk!);
    const r = await forceLink(deps.db, { guildId: inv.guildId, adminId: p.adminId, discordUserId: p.targetUserId, playerId: p.playerId, username: p.username, replace: p.replace, ...(p.reason ? { reason: p.reason } : {}) });
    if (!r.ok) return inv.update({ content: t(lang, 'force_conflict') });
    return inv.update({ content: t(lang, 'force_done', { user: p.targetUserId, name: p.username ?? p.playerId }) });
  }
  return inv.update({ content: t(lang, 'link_expired') });
}

function syncDeps(deps: BotDeps): GuildSyncDeps {
  return { db: deps.db, game: deps.game, discord: deps.discord, ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) };
}
export type { MsgKey };
