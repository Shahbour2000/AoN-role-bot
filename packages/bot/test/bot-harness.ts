import type { Fetched } from '@aon/core';
import type { PlayerIdentity, ProfileCard, StatsCard } from '@aon/client';
import { updateGuildSettings } from '@aon/db';
import { setup, FakeGame, FakeDiscord, rosterOf, ROLE } from '../../sync/test/harness.js';
import type { BotDeps, ButtonInvocation, Invocation, Reply } from '../src/index.js';
export { rosterOf, ROLE };

export class BotGame extends FakeGame {
  names = new Map<string, Fetched<PlayerIdentity>>();
  cards = new Map<string, { profile: Fetched<ProfileCard>; stats: Fetched<StatsCard> }>();
  cardRequests = 0;
  async playerCard(id: string) { this.cardRequests++; return this.cards.get(id) ?? { profile: { status: 'not_found' as const }, stats: { status: 'not_found' as const } }; }
  async playerByName(u: string) { return this.names.get(u.toLowerCase()) ?? ({ status: 'not_found' } as const); }
  override async playerProfile(id: string) { return (await super.playerProfile(id)) as never; }
}
export async function botSetup(opts: { guilds?: string[]; staff?: boolean } = {}) {
  const base = await setup(opts);
  // New guilds default to Arabic; the bulk of these tests assert English text, so pin English explicitly.
  for (const g of opts.guilds ?? ['A']) await updateGuildSettings(base.db, g, { language: 'en', ...(opts.staff ? { require_staff_approval: true } : {}) }, null);
  const game = new BotGame(); game.roster = base.game.roster;
  const deps: BotDeps = { db: base.db, game: game as never, discord: base.discord as FakeDiscord, cooldownMs: 0 };
  return { ...base, game, deps };
}

export function inv(o: Partial<{ guildId: string | null; userId: string; admin: boolean; group: string; sub: string; str: Record<string, string>; user: Record<string, string>; bool: Record<string, boolean> }> = {}) {
  const replies: Reply[] = []; const deferred: ({ public?: boolean } | undefined)[] = [];
  const i: Invocation = {
    guildId: o.guildId === undefined ? 'A' : o.guildId, guildName: 'Guild A', userId: o.userId ?? 'u1', canManageGuild: o.admin ?? false,
    group: o.group ?? 'link', sub: o.sub ?? (o.group ?? 'link'),
    str: (n) => o.str?.[n], user: (n) => o.user?.[n], bool: (n) => o.bool?.[n],
    defer: async (opts) => { deferred.push(opts); }, reply: async (r) => { replies.push(r); },
  };
  return { i, replies, deferred, last: () => replies[replies.length - 1]! };
}
export function click(customId: string, o: { userId?: string; admin?: boolean; guildId?: string | null } = {}) {
  const updates: Reply[] = [];
  const b: ButtonInvocation = { guildId: o.guildId === undefined ? 'A' : o.guildId, userId: o.userId ?? 'u1', canManageGuild: o.admin ?? false, customId, update: async (r) => { updates.push(r); } };
  return { b, last: () => updates[updates.length - 1]! };
}
export const player = (id: string, username: string): Fetched<PlayerIdentity> => ({ status: 'ok', data: { id, username } });
