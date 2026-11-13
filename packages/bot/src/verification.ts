/**
 * Verification tickets (company-name ownership proof). Pure orchestration: every rule that must hold under concurrency lives in the
 * database (`@aon/db` verification-repo); the proof itself is `findCodeInCompanies` over the companies the GAME API returned for the
 * attempt's player. A name typed by the member, or a claim of ownership, is never evidence.
 */
import { audit, beginCheck, cancelAttempt, completeVerification, createAttempt, endCheck, ensureGuildLink, getAttempt, getGlobalLinkForUser, getGuildConfig, getPendingAttemptForUser } from '@aon/db';
import { findCodeInCompanies, VERIFICATION } from '@aon/core';
import { syncOneUser } from '@aon/sync';
import type { BotDeps, Reply } from './handlers.js';
import { t, type Lang } from './messages.js';
import { describeSync, esc, gameFailure, removeGrantedRoles, syncDeps } from './shared.js';

export interface VerifyCtx { deps: BotDeps; guildId: string; userId: string }
const nowOf = (d: BotDeps) => (d.now ?? (() => new Date()))();
const langOf = async (c: VerifyCtx): Promise<Lang> => (await getGuildConfig(c.deps.db, c.guildId))?.language ?? 'en';
const ticketButtons = (lang: Lang, id: string): NonNullable<Reply['buttons']> => [
  { id: `vc:${id}`, label: t(lang, 'vt_check_btn'), primary: true }, { id: `vn:${id}`, label: t(lang, 'vt_new_btn') }, { id: `vx:${id}`, label: t(lang, 'vt_close_btn') },
];

async function syncNote(c: VerifyCtx, lang: Lang): Promise<string> {
  try {
    const s = await syncOneUser(syncDeps(c.deps), c.guildId, c.userId);
    if (!('error' in s) && (s.outcome === 'updated' || s.outcome === 'unchanged' || s.outcome === 'partial')) return `${t(lang, 'link_synced_note')} ${describeSync(lang, s)}`;
  } catch { /* the link is already saved; roles follow at the next sync */ }
  return t(lang, 'link_sync_later');
}

/** Opens a ticket (`/verify`, the panel button, or `/link`). A member who is already verified just gets this server's roles. */
export async function openTicket(c: VerifyCtx, username: string | undefined): Promise<Reply> {
  const lang = await langOf(c); const now = nowOf(c.deps);
  const global = await getGlobalLinkForUser(c.deps.db, c.userId);
  if (global) {
    await ensureGuildLink(c.deps.db, { guildId: c.guildId, discordUserId: c.userId });            // explicit use of the bot in this server: no second verification
    return { content: t(lang, 'vt_already_linked', { name: esc(global.username ?? global.playerId), id: global.playerId, sync: await syncNote(c, lang) }) };
  }
  const open = await getPendingAttemptForUser(c.deps.db, c.userId, now);
  if (open && !username) return { content: t(lang, 'vt_existing', { name: esc(open.playerUsername ?? open.playerId) }), buttons: ticketButtons(lang, open.id) };
  if (!username?.trim()) return { content: t(lang, 'vt_failed_generic') };
  const res = await c.deps.game.playerByName(username);
  const fail = gameFailure(lang, res);
  if (fail || res.status !== 'ok') return { content: fail ?? t(lang, 'api_down') };
  return create(c, lang, res.data.id, res.data.username);
}

async function create(c: VerifyCtx, lang: Lang, playerId: string, username: string | null): Promise<Reply> {
  const r = await createAttempt(c.deps.db, { guildId: c.guildId, discordUserId: c.userId, playerId, username, now: nowOf(c.deps) });
  if (!r.ok) {
    if (r.code === 'ALREADY_LINKED_SELF') return openTicket(c, undefined);
    if (r.code === 'USER_LINKED_OTHER') { const g = await getGlobalLinkForUser(c.deps.db, c.userId); return { content: t(lang, 'vt_user_linked_other', { name: esc(g?.username ?? g?.playerId ?? '?') }) }; }
    return { content: t(lang, r.code === 'PLAYER_LINKED_OTHER' ? 'vt_player_taken' : 'vt_rate_limited') };
  }
  return { content: t(lang, 'vt_instructions', { name: esc(username ?? playerId), id: playerId, code: r.code, exp: `<t:${Math.floor(r.expiresAt.getTime() / 1000)}:R>` }), buttons: ticketButtons(lang, r.attemptId) };
}

