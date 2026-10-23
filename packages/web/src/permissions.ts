import type { DiscordGuildInfo, DiscordRole } from './discord.js';

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;
const MANAGE_ROLES = 0x10000000n;

/**
 * Who may manage a server's bot settings: the owner, Administrators, or members with Manage Server.
 * (Manage Server is the same permission the bot's own moderator commands require.)
 */
export function canManageGuild(g: Pick<DiscordGuildInfo, 'owner' | 'permissions'>): boolean {
  if (g.owner) return true;
  try { return (BigInt(g.permissions) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n; } catch { return false; }
}

export const isDangerousRole = (r: Pick<DiscordRole, 'permissions'>): boolean => {
  try { return (BigInt(r.permissions) & (ADMINISTRATOR | MANAGE_GUILD | MANAGE_ROLES)) !== 0n; } catch { return true; }
};

/** Can the bot manage this role? (not @everyone, not integration-managed, strictly below the bot, not admin-like) */
export function roleManageability(guildId: string, r: DiscordRole, botTop: number | null): { manageable: boolean; reason: string | null } {
  if (r.id === guildId) return { manageable: false, reason: 'everyone_role' };
  if (r.managed) return { manageable: false, reason: 'integration_managed' };
  if (isDangerousRole(r)) return { manageable: false, reason: 'dangerous_permissions' };
  if (botTop === null) return { manageable: false, reason: 'bot_position_unknown' };
  if (r.position >= botTop) return { manageable: false, reason: 'above_bot_role' };
  return { manageable: true, reason: null };
}
