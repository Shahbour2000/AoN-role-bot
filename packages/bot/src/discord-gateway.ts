import { DiscordAPIError, PermissionFlagsBits, type Client } from 'discord.js';
import type { DiscordGateway, MemberRoles } from '@aon/sync';

/** Roles carrying these permissions are never handed out or removed by the bot, even if an admin maps them. */
const DANGEROUS = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles;

export class DiscordJsGateway implements DiscordGateway {
  constructor(private readonly client: Client) {}

  async getMemberRoles(guildId: string, userId: string): Promise<MemberRoles> {
    try {
      const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId));
      const m = await guild.members.fetch({ user: userId, force: true });
      return { status: 'ok', roleIds: new Set(m.roles.cache.keys()) };
    } catch (e) {
      if (e instanceof DiscordAPIError && e.code === 10007) return { status: 'absent' }; // Unknown Member
      return { status: 'error', message: e instanceof Error ? e.message.slice(0, 80) : 'unknown' };
    }
  }

  async assignableRoles(guildId: string): Promise<ReadonlySet<string>> {
    const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId));
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return new Set();
    const top = me.roles.highest;
    const ok = new Set<string>();
    for (const role of (await guild.roles.fetch()).values()) {
      if (role.id === guild.id || role.managed) continue;                 // @everyone, bot/integration roles
      if (role.comparePositionTo(top) >= 0) continue;                      // hierarchy: must be strictly below the bot's top role
      if (role.permissions.bitfield & DANGEROUS) continue;                 // never hand out admin-like roles
      ok.add(role.id);
    }
    return ok;
  }

  async addRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const m = await (await this.client.guilds.fetch(guildId)).members.fetch(userId);
    await m.roles.add(roleId, reason);
  }
  async removeRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const m = await (await this.client.guilds.fetch(guildId)).members.fetch(userId);
    await m.roles.remove(roleId, reason);
  }
}