/** "Check verification". Order matters: ownership/expiry/limits (database) -> real API data -> proof -> one transaction. */
export async function checkTicket(c: VerifyCtx, attemptId: string): Promise<Reply> {
  const lang = await langOf(c); const now = nowOf(c.deps);
  const gate = await beginCheck(c.deps.db, { attemptId, discordUserId: c.userId, now });
  if (!gate.ok) {
    if (gate.code === 'TOO_SOON') return { content: t(lang, 'vt_too_soon', { s: Math.ceil((gate.retryAfterMs ?? 0) / 1000) }), buttons: ticketButtons(lang, attemptId) };
    return { content: t(lang, gate.code === 'EXPIRED' ? 'vt_expired' : gate.code === 'LOCKED' ? 'vt_locked' : 'vt_gone') };
  }
  const at = gate.attempt;
  const res = await c.deps.game.playerCompanies(at.playerId);
  if (res.status !== 'ok') {
    if (res.status === 'not_found') { await endCheck(c.deps.db, at.id, 'player_missing'); return { content: t(lang, 'vt_player_missing'), buttons: ticketButtons(lang, at.id) }; }
    if (res.status === 'incomplete') {
      await endCheck(c.deps.db, at.id, 'incomplete_data');
      await audit(c.deps.db, { guildId: c.guildId, actor: c.userId, action: 'verification.api_incomplete', target: at.playerId, details: { attemptId: at.id, missing: res.missing.slice(0, 5) } });   // visible in the dashboard audit: tells an operator the response shape is not what the bot expects
      return { content: t(lang, 'vt_incomplete'), buttons: ticketButtons(lang, at.id) };
    }
    await endCheck(c.deps.db, at.id, 'api_down');
    return { content: t(lang, 'vt_api_down'), buttons: ticketButtons(lang, at.id) };
  }
  const match = findCodeInCompanies(at.id, at.codeHash, res.data.companies);
  if (!match.found) {
    await endCheck(c.deps.db, at.id, 'code_not_found');
    return { content: t(lang, 'vt_not_found', { left: Math.max(0, VERIFICATION.maxChecks - at.checkCount) }), buttons: ticketButtons(lang, at.id) };
  }
  const done = await completeVerification(c.deps.db, { attemptId: at.id, discordUserId: c.userId, companyId: match.companyId, now: nowOf(c.deps) });
  if (!done.ok) {
    if (done.code === 'PLAYER_LINKED_OTHER') return { content: t(lang, 'vt_player_taken') };
    if (done.code === 'USER_LINKED_OTHER') { const g = await getGlobalLinkForUser(c.deps.db, c.userId); return { content: t(lang, 'vt_user_linked_other', { name: esc(g?.username ?? g?.playerId ?? '?') }) }; }
    return { content: t(lang, done.code === 'EXPIRED' ? 'vt_expired' : 'vt_gone') };
  }
  if (done.displaced) for (const g of done.displaced.guilds) await removeGrantedRoles(c.deps, g.guildId, done.displaced.discordUserId, g.managedRoleIds);   // the unproven claimant loses what that claim granted
  return { content: t(lang, 'vt_ok', { name: esc(at.playerUsername ?? at.playerId), sync: await syncNote(c, lang) }) };
}

/** "New code": same game account, fresh code (the old one stops working). */
export async function newCode(c: VerifyCtx, attemptId: string): Promise<Reply> {
  const lang = await langOf(c);
  const old = await getAttempt(c.deps.db, attemptId);
  if (!old || old.discordUserId !== c.userId) return { content: t(lang, 'vt_gone') };
  return create(c, lang, old.playerId, old.playerUsername);
}
export async function closeTicket(c: VerifyCtx, attemptId: string): Promise<Reply> {
  const lang = await langOf(c);
  return { content: t(lang, (await cancelAttempt(c.deps.db, { attemptId, discordUserId: c.userId, now: nowOf(c.deps) })) ? 'vt_closed' : 'vt_gone') };
}
