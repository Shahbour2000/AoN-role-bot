import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_PANEL } from '@aon/core';
import { clearPanelPublished, ensureGuild, getPanel, recordPanelPublished, savePanelSettings, type Db } from '../src/index.js';
import { freshDb } from './helpers.js';

let db: Db;
beforeEach(async () => { db = await freshDb(); await ensureGuild(db, 'A', 'Guild A'); await ensureGuild(db, 'B', 'Guild B'); });

describe('verification panel storage (migration 0010)', () => {
  it('a guild that never edited the panel gets the defaults and "not published"', async () => {
    expect(await getPanel(db, 'A')).toEqual({ settings: EMPTY_PANEL, published: null, updatedAt: null, updatedBy: null });
  });
  it('saves and reads every setting (Arabic text, emoji, colour) and survives a re-read', async () => {
    const s = { title: 'طلب الجنسية', description: 'سطر 1\nسطر 2', footer: 'EG', color: 0x00ff7f, thumbnailUrl: 'https://cdn.example.com/a.png', buttonLabel: 'طلب الجنسية', buttonEmoji: '🇪🇬', buttonStyle: 'success' as const, language: 'ar' as const };
    await savePanelSettings(db, 'A', s, 'admin1', new Date('2026-11-12T10:00:00Z'));
    const r = await getPanel(db, 'A');
    expect(r.settings).toEqual(s); expect(r.updatedBy).toBe('admin1'); expect(r.published).toBeNull();
  });
  it('saving again replaces the presentation (including back to defaults) and keeps the published reference', async () => {
    await recordPanelPublished(db, 'A', { channelId: 'c1', messageId: 'm1', fingerprint: 'f1', actor: 'admin1' });
    await savePanelSettings(db, 'A', { ...EMPTY_PANEL, title: 'T' }, 'admin1');
    await savePanelSettings(db, 'A', EMPTY_PANEL, 'admin2');
    const r = await getPanel(db, 'A');
    expect(r.settings).toEqual(EMPTY_PANEL); expect(r.published).toMatchObject({ channelId: 'c1', messageId: 'm1', fingerprint: 'f1', publishedBy: 'admin1' });
  });
  it('recording a publish keeps the presentation; a later publish replaces the reference; clearing keeps the presentation', async () => {
    await savePanelSettings(db, 'A', { ...EMPTY_PANEL, title: 'Keep me' }, 'a');
    await recordPanelPublished(db, 'A', { channelId: 'c1', messageId: 'm1', fingerprint: 'f1', actor: 'a' });
    await recordPanelPublished(db, 'A', { channelId: 'c2', messageId: 'm2', fingerprint: 'f2', actor: 'b' });
    expect((await getPanel(db, 'A')).published).toMatchObject({ channelId: 'c2', messageId: 'm2', publishedBy: 'b' });
    expect((await getPanel(db, 'A')).settings.title).toBe('Keep me');
    await clearPanelPublished(db, 'A');
    const r = await getPanel(db, 'A'); expect(r.published).toBeNull(); expect(r.settings.title).toBe('Keep me');
  });
  it('a publish recorded before any edit works (row created on demand) and guilds are isolated', async () => {
    await recordPanelPublished(db, 'A', { channelId: 'c1', messageId: 'm1', fingerprint: 'f', actor: null });
    expect((await getPanel(db, 'A')).published?.messageId).toBe('m1'); expect(await getPanel(db, 'B')).toMatchObject({ published: null, settings: EMPTY_PANEL });
  });
  it('the database itself refuses an out-of-range colour, an unknown style/language and a half-set message reference', async () => {
    const bad = (sql: string) => expect(db.query(sql)).rejects.toThrow(/check|violat/i);
    await bad(`INSERT INTO verification_panels (guild_id, color) VALUES ('A', 16777216)`);
    await bad(`INSERT INTO verification_panels (guild_id, color) VALUES ('A', -1)`);
    await bad(`INSERT INTO verification_panels (guild_id, button_style) VALUES ('A', 'link')`);
    await bad(`INSERT INTO verification_panels (guild_id, language) VALUES ('A', 'fr')`);
    await bad(`INSERT INTO verification_panels (guild_id, published_channel_id) VALUES ('A', 'c1')`);
  });
  it('audits updates with the names of the customised fields only (never the text) and deleting a guild removes its panel', async () => {
    await savePanelSettings(db, 'A', { ...EMPTY_PANEL, title: 'SECRET TITLE', color: 5 }, 'admin1');
    const ev = (await db.query<{ action: string; details: { customized: string[] }; actor_discord_id: string }>(`SELECT action, details, actor_discord_id FROM audit_events WHERE guild_id='A' AND action='verification.panel_updated'`)).rows;
    expect(ev).toHaveLength(1); expect(ev[0]!.details.customized.sort()).toEqual(['color', 'title']); expect(JSON.stringify(ev[0])).not.toContain('SECRET TITLE'); expect(ev[0]!.actor_discord_id).toBe('admin1');
    await db.query(`DELETE FROM guilds WHERE guild_id='A'`);
    expect((await db.query(`SELECT 1 FROM verification_panels WHERE guild_id='A'`)).rows).toHaveLength(0);
  });
});
