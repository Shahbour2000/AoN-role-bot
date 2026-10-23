import type { Fetched } from '@aon/core';
import type { CitizensIndex, GovernmentRoster, PlayerProfile } from '@aon/client';

/** What the sync engine needs from the game API (AonClient satisfies this). */
export interface GameData {
  governmentRoster(countryId: string): Promise<Fetched<GovernmentRoster>>;
  /** Complete citizen list (all pages) or a non-ok result; never a partial list. */
  countryCitizens(countryId: string): Promise<Fetched<CitizensIndex>>;
  playerProfile(userId: string): Promise<Fetched<PlayerProfile>>;
  playerAllTimeDamage(userId: string): Promise<Fetched<number>>;
}

export type MemberRoles = { status: 'ok'; roleIds: ReadonlySet<string> } | { status: 'absent' } | { status: 'error'; message: string };

/** What the sync engine needs from Discord. The discord.js adapter implements this. */
export interface DiscordGateway {
  getMemberRoles(guildId: string, userId: string): Promise<MemberRoles>;
  /** Roles the bot may assign/remove right now (Manage Roles + below its top role + not managed/@everyone). */
  assignableRoles(guildId: string): Promise<ReadonlySet<string>>;
  addRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;
}
