import { describe, expect, it } from 'vitest';
import { PANEL_DEFAULTS } from '@aon/core';
import { getGuildConfig, getPanel, updateGuildSettings } from '@aon/db';
import { PanelPublishError } from '@aon/sync';
import { ADMIN, MANAGE_GUILD, SEND_ONLY, get, guildInfo, login, makeApp, mut } from './harness.js';

const G1 = '100000001', G2 = '100000002';
async function ctx(perm: string = ADMIN) {
  const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, perm), guildInfo(G2, SEND_ONLY)]);
  c.bot.channels.set(G1, [{ id: '700001', name: 'verify-here', type: 0, position: 2 }, { id: '700002', name: 'voice', type: 2, position: 1 }, { id: '700003', name: 'news', type: 5, position: 3 }]);
  c.bot.channels.set(G2, [{ id: '800001', name: 'other-server', type: 0, position: 1 }]);
  await updateGuildSettings(c.db, G1, { language: 'en' }, null);
  return { c, l };
}
const P = (g = G1) => `/api/guilds/${g}/verification/panel`;
const setCh = (c: Awaited<ReturnType<typeof ctx>>['c'], l: Awaited<ReturnType<typeof ctx>>['l'], ch: string | null) => mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: ch });
const FULL = { title: 'طلب الجنسية', description: 'اضغط الزر\nلفتح تذكرة', footer: 'EG', color: '#00FF7F', thumbnailUrl: 'https://cdn.example.com/eg.png', buttonLabel: 'طلب الجنسية', buttonEmoji: '🇪🇬', buttonStyle: 'success', language: 'ar' };

describe('panel settings API', () => {
  it('a server that never customised gets the defaults, the limits, and "not published"', async () => {
    const { c, l } = await ctx(); const r = await get(c, l, P()); expect(r.statusCode).toBe(200); const j = r.json();
    expect(j.settings).toMatchObject({ title: null, buttonStyle: null, color: null }); expect(j.preview.embed.title).toBe(PANEL_DEFAULTS.en.title); expect(j.published).toBeNull();
    expect(j.limits.title).toBe(256); expect(j.styles).toEqual(['primary', 'secondary', 'success', 'danger']); expect(j.canPublish).toBe(true); expect(j.channelId).toBeNull();
  });
  it('saves every setting, returns the resolved preview and keeps them after a reload (stored in the database)', async () => {
    const { c, l } = await ctx(); const r = await mut(c, l, 'PUT', P(), FULL); expect(r.statusCode).toBe(200);
    expect(r.json().preview).toMatchObject({ embed: { title: 'طلب الجنسية', color: 0x00ff7f, footer: 'EG' }, button: { label: 'طلب الجنسية', style: 'success', emoji: { kind: 'unicode', name: '🇪🇬' }, customId: 'vt:open' } });
    expect((await get(c, l, P())).json().settings).toEqual({ ...FULL, color: 0x00ff7f });
    expect((await getPanel(c.db, G1)).settings.title).toBe('طلب الجنسية');
  });
  it('blank fields go back to the defaults; saving an empty object resets everything', async () => {
    const { c, l } = await ctx(); await mut(c, l, 'PUT', P(), FULL);
    await mut(c, l, 'PUT', P(), { ...FULL, title: '  ', buttonEmoji: '', color: '' }); const j = (await get(c, l, P())).json();
    expect(j.settings).toMatchObject({ title: null, buttonEmoji: null, color: null, buttonLabel: 'طلب الجنسية' });
    await mut(c, l, 'PUT', P(), {}); expect((await get(c, l, P())).json().settings).toMatchObject({ title: null, buttonLabel: null, footer: null, language: null });
  });
  it('rejects invalid input with field-level issues and saves NOTHING (all-or-nothing)', async () => {
    const { c, l } = await ctx(); await mut(c, l, 'PUT', P(), { title: 'Keep' });
    const r = await mut(c, l, 'PUT', P(), { title: 'ok', color: 'red', buttonEmoji: 'abc', buttonStyle: 'link', thumbnailUrl: 'http://x.y/a.png', buttonLabel: 'x'.repeat(81) });
    expect(r.statusCode).toBe(422); expect(r.json().error).toBe('validation');
    expect((r.json().issues as { field: string }[]).map((i) => i.field).sort()).toEqual(['buttonEmoji', 'buttonLabel', 'buttonStyle', 'color', 'thumbnailUrl']);
    expect((await get(c, l, P())).json().settings.title).toBe('Keep');
  });
  it('ignores attempts to smuggle a custom id or a URL button', async () => {
    const { c, l } = await ctx(); await mut(c, l, 'PUT', P(), { title: 'T', customId: 'evil:1', url: 'https://evil.example' });
    expect((await get(c, l, P())).json().preview.button.customId).toBe('vt:open');
  });
  it('writes need the CSRF token and a same-origin request; reads and writes need Manage Server in THAT server; servers are isolated', async () => {
    const { c, l } = await ctx();
    expect((await c.app.inject({ method: 'PUT', url: P(), cookies: l.cookies, headers: { origin: 'https://evil.example', 'x-csrf-token': l.csrf }, payload: { title: 'x' } })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'PUT', url: P(), cookies: l.cookies, headers: { origin: l.headers.origin }, payload: { title: 'x' } })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'PUT', url: P(), payload: { title: 'x' } })).statusCode).toBe(401);
    expect((await get(c, l, P(G2))).statusCode).toBe(403); expect((await mut(c, l, 'PUT', P(G2), { title: 'x' })).statusCode).toBe(403); expect((await mut(c, l, 'POST', `${P(G2)}/publish`, {})).statusCode).toBe(403);
    expect((await getPanel(c.db, G2)).settings.title).toBeNull(); expect(c.panel.calls).toEqual([]);
    expect((await get(c, l, `/api/guilds/${G1}/verification/panel`)).statusCode).toBe(200);
  });
  it('Manage Server (without Administrator) is enough; a plain member is refused', async () => {
    const m = await ctx(MANAGE_GUILD); expect((await mut(m.c, m.l, 'PUT', P(), { title: 'x' })).statusCode).toBe(200);
    const n = await ctx(SEND_ONLY); expect((await mut(n.c, n.l, 'PUT', P(), { title: 'x' })).statusCode).toBe(403); expect((await get(n.c, n.l, P())).statusCode).toBe(403);
  });
  it('saving is audited with the actor and field names only (never the text)', async () => {
    const { c, l } = await ctx(); await mut(c, l, 'PUT', P(), { title: 'PRIVATE WORDING', color: '#112233' });
    const ev = (await c.db.query<{ actor_discord_id: string; details: { customized: string[] } }>(`SELECT actor_discord_id, details FROM audit_events WHERE guild_id=$1 AND action='verification.panel_updated'`, [G1])).rows;
    expect(ev).toHaveLength(1); expect(ev[0]!.actor_discord_id).toBe('42'); expect(ev[0]!.details.customized.sort()).toEqual(['color', 'title']); expect(JSON.stringify(ev)).not.toContain('PRIVATE WORDING');
  });
});

