import { ButtonStyle, ChannelType, DiscordAPIError, PermissionFlagsBits, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { EMPTY_PANEL, PANEL_BUTTON_ID, resolvePanel } from '@aon/core';
import { PanelPublishError } from '@aon/sync';
import { buildPanelPayload, createDiscordPanelPublisher } from '../src/panel-publisher.js';

/** Structural fakes of the discord.js objects the adapter touches. They check what the adapter SENDS; they are not Discord. */
const apiErr = (code: number) => new DiscordAPIError({ code, message: 'x' } as never, code, 400, 'GET', '/x', {} as never);
interface FakeMsg { id: string; author: { id: string }; edits: unknown[]; deleted: boolean; edit(p: unknown): Promise<unknown>; delete(): Promise<void> }
function world(o: { guildId?: string; type?: ChannelType; missing?: string[]; me?: boolean } = {}) {
  const msgs = new Map<string, FakeMsg>(); const sent: unknown[] = []; let n = 0;
  const add = (author: string) => { const m: FakeMsg = { id: `m${++n}`, author: { id: author }, edits: [], deleted: false, async edit(p) { this.edits.push(p); return this; }, async delete() { this.deleted = true; msgs.delete(this.id); } }; msgs.set(m.id, m); return m; };
  const channel = {
    id: 'c1', guildId: o.guildId ?? 'G1', type: o.type ?? ChannelType.GuildText, isDMBased: () => false,
    guild: { members: { me: o.me === false ? null : { id: 'bot' }, fetchMe: async () => { throw new Error('no'); } } },
    permissionsFor: () => ({ missing: (need: bigint[]) => (o.missing ?? []).filter((m) => need.includes((PermissionFlagsBits as never as Record<string, bigint>)[m]!)) }),
    messages: { fetch: async (id: string) => { const m = msgs.get(id); if (!m) throw apiErr(10008); return m; } },
    send: async (p: unknown) => { sent.push(p); return add('bot'); },
  };
  const client = { user: { id: 'bot' }, channels: { fetch: async (id: string) => { if (id === 'gone') throw apiErr(10003); if (id === 'hidden') throw apiErr(50001); return id === 'c1' ? channel : null; } } } as unknown as Client;
  return { client, sent, msgs, add, pub: createDiscordPanelPublisher(client) };
}
const M = resolvePanel({ ...EMPTY_PANEL, title: 'طلب الجنسية', buttonLabel: 'طلب الجنسية', buttonEmoji: '🇪🇬', buttonStyle: 'success', color: 0x00ff7f, footer: 'EG', thumbnailUrl: 'https://cdn.example.com/a.png' }, 'ar');

describe('payload sent to Discord', () => {
  it('embed has the configured title/description/colour/footer/thumbnail; one button with the configured label, emoji and style and the fixed ticket id', () => {
    const p = buildPanelPayload(M); const e = p.embeds[0]!.toJSON(); const b = (p.components[0]!.toJSON().components[0]) as { custom_id: string; label: string; style: number; emoji: { name: string } };
    expect(e).toMatchObject({ title: 'طلب الجنسية', color: 0x00ff7f, footer: { text: 'EG' }, thumbnail: { url: 'https://cdn.example.com/a.png' } }); expect(e.description).toContain('Age of Nations');
    expect(p.components).toHaveLength(1); expect(p.components[0]!.components).toHaveLength(1);
    expect(b).toMatchObject({ custom_id: PANEL_BUTTON_ID, label: 'طلب الجنسية', style: ButtonStyle.Success, emoji: { name: '🇪🇬' } });
    expect(p.allowedMentions).toEqual({ parse: [] });
  });
  it('custom and animated emoji are sent as id/name/animated; no emoji and no footer/thumbnail are simply omitted', () => {
    const c = buildPanelPayload(resolvePanel({ ...EMPTY_PANEL, buttonEmoji: '<a:spin:123456789012345678>' }, 'en')).components[0]!.toJSON().components[0] as { emoji: unknown };
    expect(c.emoji).toEqual({ id: '123456789012345678', name: 'spin', animated: true });
    const d = buildPanelPayload(resolvePanel(EMPTY_PANEL, 'en')); const e = d.embeds[0]!.toJSON();
    expect(e.footer).toBeUndefined(); expect(e.thumbnail).toBeUndefined(); expect((d.components[0]!.toJSON().components[0] as { emoji?: unknown }).emoji).toBeUndefined();
  });
  it.each(['primary', 'secondary', 'success', 'danger'] as const)('button style %s maps to the Discord style', (s) => {
    const b = buildPanelPayload(resolvePanel({ ...EMPTY_PANEL, buttonStyle: s }, 'en')).components[0]!.toJSON().components[0] as { style: number };
    expect(b.style).toBe({ primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger }[s]);
  });
});

describe('discord.js panel publisher', () => {
  it('post sends the panel and returns the message id', async () => { const w = world(); expect(await w.pub.post('G1', 'c1', M)).toEqual({ messageId: 'm1' }); expect(w.sent).toHaveLength(1); });
  it('refuses a channel that belongs to ANOTHER server, a channel that does not exist, and a non-text channel', async () => {
    await expect(world({ guildId: 'OTHER' }).pub.post('G1', 'c1', M)).rejects.toMatchObject({ code: 'channel_unavailable' });
    await expect(world().pub.post('G1', 'nope', M)).rejects.toMatchObject({ code: 'channel_unavailable' });
    await expect(world().pub.post('G1', 'gone', M)).rejects.toMatchObject({ code: 'channel_unavailable' });
    await expect(world({ type: ChannelType.GuildVoice }).pub.post('G1', 'c1', M)).rejects.toMatchObject({ code: 'channel_unavailable' });
    await expect(world().pub.post('G1', 'hidden', M)).rejects.toMatchObject({ code: 'missing_permissions' });
  });
  it('lists the permissions the bot is missing, and sends nothing', async () => {
    const w = world({ missing: ['SendMessages', 'EmbedLinks'] }); const e = await w.pub.post('G1', 'c1', M).catch((x) => x);
    expect(e).toBeInstanceOf(PanelPublishError); expect(e.code).toBe('missing_permissions'); expect(e.missing.sort()).toEqual(['EmbedLinks', 'SendMessages']); expect(w.sent).toHaveLength(0);
  });
  it('edit changes the bot\'s own message; a deleted message returns false; someone else\'s message is never edited', async () => {
    const w = world(); const mine = w.add('bot'); const theirs = w.add('someone-else');
    expect(await w.pub.edit('G1', 'c1', mine.id, M)).toBe(true); expect(mine.edits).toHaveLength(1);
    expect(await w.pub.edit('G1', 'c1', 'm999', M)).toBe(false);
    expect(await w.pub.edit('G1', 'c1', theirs.id, M)).toBe(false); expect(theirs.edits).toHaveLength(0);
  });
  it('remove deletes only the bot\'s own message and is silent when it is already gone', async () => {
    const w = world(); const mine = w.add('bot'); const theirs = w.add('someone-else');
    await w.pub.remove('G1', 'c1', mine.id); expect(mine.deleted).toBe(true);
    await w.pub.remove('G1', 'c1', theirs.id); expect(theirs.deleted).toBe(false);
    await expect(w.pub.remove('G1', 'c1', 'm404')).resolves.toBeUndefined(); await expect(w.pub.remove('G1', 'gone', 'm1')).resolves.toBeUndefined();
  });
  it('Discord API errors on send become typed failures (50013 -> missing permissions, anything else -> discord_error)', async () => {
    const w = world(); const ch = await (w.client.channels.fetch('c1') as Promise<{ send: (p: unknown) => Promise<unknown> }>);
    ch.send = async () => { throw apiErr(50013); }; await expect(w.pub.post('G1', 'c1', M)).rejects.toMatchObject({ code: 'missing_permissions' });
    ch.send = async () => { throw new Error('socket hang up'); }; await expect(w.pub.post('G1', 'c1', M)).rejects.toMatchObject({ code: 'discord_error' });
  });
});
