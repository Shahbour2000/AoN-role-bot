/**
 * Verification ticket panel: the public message (embed + one button) that members press to open a verification ticket.
 *
 * Pure and dependency-free so that the bot, the dashboard API and the database layer share ONE definition of what is allowed.
 * Only presentation is configurable. The button's custom id is a constant (`PANEL_BUTTON_ID`): it is what routes a click into the
 * existing, security-checked ticket flow, so no setting can change what the button does.
 */
import { createHash } from 'node:crypto';

export const PANEL_BUTTON_ID = 'vt:open';

/** Discord's own embed limits are 256 / 4096 / 2048 and 80 for a button label; we stay at or under them. */
export const PANEL_LIMITS = { title: 256, description: 4000, footer: 2048, buttonLabel: 80, url: 512 } as const;
export const PANEL_BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;   // `link` needs a URL and would bypass the ticket flow: not offered
export type PanelButtonStyle = (typeof PANEL_BUTTON_STYLES)[number];
export type PanelLang = 'ar' | 'en';

/** Stored settings. `null` = "use the built-in default" (which follows the language), never an empty string. */
export interface PanelSettings {
  title: string | null; description: string | null; footer: string | null;
  color: number | null;                 // 0xRRGGBB
  thumbnailUrl: string | null;          // https only
  buttonLabel: string | null; buttonEmoji: string | null; buttonStyle: PanelButtonStyle | null;
  language: PanelLang | null;           // language of the DEFAULT texts; null = the server language
}
export const EMPTY_PANEL: PanelSettings = { title: null, description: null, footer: null, color: null, thumbnailUrl: null, buttonLabel: null, buttonEmoji: null, buttonStyle: null, language: null };

export const DEFAULT_PANEL_COLOR = 0x6d5dfb;
export const DEFAULT_PANEL_STYLE: PanelButtonStyle = 'primary';
export const PANEL_DEFAULTS: Record<PanelLang, { title: string; description: string; buttonLabel: string }> = {
  en: {
    title: 'Account verification',
    description: 'Link your Age of Nations account to your Discord account. You prove it is yours by temporarily putting a one-time code in the name of one of your own companies. Press the button to open your ticket.',
    buttonLabel: 'Open verification ticket',
  },
  ar: {
    title: 'توثيق الحساب',
    description: 'اربط حسابك في Age of Nations بحساب ديسكورد. تثبت ملكيتك بوضع رمز لمرة واحدة مؤقتاً في اسم إحدى شركاتك. اضغط الزر لفتح تذكرتك.',
    buttonLabel: 'فتح تذكرة توثيق',
  },
};

export type PanelEmoji = { kind: 'unicode'; name: string } | { kind: 'custom'; id: string; name: string; animated: boolean };

/** What is actually sent to Discord (and what the dashboard previews). */
export interface PanelMessage {
  embed: { title: string; description: string; color: number; footer: string | null; thumbnailUrl: string | null };
  button: { customId: typeof PANEL_BUTTON_ID; label: string; emoji: PanelEmoji | null; style: PanelButtonStyle };
}

export type PanelField = keyof PanelSettings;
export type PanelErrorCode = 'too_long' | 'invalid' | 'invalid_color' | 'invalid_emoji' | 'invalid_url' | 'invalid_style' | 'invalid_language' | 'control_chars';
export interface PanelIssue { field: PanelField; code: PanelErrorCode; max?: number }

const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;
// One Unicode emoji: a flag (two regional indicators), a keycap, an emoji with optional skin tone / ZWJ sequence, or a subdivision flag.
const UNICODE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u;

export function parseButtonEmoji(raw: string): PanelEmoji | null {
  const c = CUSTOM_EMOJI.exec(raw);
  if (c) return { kind: 'custom', id: c[3]!, name: c[2]!, animated: c[1] === 'a' };
  return UNICODE_EMOJI.test(raw) ? { kind: 'unicode', name: raw } : null;
}

/** `#RRGGBB` (or `RRGGBB`) -> number; a number 0..0xFFFFFF is accepted as is. */
export function parsePanelColor(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? parseInt(m[1]!, 16) : null;
}
export const colorToHex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

const hasControl = (s: string) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);   // newline (\n) and tab are allowed, nothing else

