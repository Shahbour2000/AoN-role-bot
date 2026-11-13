import { EMPTY_PANEL, type PanelButtonStyle, type PanelLang, type PanelSettings } from '@aon/core';
import { audit } from './audit.js';
import type { Db } from './db.js';

export interface PublishedPanel { channelId: string; messageId: string; fingerprint: string | null; publishedAt: Date | null; publishedBy: string | null }
export interface PanelRecord { settings: PanelSettings; published: PublishedPanel | null; updatedAt: Date | null; updatedBy: string | null }
interface Row {
  title: string | null; description: string | null; footer: string | null; color: number | null; thumbnail_url: string | null; button_label: string | null; button_emoji: string | null;
  button_style: PanelButtonStyle | null; language: PanelLang | null; published_channel_id: string | null; published_message_id: string | null; published_fingerprint: string | null;
  published_at: Date | null; published_by: string | null; updated_at: Date; updated_by: string | null;
}

/** A guild with no row (never edited) gets the defaults and "not published". */
export async function getPanel(db: Db, guildId: string): Promise<PanelRecord> {
  const r = (await db.query<Row>('SELECT * FROM verification_panels WHERE guild_id=$1', [guildId])).rows[0];
  if (!r) return { settings: { ...EMPTY_PANEL }, published: null, updatedAt: null, updatedBy: null };
  return {
    settings: { title: r.title, description: r.description, footer: r.footer, color: r.color, thumbnailUrl: r.thumbnail_url, buttonLabel: r.button_label, buttonEmoji: r.button_emoji, buttonStyle: r.button_style, language: r.language },
    published: r.published_channel_id && r.published_message_id ? { channelId: r.published_channel_id, messageId: r.published_message_id, fingerprint: r.published_fingerprint, publishedAt: r.published_at, publishedBy: r.published_by } : null,
    updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

/** Saves the presentation (already validated by `validatePanelInput`). Never touches the published-message reference. Audited. */
export async function savePanelSettings(db: Db, guildId: string, s: PanelSettings, actor: string | null, now = new Date()): Promise<void> {
  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO verification_panels (guild_id, title, description, footer, color, thumbnail_url, button_label, button_emoji, button_style, language, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (guild_id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, footer=EXCLUDED.footer, color=EXCLUDED.color, thumbnail_url=EXCLUDED.thumbnail_url,
         button_label=EXCLUDED.button_label, button_emoji=EXCLUDED.button_emoji, button_style=EXCLUDED.button_style, language=EXCLUDED.language, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
      [guildId, s.title, s.description, s.footer, s.color, s.thumbnailUrl, s.buttonLabel, s.buttonEmoji, s.buttonStyle, s.language, now, actor]);
    await audit(t, { guildId, actor, action: 'verification.panel_updated', details: { customized: Object.entries(s).filter(([, v]) => v !== null).map(([k]) => k) } });   // field names only, never the text
  });
}

/** Remembers the message the bot just published (or edited). Never touches the presentation. */
export async function recordPanelPublished(db: Db, guildId: string, p: { channelId: string; messageId: string; fingerprint: string; actor: string | null; now?: Date }): Promise<void> {
  await db.query(
    `INSERT INTO verification_panels (guild_id, published_channel_id, published_message_id, published_fingerprint, published_at, published_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (guild_id) DO UPDATE SET published_channel_id=EXCLUDED.published_channel_id, published_message_id=EXCLUDED.published_message_id,
       published_fingerprint=EXCLUDED.published_fingerprint, published_at=EXCLUDED.published_at, published_by=EXCLUDED.published_by`,
    [guildId, p.channelId, p.messageId, p.fingerprint, p.now ?? new Date(), p.actor]);
}

/** Forgets the published-message reference (the message was deleted in Discord). The presentation is kept. */
export async function clearPanelPublished(db: Db, guildId: string): Promise<void> {
  await db.query(`UPDATE verification_panels SET published_channel_id=NULL, published_message_id=NULL, published_fingerprint=NULL, published_at=NULL, published_by=NULL WHERE guild_id=$1`, [guildId]);
}
