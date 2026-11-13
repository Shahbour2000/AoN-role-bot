import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_COLOR, EMPTY_PANEL, PANEL_BUTTON_ID, PANEL_DEFAULTS, PANEL_LIMITS, colorToHex, panelFingerprint, parseButtonEmoji, parsePanelColor, resolvePanel, validatePanelInput } from '../src/index.js';

const ok = (i: unknown) => { const r = validatePanelInput(i); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value; };
const bad = (i: unknown) => { const r = validatePanelInput(i); if (r.ok) throw new Error('expected failure'); return r.issues; };

describe('panel validation', () => {
  it('an empty input is all-defaults; blank strings mean "default" (null), never an empty title', () => {
    expect(ok({})).toEqual(EMPTY_PANEL);
    expect(ok({ title: '   ', description: '', footer: '\n', buttonLabel: ' ', buttonEmoji: '', color: '', thumbnailUrl: '', buttonStyle: '', language: '' })).toEqual(EMPTY_PANEL);
    expect(ok(null)).toEqual(EMPTY_PANEL);
  });
  it('trims, normalises line breaks and keeps Arabic text intact', () => {
    const v = ok({ title: '  توثيق الجنسية  ', description: 'سطر 1\r\nسطر 2' });
    expect(v.title).toBe('توثيق الجنسية'); expect(v.description).toBe('سطر 1\nسطر 2');
  });
  it('enforces length limits by characters (an emoji or Arabic letter counts once) and reports the limit', () => {
    expect(bad({ title: 'x'.repeat(PANEL_LIMITS.title + 1) })).toEqual([{ field: 'title', code: 'too_long', max: PANEL_LIMITS.title }]);
    expect(ok({ buttonLabel: '🇪🇬'.repeat(PANEL_LIMITS.buttonLabel / 2) }).buttonLabel).toBeTruthy();
    expect(bad({ buttonLabel: 'ب'.repeat(PANEL_LIMITS.buttonLabel + 1) })[0]).toMatchObject({ field: 'buttonLabel', code: 'too_long' });
    expect(bad({ description: 'd'.repeat(PANEL_LIMITS.description + 1) })[0]).toMatchObject({ field: 'description' });
  });
  it('rejects control characters and non-string text; reports every problem at once', () => {
    expect(bad({ title: 'a\u0000b' })[0]).toMatchObject({ code: 'control_chars' });
    expect(bad({ title: 5 })[0]).toMatchObject({ field: 'title', code: 'invalid' });
    expect(bad({ title: 'x'.repeat(300), color: 'red', buttonStyle: 'link' }).map((i) => i.field).sort()).toEqual(['buttonStyle', 'color', 'title']);
  });
  it('colour: #RRGGBB, RRGGBB or a number in range; nothing else', () => {
    expect(parsePanelColor('#6D5DFB')).toBe(0x6d5dfb); expect(parsePanelColor('6d5dfb')).toBe(0x6d5dfb); expect(parsePanelColor(0)).toBe(0); expect(parsePanelColor(0xffffff)).toBe(0xffffff);
    for (const x of ['#fff', '#12345g', '#1234567', -1, 0x1000000, 1.5, null, {}, 'rgb(1,2,3)']) expect(parsePanelColor(x), String(x)).toBeNull();
    expect(colorToHex(0x0000ff)).toBe('#0000ff'); expect(ok({ color: '#00FF7F' }).color).toBe(0x00ff7f); expect(bad({ color: '#xyz' })[0]).toMatchObject({ code: 'invalid_color' });
  });
  it('emoji: unicode (flag, ZWJ, skin tone, keycap), custom and animated custom are accepted; text, several emoji and look-alikes are not', () => {
    for (const e of ['🇪🇬', '🎫', '✅', '👨‍👩‍👧', '👍🏽', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿']) expect(parseButtonEmoji(e), e).not.toBeNull();
    expect(parseButtonEmoji('<:verified:123456789012345678>')).toEqual({ kind: 'custom', id: '123456789012345678', name: 'verified', animated: false });
    expect(parseButtonEmoji('<a:spin:123456789012345678>')).toMatchObject({ animated: true });
    for (const e of ['a', 'ab', '🎫🎫', ':tickets:', '<:x:1>', '<:verified:abc>', '🎫 ', '<script>', '']) expect(parseButtonEmoji(e), JSON.stringify(e)).toBeNull();
    expect(bad({ buttonEmoji: 'hello' })[0]).toMatchObject({ field: 'buttonEmoji', code: 'invalid_emoji' });
  });
  it('button style: only primary / secondary / success / danger (a link button would bypass the ticket flow)', () => {
    for (const s of ['primary', 'secondary', 'success', 'danger']) expect(ok({ buttonStyle: s }).buttonStyle).toBe(s);
    for (const s of ['link', 'premium', 'PRIMARY', 3]) expect(bad({ buttonStyle: s })[0]).toMatchObject({ field: 'buttonStyle' });
  });
  it('thumbnail: https only, no credentials, bounded length', () => {
    expect(ok({ thumbnailUrl: 'https://cdn.example.com/a.png' }).thumbnailUrl).toBe('https://cdn.example.com/a.png');
    for (const u of ['http://example.com/a.png', 'javascript:alert(1)', 'https://user:pw@example.com/a.png', 'https://localhost/a.png', 'not a url', `https://example.com/${'a'.repeat(600)}`, 'data:image/png;base64,AAAA']) expect(bad({ thumbnailUrl: u })[0], u).toMatchObject({ field: 'thumbnailUrl', code: 'invalid_url' });
  });
  it('unknown properties are ignored (a caller cannot smuggle a custom id or a URL button)', () => {
    const v = ok({ title: 'T', customId: 'evil:1', url: 'https://x.y', buttonStyle: 'success' });
    expect(Object.keys(v).sort()).toEqual(Object.keys(EMPTY_PANEL).sort()); expect(resolvePanel(v, 'en').button.customId).toBe(PANEL_BUTTON_ID);
  });
});

describe('resolvePanel', () => {
  it('defaults follow the server language, or the panel language when set', () => {
    expect(resolvePanel(EMPTY_PANEL, 'en').embed.title).toBe(PANEL_DEFAULTS.en.title);
    expect(resolvePanel(EMPTY_PANEL, 'ar').button.label).toBe(PANEL_DEFAULTS.ar.buttonLabel);
    expect(resolvePanel({ ...EMPTY_PANEL, language: 'en' }, 'ar').embed.title).toBe(PANEL_DEFAULTS.en.title);
    expect(resolvePanel(EMPTY_PANEL, 'en').embed.color).toBe(DEFAULT_PANEL_COLOR);
  });
  it('custom values win over defaults field by field', () => {
    const m = resolvePanel({ ...EMPTY_PANEL, title: 'طلب الجنسية', buttonLabel: 'طلب الجنسية', buttonEmoji: '🇪🇬', buttonStyle: 'success', color: 0x00ff00, footer: 'EG' }, 'en');
    expect(m.embed).toMatchObject({ title: 'طلب الجنسية', description: PANEL_DEFAULTS.en.description, color: 0x00ff00, footer: 'EG' });
    expect(m.button).toMatchObject({ label: 'طلب الجنسية', emoji: { kind: 'unicode', name: '🇪🇬' }, style: 'success', customId: 'vt:open' });
  });
  it('the fingerprint changes with every visible property and with the channel, and is stable otherwise', () => {
    const base = resolvePanel(EMPTY_PANEL, 'en'); const f = panelFingerprint('c1', base);
    expect(panelFingerprint('c1', resolvePanel(EMPTY_PANEL, 'en'))).toBe(f); expect(panelFingerprint('c2', base)).not.toBe(f);
    for (const p of [{ title: 'x' }, { description: 'x' }, { color: 1 }, { footer: 'x' }, { thumbnailUrl: 'https://a.b/c.png' }, { buttonLabel: 'x' }, { buttonEmoji: '🎫' }, { buttonStyle: 'danger' as const }]) expect(panelFingerprint('c1', resolvePanel({ ...EMPTY_PANEL, ...p }, 'en')), JSON.stringify(p)).not.toBe(f);
  });
});
