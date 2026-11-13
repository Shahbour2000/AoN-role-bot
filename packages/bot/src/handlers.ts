import { randomBytes } from 'node:crypto';
import type { Fetched } from '@aon/core';
import type { HttpStats, PlayerIdentity, ProfileCard, StatsCard } from '@aon/client';
import {
  claimLink, ensureGuild, ensureGuildLink, findLinkForUser, forceLink, getGlobalLinkForUser, unlinkGlobalSelf, getGuildConfig, getLadder, listActiveLinks, listPendingLinks, listRoleMappings, reviewLink, unlinkWithRoles,
  getPendingAttemptForUser, audit, type Db,
} from '@aon/db';
import { publishVerificationPanel, syncGuild, syncOneUser, type DiscordGateway, type PanelPublisher, type GameData, type GuildSyncDeps, type UserSyncResult } from '@aon/sync';
import { t, type Lang, type MsgKey } from './messages.js';
import { buildProfileEmbed, type EmbedJson } from './profile-card.js';
import { checkTicket, closeTicket, newCode, openTicket } from './verification.js';
import { describeSync, esc, gameFailure, removeGrantedRoles, syncDeps } from './shared.js';

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
export interface ModalSpec { id: string; title: string; fieldId: string; label: string; maxLength: number }
export interface ButtonInvocation {
  guildId: string | null; userId: string; canManageGuild: boolean; customId: string;
  update(r: Reply): Promise<void>;
  /** Acknowledge now, answer later with `update` (Discord allows 3 s; game-API checks can take longer). */
  deferUpdate?(): Promise<void>;
  /** Private reply that leaves the clicked (public) message untouched. */
  deferReply?(): Promise<void>; reply?(r: Reply): Promise<void>;
  showModal?(m: ModalSpec): Promise<void>;
}
export interface ModalInvocation { guildId: string | null; userId: string; customId: string; field(id: string): string; deferReply?(): Promise<void>; reply(r: Reply): Promise<void> }
export interface BotDeps {
  db: Db;
  game: GameData & {
    playerByName(u: string): Promise<Fetched<PlayerIdentity>>; playerProfile(id: string): Promise<Fetched<{ id: string; username: string | null }>>;
    playerCard(id: string): Promise<{ profile: Fetched<ProfileCard>; stats: Fetched<StatsCard> }>;
    /** Optional: display name of a country (null when unknown). */
    countryName?(id: string): Promise<string | null>;
    /** All companies of a player (`GET /players/{id}/companies`, paginated by the client). The proof of ownership is read from here only. */
    playerCompanies(id: string): Promise<Fetched<{ companies: { id: string | null; name: string }[] }>>;
  };
  /** Posts / edits / removes the verification panel message (supplied by the Discord adapter; absent in tests that do not need it). Shared with the dashboard. */
  panelPublisher?: PanelPublisher;
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

function onCooldown(deps: BotDeps, userId: string, scope: string): boolean {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const key = `${scope}:${userId}`;
  const last = cooldowns.get(key);
  if (last !== undefined && now >= last && now - last < (deps.cooldownMs ?? 10_000)) return true;   // a clock that moved backwards never blocks
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
    case 'link/link': case 'verify/verify': {   // `/link` is now an alias: it starts verification (a name-only claim is no longer accepted)
      if (onCooldown(deps, inv.userId, 'verify')) return inv.reply({ content: t(lang, 'cooldown') });
      await inv.defer();
      return inv.reply(await openTicket({ deps, guildId: inv.guildId, userId: inv.userId }, inv.str('username')));
    }
    case 'admin/verify-panel': {          // same implementation as the dashboard's "Publish" button (publishVerificationPanel)
      if (!(await needAdmin())) return;
      await inv.defer();
      const r = await publishVerificationPanel({ db: deps.db, publisher: deps.panelPublisher, ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) }, { guildId: inv.guildId, actorId: inv.userId, source: 'command' });
      const ch = cfg.verificationChannelId ?? '';
      if (r.ok) return inv.reply({ content: t(lang, r.action === 'edited' ? 'vt_panel_updated' : 'vt_panel_posted', { ch: r.channelId }) });
      if (r.code === 'no_channel') return inv.reply({ content: t(lang, 'vt_no_channel') });
      if (r.code === 'busy') return inv.reply({ content: t(lang, 'vt_panel_busy') });
      if (r.code === 'missing_permissions' && r.missing?.length) return inv.reply({ content: t(lang, 'vt_panel_perms', { ch, perms: r.missing.join(', ') }) });
      return inv.reply({ content: t(lang, 'vt_panel_failed', { ch }) });
    }
    case 'unlink/unlink': {
      const mine = await findLinkForUser(deps.db, inv.guildId, inv.userId);
      const gl = await getGlobalLinkForUser(deps.db, inv.userId);
      if (!mine && !gl) return inv.reply({ content: t(lang, 'unlink_self_none') });
      const tk = token(); const nm = gl?.username ?? gl?.playerId ?? mine!.username ?? mine!.playerId;
      pending.set(tk, { kind: 'unlink', userId: inv.userId, name: nm, expires: nowMs + TTL_MS });
      return inv.reply({ content: t(lang, 'unlink_confirm', { name: esc(nm) }) + (gl ? `\n${t(lang, 'unlink_global_hint')}` : ''), buttons: [{ id: `ul:${tk}`, label: t(lang, 'link_confirm_btn'), primary: true }, { id: `lx:${tk}`, label: t(lang, 'link_cancel_btn') }] });
    }
    case 'profile/profile': {
      const target = inv.user('user') ?? inv.userId; const mine = target === inv.userId;
      if (mine) await ensureGuildLink(deps.db, { guildId: inv.guildId, discordUserId: inv.userId });
      const link = await findLinkForUser(deps.db, inv.guildId, target);
      if (!link) return inv.reply({ content: mine ? t(lang, 'profile_not_linked') : t(lang, 'profile_other_not_linked', { user: target }) });
      if (link.status === 'pending') return inv.reply({ content: t(lang, 'profile_pending') });
      if (onCooldown(deps, inv.userId, 'profile')) return inv.reply({ content: t(lang, 'cooldown') });
      await inv.defer({ public: inv.bool('private') !== true });
      const card = await deps.game.playerCard(link.playerId);
      if (card.profile.status === 'not_found') return inv.reply({ content: t(lang, 'profile_player_missing') });   // the link is kept
      if (card.profile.status !== 'ok') return inv.reply({ content: t(lang, 'api_down') });
      const ranksEnabled = cfg.modules.ranks;
      const countryName = card.profile.data.countryId && deps.game.countryName ? await deps.game.countryName(card.profile.data.countryId).catch(() => null) : null;
      const embed = buildProfileEmbed({ lang, countryName, profile: card.profile.data, stats: card.stats.status === 'ok' ? card.stats.data : null, ladder: ranksEnabled ? await getLadder(deps.db, inv.guildId) : [], ranksEnabled, mediaBaseUrl: deps.mediaBaseUrl ?? 'https://app.ageofnations.world', now: (deps.now ?? (() => new Date()))() });
      return inv.reply({ content: '', embed });
    }
    case 'link-status/link-status': {
      await ensureGuildLink(deps.db, { guildId: inv.guildId, discordUserId: inv.userId });
      const l = await findLinkForUser(deps.db, inv.guildId, inv.userId);
      if (!l) return inv.reply({ content: t(lang, 'status_none') });
      const nm = esc(l.username ?? l.playerId);
      return inv.reply({ content: l.status === 'pending' ? t(lang, 'status_pending', { name: nm, id: l.playerId }) : t(lang, 'status_linked', { name: nm, id: l.playerId, sync: l.lastSyncedAt ? `<t:${Math.floor(l.lastSyncedAt.getTime() / 1000)}:R>` : t(lang, 'never') }) });
    }
    case 'sync/me': {
      await ensureGuildLink(deps.db, { guildId: inv.guildId, discordUserId: inv.userId });
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

export async function handleModal(deps: BotDeps, inv: ModalInvocation): Promise<void> {
  if (inv.customId !== 'vm:open' || !inv.guildId) return;
  await inv.deferReply?.();
  await inv.reply(await openTicket({ deps, guildId: inv.guildId, userId: inv.userId }, inv.field('username')));
}

async function handleVerificationButton(deps: BotDeps, inv: ButtonInvocation, kind: string, id: string | undefined, lang: Lang): Promise<void> {
  if (!inv.guildId) return inv.update({ content: t(lang, 'guild_only') });
  const ctx = { deps, guildId: inv.guildId, userId: inv.userId };
  if (kind === 'vt') {                                                  // the public panel button: never edit the panel itself
    const known = (await getGlobalLinkForUser(deps.db, inv.userId)) ?? (await getPendingAttemptForUser(deps.db, inv.userId, (deps.now ?? (() => new Date()))()));
    if (!known && inv.showModal) return inv.showModal({ id: 'vm:open', title: t(lang, 'vt_modal_title'), fieldId: 'username', label: t(lang, 'vt_modal_label'), maxLength: 40 });
    await inv.deferReply?.();
    return (inv.reply ?? inv.update)(await openTicket(ctx, undefined));
  }
  await inv.deferUpdate?.();
  if (!id) return inv.update({ content: t(lang, 'vt_gone') });
  return inv.update(kind === 'vc' ? await checkTicket(ctx, id) : kind === 'vn' ? await newCode(ctx, id) : await closeTicket(ctx, id));
}

export async function handleButton(deps: BotDeps, inv: ButtonInvocation): Promise<void> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  sweep(nowMs);
  const [kind, tk] = inv.customId.split(':');
  const lang: Lang = inv.guildId ? (await getGuildConfig(deps.db, inv.guildId))?.language ?? 'en' : 'en';
  if (kind === 'vt' || kind === 'vc' || kind === 'vn' || kind === 'vx') return handleVerificationButton(deps, inv, kind, tk, lang);
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
    const global = await unlinkGlobalSelf(deps.db, { discordUserId: p.userId, guildId: inv.guildId });      // ends the link in EVERY server (audited per server)
    if (global) { let n = 0; for (const g of global.guilds) n += await removeGrantedRoles(deps, g.guildId, p.userId, g.managedRoleIds); return inv.update({ content: t(lang, 'unlink_self_done', { n }) }); }
    const removed = await unlinkWithRoles(deps.db, { guildId: inv.guildId, actorId: p.userId, discordUserId: p.userId, action: 'link.unlinked_self' });   // legacy pending claim only
    if (!removed.length) return inv.update({ content: t(lang, 'unlink_self_none') });
    const n = await removeGrantedRoles(deps, inv.guildId, p.userId, removed.flatMap((x) => x.managedRoleIds));
    return inv.update({ content: t(lang, 'unlink_self_done', { n }) });
  }
  if (kind === 'fl' && p.kind === 'force') {
    if (!inv.canManageGuild) return inv.update({ content: t(lang, 'not_admin') }); // re-checked at click time
    pending.delete(tk!);
    const r = await forceLink(deps.db, { guildId: inv.guildId, adminId: p.adminId, discordUserId: p.targetUserId, playerId: p.playerId, username: p.username, replace: p.replace, ...(p.reason ? { reason: p.reason } : {}) });
    if (!r.ok) return inv.update({ content: t(lang, r.code === 'GLOBAL_CONFLICT' ? 'vt_player_taken' : 'force_conflict') });
    for (const d of r.displaced) for (const g of d.guilds) await removeGrantedRoles(deps, g.guildId, d.discordUserId, g.managedRoleIds);
    return inv.update({ content: t(lang, 'force_done', { user: p.targetUserId, name: p.username ?? p.playerId }) });
  }
  return inv.update({ content: t(lang, 'link_expired') });
}

export type { MsgKey };
