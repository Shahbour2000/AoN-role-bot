import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction } from 'discord.js';
import type { ButtonInvocation, Invocation, ModalInvocation, Reply } from './handlers.js';

const canManage = (i: { memberPermissions: { has(p: bigint): boolean } | null }) =>
  !!i.memberPermissions && (i.memberPermissions.has(PermissionFlagsBits.ManageGuild) || i.memberPermissions.has(PermissionFlagsBits.Administrator));

export function components(r: Reply) {
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
  let deferredUpdate = false;
  const body = (r: Reply) => ({ content: r.content, components: components(r), allowedMentions: { parse: [] as never[] } });
  return {
    guildId: i.guildId, userId: i.user.id, canManageGuild: canManage(i), customId: i.customId,
    update: async (r) => { if (deferredUpdate) await i.editReply(body(r)); else await i.update(body(r)); },
    deferUpdate: async () => { await i.deferUpdate(); deferredUpdate = true; },
    deferReply: async () => { await i.deferReply({ flags: MessageFlags.Ephemeral }); },
    reply: async (r) => { if (i.deferred || i.replied) await i.editReply(body(r)); else await i.reply({ ...body(r), flags: MessageFlags.Ephemeral }); },
    showModal: async (m) => {
      await i.showModal(new ModalBuilder().setCustomId(m.id).setTitle(m.title).addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(m.fieldId).setLabel(m.label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(m.maxLength))));
    },
  };
}

export function toModalInvocation(i: ModalSubmitInteraction): ModalInvocation {
  const body = (r: Reply) => ({ content: r.content, components: components(r), allowedMentions: { parse: [] as never[] } });
  return {
    guildId: i.guildId, userId: i.user.id, customId: i.customId, field: (id) => i.fields.getTextInputValue(id).trim(),
    deferReply: async () => { await i.deferReply({ flags: MessageFlags.Ephemeral }); },
    reply: async (r) => { if (i.deferred || i.replied) await i.editReply(body(r)); else await i.reply({ ...body(r), flags: MessageFlags.Ephemeral }); },
  };
}
