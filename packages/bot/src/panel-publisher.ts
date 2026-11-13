import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, DiscordAPIError, EmbedBuilder, PermissionFlagsBits, type Client } from 'discord.js';
import type { PanelMessage, PanelButtonStyle } from '@aon/core';
import { PanelPublishError, type PanelPublisher } from '@aon/sync';

const STYLE: Record<PanelButtonStyle, ButtonStyle> = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
const NEED_POST = ['ViewChannel', 'SendMessages', 'EmbedLinks'] as const;
const NEED_EDIT = ['ViewChannel', 'ReadMessageHistory', 'EmbedLinks'] as const;

/** The exact message sent to Discord. Mentions are always disabled: nothing an administrator types into the panel can ping anyone. */
export function buildPanelPayload(m: PanelMessage) {
  const embed = new EmbedBuilder().setTitle(m.embed.title).setDescription(m.embed.description).setColor(m.embed.color);
  if (m.embed.footer) embed.setFooter({ text: m.embed.footer });
  if (m.embed.thumbnailUrl) embed.setThumbnail(m.embed.thumbnailUrl);
  const button = new ButtonBuilder().setCustomId(m.button.customId).setLabel(m.button.label).setStyle(STYLE[m.button.style]);
  if (m.button.emoji) button.setEmoji(m.button.emoji.kind === 'unicode' ? m.button.emoji.name : { id: m.button.emoji.id, name: m.button.emoji.name, animated: m.button.emoji.animated });
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)], allowedMentions: { parse: [] as never[] } };
}

const code = (e: unknown) => (e instanceof DiscordAPIError ? Number(e.code) : null);

/** discord.js implementation of the panel port. Every call re-checks that the channel belongs to the server it was requested for. */
export function createDiscordPanelPublisher(client: Client): PanelPublisher {
  async function channel(guildId: string, channelId: string, need: readonly (keyof typeof PermissionFlagsBits)[]) {
    let ch;
    try { ch = await client.channels.fetch(channelId); } catch (e) { throw new PanelPublishError(code(e) === 50001 || code(e) === 50013 ? 'missing_permissions' : 'channel_unavailable', code(e) === 50001 ? ['ViewChannel'] : []); }
    if (!ch || ch.isDMBased() || !('guildId' in ch) || ch.guildId !== guildId) throw new PanelPublishError('channel_unavailable');   // never act in another server's channel
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) throw new PanelPublishError('channel_unavailable');
    const me = ch.guild.members.me ?? (await ch.guild.members.fetchMe().catch(() => null));
    const perms = me ? ch.permissionsFor(me) : null;
    const missing = perms ? perms.missing(need.map((n) => PermissionFlagsBits[n])) : [...need];
    if (missing.length) throw new PanelPublishError('missing_permissions', missing.map(String));
    return ch;
  }
  const mapError = (e: unknown): never => {
    if (e instanceof PanelPublishError) throw e;
    if (code(e) === 50013 || code(e) === 50001) throw new PanelPublishError('missing_permissions');
    if (code(e) === 10003) throw new PanelPublishError('channel_unavailable');
    throw new PanelPublishError('discord_error');
  };
  const ownMessage = async (ch: Awaited<ReturnType<typeof channel>>, id: string) => {
    try { const m = await ch.messages.fetch(id); return m.author.id === client.user?.id ? m : null; }       // never touch a message the bot did not post
    catch (e) { if (code(e) === 10008) return null; throw e; }
  };
  return {
    async post(guildId, channelId, message) {
      try { const ch = await channel(guildId, channelId, NEED_POST); const sent = await ch.send(buildPanelPayload(message)); return { messageId: sent.id }; } catch (e) { return mapError(e); }
    },
    async edit(guildId, channelId, messageId, message) {
      try { const ch = await channel(guildId, channelId, NEED_EDIT); const m = await ownMessage(ch, messageId); if (!m) return false; await m.edit(buildPanelPayload(message)); return true; }
      catch (e) { if (code(e) === 10008) return false; return mapError(e); }
    },
    async remove(guildId, channelId, messageId) {
      try { const ch = await channel(guildId, channelId, ['ViewChannel', 'ReadMessageHistory']); const m = await ownMessage(ch, messageId); if (m) await m.delete(); }
      catch (e) { if (code(e) === 10008 || code(e) === 10003 || (e instanceof PanelPublishError && e.code === 'channel_unavailable')) return; mapError(e); }   // old channel/message already gone: nothing to remove
    },
  };
}
