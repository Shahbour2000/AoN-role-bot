import { beforeEach, describe, expect, it } from 'vitest';
import { PANEL_BUTTON_ID, PANEL_DEFAULTS, EMPTY_PANEL, panelFingerprint, resolvePanel, type PanelMessage } from '@aon/core';
import { getPanel, savePanelSettings, updateGuildSettings, type Db } from '@aon/db';
import { PanelPublishError, publishVerificationPanel, type PanelPublisher } from '../src/index.js';
import { setup } from './harness.js';

class FakePublisher implements PanelPublisher {
  next = 1; messages = new Map<string, { channelId: string; message: PanelMessage }>(); calls: string[] = [];
  failWith: PanelPublishError | Error | null = null; removeFails = false; gate: Promise<void> | null = null;
  async post(g: string, c: string, m: PanelMessage) { this.calls.push(`post:${c}`); if (this.gate) await this.gate; if (this.failWith) throw this.failWith; const id = `m${this.next++}`; this.messages.set(id, { channelId: c, message: m }); return { messageId: id }; }
  async edit(_g: string, c: string, id: string, m: PanelMessage) { this.calls.push(`edit:${id}`); if (this.failWith) throw this.failWith; const cur = this.messages.get(id); if (!cur || cur.channelId !== c) return false; cur.message = m; return true; }
  async remove(_g: string, c: string, id: string) { this.calls.push(`remove:${id}`); if (this.removeFails) throw new Error('forbidden'); if (this.messages.get(id)?.channelId === c) this.messages.delete(id); }
}
let db: Db; let pub: FakePublisher;
const run = (o: { mode?: 'update' | 'new'; guildId?: string } = {}) => publishVerificationPanel({ db, publisher: pub, now: () => new Date('2026-11-12T12:00:00Z') }, { guildId: o.guildId ?? 'A', actorId: 'admin1', source: 'dashboard', ...(o.mode ? { mode: o.mode } : {}) });
const setChannel = (c: string | null, g = 'A') => updateGuildSettings(db, g, { verification_channel_id: c }, null);
const audits = async (action: string) => (await db.query<{ details: Record<string, unknown>; actor_discord_id: string; target: string }>(`SELECT details, actor_discord_id, target FROM audit_events WHERE action=$1 ORDER BY id`, [action])).rows;

beforeEach(async () => { ({ db } = await setup({ guilds: ['A', 'B'] })); pub = new FakePublisher(); await updateGuildSettings(db, 'A', { language: 'en' }, null); await setChannel('c1'); });