/**
 * Validates an administrator's input and normalises it: strings are trimmed, an empty string becomes `null` (= default),
 * unknown properties are ignored. Returns every problem at once so the dashboard can mark each field.
 */
export function validatePanelInput(input: unknown): { ok: true; value: PanelSettings } | { ok: false; issues: PanelIssue[] } {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const issues: PanelIssue[] = []; const out: PanelSettings = { ...EMPTY_PANEL };
  const text = (field: 'title' | 'description' | 'footer' | 'buttonLabel', max: number) => {
    const v = src[field]; if (v === undefined || v === null) return;
    if (typeof v !== 'string') { issues.push({ field, code: 'invalid' }); return; }
    const s = v.replace(/\r\n?/g, '\n').trim(); if (!s) return;
    if (hasControl(s)) { issues.push({ field, code: 'control_chars' }); return; }
    if ([...s].length > max) { issues.push({ field, code: 'too_long', max }); return; }
    out[field] = s;
  };
  text('title', PANEL_LIMITS.title); text('description', PANEL_LIMITS.description); text('footer', PANEL_LIMITS.footer); text('buttonLabel', PANEL_LIMITS.buttonLabel);

  if (src['color'] !== undefined && src['color'] !== null && src['color'] !== '') { const c = parsePanelColor(src['color']); if (c === null) issues.push({ field: 'color', code: 'invalid_color' }); else out.color = c; }

  const emoji = src['buttonEmoji'];
  if (emoji !== undefined && emoji !== null) {
    if (typeof emoji !== 'string') issues.push({ field: 'buttonEmoji', code: 'invalid_emoji' });
    else if (emoji.trim()) { if (parseButtonEmoji(emoji.trim())) out.buttonEmoji = emoji.trim(); else issues.push({ field: 'buttonEmoji', code: 'invalid_emoji' }); }
  }

  const style = src['buttonStyle'];
  if (style !== undefined && style !== null && style !== '') { if (typeof style === 'string' && (PANEL_BUTTON_STYLES as readonly string[]).includes(style)) out.buttonStyle = style as PanelButtonStyle; else issues.push({ field: 'buttonStyle', code: 'invalid_style' }); }

  const lang = src['language'];
  if (lang !== undefined && lang !== null && lang !== '') { if (lang === 'ar' || lang === 'en') out.language = lang; else issues.push({ field: 'language', code: 'invalid_language' }); }

  const url = src['thumbnailUrl'];
  if (url !== undefined && url !== null) {
    if (typeof url !== 'string') issues.push({ field: 'thumbnailUrl', code: 'invalid_url' });
    else if (url.trim()) {
      const u = url.trim();
      let ok = u.length <= PANEL_LIMITS.url;
      if (ok) { try { const p = new URL(u); ok = p.protocol === 'https:' && !p.username && !p.password && p.hostname.includes('.'); } catch { ok = false; } }
      if (ok) out.thumbnailUrl = u; else issues.push({ field: 'thumbnailUrl', code: 'invalid_url' });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}

/** Settings + defaults -> the message to send. The default texts follow `settings.language`, else the server's language. */
export function resolvePanel(s: PanelSettings, serverLang: PanelLang): PanelMessage {
  const d = PANEL_DEFAULTS[s.language ?? serverLang];
  return {
    embed: { title: s.title ?? d.title, description: s.description ?? d.description, color: s.color ?? DEFAULT_PANEL_COLOR, footer: s.footer, thumbnailUrl: s.thumbnailUrl },
    button: { customId: PANEL_BUTTON_ID, label: s.buttonLabel ?? d.buttonLabel, emoji: s.buttonEmoji ? parseButtonEmoji(s.buttonEmoji) : null, style: s.buttonStyle ?? DEFAULT_PANEL_STYLE },
  };
}

/** Stable identity of "what is published": lets the dashboard say the live message is out of date after an edit or a channel change. */
export function panelFingerprint(channelId: string, m: PanelMessage): string {
  return createHash('sha256').update(JSON.stringify([channelId, m.embed.title, m.embed.description, m.embed.color, m.embed.footer, m.embed.thumbnailUrl, m.button.label, m.button.emoji, m.button.style])).digest('hex').slice(0, 32);
}
