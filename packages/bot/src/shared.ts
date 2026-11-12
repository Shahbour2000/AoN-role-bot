import type { Fetched } from '@aon/core';
import type { UserSyncResult, GuildSyncDeps } from '@aon/sync';
import { t, type Lang } from './messages.js';
import type { BotDeps } from './handlers.js';

/** Takes the roles the bot had granted off a member who was unlinked. Only roles the bot is currently able to manage are touched. */
export async function removeGrantedRoles(deps: BotDeps, guildId: string, userId: string, roleIds: string[]): Promise<number> {
  if (!roleIds.length) return 0;
  const assignable = await deps.discord.assignableRoles(guildId).catch(() => new Set<string>());
  let n = 0;
  for (const r of roleIds) {
    if (!assignable.has(r)) continue;
    try { await deps.discord.removeRole(guildId, userId, r, 'AoN role bot: account unlinked'); n++; } catch (e) { deps.log?.(`unlink cleanup: could not remove ${r} from ${userId}: ${e instanceof Error ? e.message.slice(0, 80) : 'error'}`); }
  }
  return n;
}

export const esc = (x: string): string => x.replace(/[\\*_~`|>[\]()#-]/g, (c) => `\\${c}`).replace(/@/g, '@\u200b');
export const roleList = (ids: string[]) => (ids.length ? ids.map((r) => `<@&${r}>`).join(' ') : '—');

export function describeSync(lang: Lang, r: UserSyncResult): string {
  const parts: string[] = [];
  if (r.outcome === 'failed') return t(lang, 'sync_failed');
  if (r.outcome === 'skipped') return t(lang, 'sync_skipped_member');
  if (r.added.length || r.removed.length) parts.push(t(lang, 'sync_done', { added: roleList(r.added), removed: roleList(r.removed) }));
  else if (r.outcome === 'unchanged') parts.push(t(lang, 'sync_nochange'));
  if (r.outcome === 'partial') parts.push(t(lang, 'sync_partial'));
  if (r.blocked.length) parts.push(t(lang, 'sync_blocked', { n: r.blocked.length }));
  return parts.join('\n') || t(lang, 'sync_nochange');
}

export function gameFailure(lang: Lang, res: Fetched<unknown>): string | null {
  if (res.status === 'ok') return null;
  return res.status === 'not_found' ? t(lang, 'player_not_found') : t(lang, 'api_down');
}

export function syncDeps(deps: BotDeps): GuildSyncDeps {
  return { db: deps.db, game: deps.game, discord: deps.discord, ...(deps.now ? { now: deps.now } : {}), ...(deps.log ? { log: deps.log } : {}) };
}