describe('publishing the verification panel', () => {
  it('first publish posts the default panel in the configured channel and remembers the message', async () => {
    const r = await run();
    expect(r).toMatchObject({ ok: true, action: 'posted', channelId: 'c1', messageId: 'm1' });
    const m = pub.messages.get('m1')!.message;
    expect(m.embed.title).toBe(PANEL_DEFAULTS.en.title); expect(m.button.customId).toBe(PANEL_BUTTON_ID);
    expect((await getPanel(db, 'A')).published).toMatchObject({ channelId: 'c1', messageId: 'm1', publishedBy: 'admin1', fingerprint: panelFingerprint('c1', m) });
  });
  it('uses the saved customisation (title, colour, button emoji/label/style)', async () => {
    await savePanelSettings(db, 'A', { ...EMPTY_PANEL, title: 'طلب الجنسية', color: 0x00ff00, buttonLabel: 'طلب الجنسية', buttonEmoji: '🇪🇬', buttonStyle: 'success' }, 'a');
    await run(); const m = pub.messages.get('m1')!.message;
    expect(m.embed).toMatchObject({ title: 'طلب الجنسية', color: 0x00ff00 }); expect(m.button).toMatchObject({ label: 'طلب الجنسية', emoji: { kind: 'unicode', name: '🇪🇬' }, style: 'success' });
  });
  it('publishing again EDITS the same message: no duplicate panel', async () => {
    await run(); await savePanelSettings(db, 'A', { ...EMPTY_PANEL, title: 'New title' }, 'a');
    const r = await run();
    expect(r).toMatchObject({ ok: true, action: 'edited', messageId: 'm1' }); expect(pub.messages.size).toBe(1); expect(pub.messages.get('m1')!.message.embed.title).toBe('New title');
    expect(pub.calls.filter((c) => c.startsWith('post'))).toHaveLength(1);
    expect((await getPanel(db, 'A')).published?.fingerprint).toBe(panelFingerprint('c1', pub.messages.get('m1')!.message));
  });
  it('if the old message was deleted in Discord a new one is posted and recorded', async () => {
    await run(); pub.messages.clear();
    expect(await run()).toMatchObject({ ok: true, action: 'posted', messageId: 'm2' }); expect((await getPanel(db, 'A')).published?.messageId).toBe('m2');
  });
  it('"post as new" replaces the old message (new first, old removed after) and never leaves two panels', async () => {
    await run(); const r = await run({ mode: 'new' });
    expect(r).toMatchObject({ ok: true, action: 'reposted', messageId: 'm2', removedOld: true }); expect([...pub.messages.keys()]).toEqual(['m2']);
    expect(pub.calls.slice(-2)).toEqual(['post:c1', 'remove:m1']);
  });
  it('changing the channel posts in the new channel and removes the old panel', async () => {
    await run(); await setChannel('c2');
    expect(await run()).toMatchObject({ ok: true, action: 'moved', channelId: 'c2', messageId: 'm2', removedOld: true });
    expect([...pub.messages.entries()].map(([k, v]) => [k, v.channelId])).toEqual([['m2', 'c2']]);
  });
  it('failing to remove the old panel does not fail the publish (the new panel is live and recorded)', async () => {
    await run(); await setChannel('c2'); pub.removeFails = true;
    expect(await run()).toMatchObject({ ok: true, action: 'moved', removedOld: false }); expect((await getPanel(db, 'A')).published?.messageId).toBe('m2');
  });
  it('no channel configured -> nothing is sent', async () => {
    await setChannel(null); expect(await run()).toEqual({ ok: false, code: 'no_channel' }); expect(pub.calls).toEqual([]);
  });
  it('missing permissions / unavailable channel are reported (with the missing permission names) and change nothing', async () => {
    pub.failWith = new PanelPublishError('missing_permissions', ['SendMessages', 'EmbedLinks']);
    expect(await run()).toEqual({ ok: false, code: 'missing_permissions', missing: ['SendMessages', 'EmbedLinks'] });
    pub.failWith = new PanelPublishError('channel_unavailable'); expect(await run()).toEqual({ ok: false, code: 'channel_unavailable' });
    pub.failWith = new Error('boom'); expect(await run()).toEqual({ ok: false, code: 'discord_error' });
    expect((await getPanel(db, 'A')).published).toBeNull();
    const f = await audits('verification.panel_publish_failed'); expect(f.map((x) => x.details['code'])).toEqual(['missing_permissions', 'channel_unavailable', 'discord_error']);
  });
  it('an edit that fails keeps the recorded reference (the old panel is still there)', async () => {
    await run(); pub.failWith = new PanelPublishError('missing_permissions', ['EmbedLinks']);
    expect(await run()).toMatchObject({ ok: false, code: 'missing_permissions' }); expect((await getPanel(db, 'A')).published?.messageId).toBe('m1');
  });
  it('a double click: exactly one publish runs, the other answers "busy"; afterwards publishing works again', async () => {
    let open!: () => void; pub.gate = new Promise<void>((r) => { open = r; });
    const first = run(); await new Promise((r) => setTimeout(r, 20)); const second = await run();
    expect(second).toEqual({ ok: false, code: 'busy' }); open(); expect(await first).toMatchObject({ ok: true }); pub.gate = null;
    expect(pub.messages.size).toBe(1); expect(await run()).toMatchObject({ ok: true, action: 'edited' });
  });
  it('if recording the message in the database fails, the just-posted message is removed (no orphan panel)', async () => {
    const broken = { ...db, query: async (sql: string, p?: unknown[]) => { if (/INSERT INTO verification_panels/.test(sql)) throw new Error('db down'); return db.query(sql, p); }, tx: db.tx.bind(db) } as Db;
    const r = await publishVerificationPanel({ db: broken, publisher: pub }, { guildId: 'A', actorId: 'x', source: 'command' });
    expect(r).toEqual({ ok: false, code: 'discord_error' }); expect(pub.messages.size).toBe(0);
  });
  it('without a Discord adapter it reports "publisher_unavailable"; the in-flight lock is always released', async () => {
    expect(await publishVerificationPanel({ db, publisher: undefined }, { guildId: 'A', actorId: 'x', source: 'command' })).toEqual({ ok: false, code: 'publisher_unavailable' });
    expect(await run()).toMatchObject({ ok: true });
  });
  it('is audited with the actor, the source, the action and the message id; servers are isolated', async () => {
    await setChannel('b1', 'B'); await run(); await run(); await run({ guildId: 'B' });
    const ev = await audits('verification.panel_posted');
    expect(ev.map((e) => e.details['action'])).toEqual(['posted', 'edited', 'posted']); expect(ev[0]).toMatchObject({ actor_discord_id: 'admin1', target: 'c1', details: { source: 'dashboard', messageId: 'm1' } });
    expect((await getPanel(db, 'B')).published?.channelId).toBe('b1'); expect((await getPanel(db, 'A')).published?.channelId).toBe('c1');
  });
  it('Arabic servers get the Arabic default panel; the panel language setting overrides the server language', async () => {
    await updateGuildSettings(db, 'A', { language: 'ar' }, null); await run();
    expect(pub.messages.get('m1')!.message.embed.title).toBe(PANEL_DEFAULTS.ar.title);
    await savePanelSettings(db, 'A', { ...EMPTY_PANEL, language: 'en' }, 'a'); await run();
    expect(pub.messages.get('m1')!.message.embed.title).toBe(PANEL_DEFAULTS.en.title);
    expect(resolvePanel(EMPTY_PANEL, 'ar').embed.title).toBe(PANEL_DEFAULTS.ar.title);
  });
});
