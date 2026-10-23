import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import type { ButtonInvocation, Invocation, Reply } from './handlers.js';

const canManage = (i: { memberPermissions: { has(p: bigint): boolean } | null }) =>
  !!i.memberPermissions && (i.memberPermissions.has(PermissionFlagsBits.ManageGuild) || i.memberPermissions.has(PermissionFlagsBits.Administrator));

function components(r: Reply) {
  if (!r.buttons?.length) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(r.buttons.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.primary ? ButtonStyle.Primary : ButtonStyle.Secondary)))];
}

export function toInvocation(i: ChatInputCommandInteraction): Invocation {
  let used = false; let isPublic = false;
  return {
    guildId: i.guildId, guildName: i.guild?.name ?? '', userId: i.user.id, canManageGuild: canManage(i),
    group: i.commandName, sub: i.options.getSubcommand(false) ?? i.commandName,
    str: (n) => i.options.getString(n) ?? undefined,
    user: (n) => i.options.getUser(n)?.id,
    bool: (n) => i.options.getBoolean(n) ?? undefined,
    defer: async (o) => { if (!i.deferred && !i.replied) { isPublic = o?.public === true; await i.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral }); used = true; } },
    reply: async (r) => {
      const body = { content: r.content, components: components(r), ...(r.embed ? { embeds: [r.embed] } : {}), allowedMentions: { parse: [] as never[] } }; // never ping anyone
      if (i.deferred || i.replied || used) await i.editReply(body);
      else await i.reply({ ...body, flags: MessageFlags.Ephemeral });
    },
  };
}

export function toButtonInvocation(i: ButtonInteraction): ButtonInvocation {
  return {
    guildId: i.guildId, userId: i.user.id, canManageGuild: canManage(i), customId: i.customId,
    update: async (r) => { await i.update({ content: r.content, components: components(r), allowedMentions: { parse: [] } }); },
  };
}