describe('panel publish API', () => {
  it('needs a configured channel', async () => {
    const { c, l } = await ctx(); const r = await mut(c, l, 'POST', `${P()}/publish`, {}); expect(r.statusCode).toBe(409); expect(r.json().error).toBe('no_channel'); expect(c.panel.calls).toEqual([]);
  });
  it('publishes the saved (customised) panel into the configured channel and reports where it is', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); await mut(c, l, 'PUT', P(), FULL);
    const r = await mut(c, l, 'POST', `${P()}/publish`, {}); expect(r.statusCode).toBe(200); const j = r.json();
    expect(j.result).toMatchObject({ action: 'posted', channelId: '700001', messageId: '90001', url: `https://discord.com/channels/${G1}/700001/90001` });
    expect(c.panel.messages.get('90001')).toMatchObject({ guildId: G1, channelId: '700001' }); expect(c.panel.messages.get('90001')!.message.embed.title).toBe('طلب الجنسية');
    expect(j.panel.published).toMatchObject({ channelId: '700001', messageId: '90001', upToDate: true, publishedBy: '42' });
  });
  it('publishing again edits the same message (no duplicate); an edit of the settings makes the live panel "out of date" until republished', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); await mut(c, l, 'POST', `${P()}/publish`, {});
    await mut(c, l, 'PUT', P(), { title: 'Changed' }); expect((await get(c, l, P())).json().published.upToDate).toBe(false);
    const r = await mut(c, l, 'POST', `${P()}/publish`, {}); expect(r.json().result).toMatchObject({ action: 'edited', messageId: '90001' });
    expect(c.panel.messages.size).toBe(1); expect(r.json().panel.published.upToDate).toBe(true);
  });
  it('"new" posts a fresh message and removes the old one; changing the channel moves the panel', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); await mut(c, l, 'POST', `${P()}/publish`, {});
    expect((await mut(c, l, 'POST', `${P()}/publish`, { mode: 'new' })).json().result).toMatchObject({ action: 'reposted', messageId: '90002', removedOld: true });
    await setCh(c, l, '700003'); const r = await mut(c, l, 'POST', `${P()}/publish`, {});
    expect(r.json().result).toMatchObject({ action: 'moved', channelId: '700003' }); expect([...c.panel.messages.values()].map((m) => m.channelId)).toEqual(['700003']);
    expect((await get(c, l, P())).json().published.channelId).toBe('700003');
  });
  it('a configured channel that no longer exists (or is not a text channel) is refused before anything is sent', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); c.bot.channels.set(G1, []); const r = await mut(c, l, 'POST', `${P()}/publish`, {});
    expect(r.statusCode).toBe(422); expect(r.json().error).toBe('invalid_channel'); expect(c.panel.calls).toEqual([]);
    await updateGuildSettings(c.db, G1, { verification_channel_id: '800001' }, null);            // a channel id of ANOTHER server saved by some older path
    expect((await mut(c, l, 'POST', `${P()}/publish`, {})).json().error).toBe('invalid_channel'); expect(c.panel.calls).toEqual([]);
  });
  it('bot permission problems are reported with the missing permissions; nothing is recorded; other failures map to clear errors', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); c.panel.failWith = new PanelPublishError('missing_permissions', ['SendMessages']);
    const r = await mut(c, l, 'POST', `${P()}/publish`, {}); expect(r.statusCode).toBe(422); expect(r.json()).toMatchObject({ error: 'bot_missing_permissions', missing: ['SendMessages'] });
    c.panel.failWith = new PanelPublishError('discord_error'); expect((await mut(c, l, 'POST', `${P()}/publish`, {})).statusCode).toBe(502);
    c.panel.failWith = new PanelPublishError('channel_unavailable'); expect((await mut(c, l, 'POST', `${P()}/publish`, {})).json().error).toBe('invalid_channel');
    expect((await get(c, l, P())).json().published).toBeNull();
  });
  it('a double click publishes once; the second request is told it is busy', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); let open!: () => void; c.panel.gate = new Promise<void>((r) => { open = r; });
    const first = mut(c, l, 'POST', `${P()}/publish`, {}); await new Promise((r) => setTimeout(r, 30));
    const second = await mut(c, l, 'POST', `${P()}/publish`, {}); expect(second.statusCode).toBe(409); expect(second.json().error).toBe('busy');
    open(); expect((await first).statusCode).toBe(200); expect(c.panel.messages.size).toBe(1);
  });
  it('rejects unknown modes and extra fields; needs CSRF; is audited as a dashboard action', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001');
    expect((await mut(c, l, 'POST', `${P()}/publish`, { mode: 'delete' })).statusCode).toBe(422); expect((await mut(c, l, 'POST', `${P()}/publish`, { channelId: '800001' })).statusCode).toBe(422);
    expect((await c.app.inject({ method: 'POST', url: `${P()}/publish`, cookies: l.cookies, headers: { origin: l.headers.origin }, payload: {} })).statusCode).toBe(403); expect(c.panel.calls).toEqual([]);
    await mut(c, l, 'POST', `${P()}/publish`, {});
    const ev = (await c.db.query<{ actor_discord_id: string; details: { source: string; action: string } }>(`SELECT actor_discord_id, details FROM audit_events WHERE guild_id=$1 AND action='verification.panel_posted'`, [G1])).rows;
    expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ actor_discord_id: '42', details: { source: 'dashboard', action: 'posted' } });
  });
  it('the channel the panel is published to is the configured one only (the request cannot choose another)', async () => {
    const { c, l } = await ctx(); await setCh(c, l, '700001'); await mut(c, l, 'POST', `${P()}/publish`, {});
    expect(c.panel.calls).toEqual([`post:${G1}:700001`]); expect((await getGuildConfig(c.db, G1))?.verificationChannelId).toBe('700001');
  });
  it('without a Discord publisher the dashboard reports it (canPublish=false) and publishing answers 503 instead of failing silently', async () => {
    const c = await makeApp({ noPanelPublisher: true }); const l = await login(c, '42', [guildInfo(G1, ADMIN)]); c.bot.channels.set(G1, [{ id: '700001', name: 'v', type: 0, position: 1 }]);
    await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: '700001' });
    expect((await get(c, l, P())).json().canPublish).toBe(false);
    const r = await mut(c, l, 'POST', `${P()}/publish`, {}); expect(r.statusCode).toBe(503); expect(r.json().error).toBe('publisher_unavailable');
  });
});
