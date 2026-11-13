import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { getPanel, updateGuildSettings } from '@aon/db';
import { PanelPublishError } from '@aon/sync';
import { ADMIN, BASE, guildInfo, login, makeApp, type Ctx, type Login } from './harness.js';

const PUB = join(__dirname, '..', 'public'); const G1 = '100000001';
const read = (f: string) => readFileSync(join(PUB, f), 'utf8');
type Win = Window & typeof globalThis;
interface Page { win: Win; doc: Document; $: (s: string) => HTMLElement | null; $$: (s: string) => HTMLElement[]; calls: { method: string; url: string; status: number; body?: string }[] }
async function waitFor<T>(fn: () => T | null | undefined | false, label: string, ms = 8000): Promise<T> { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`); await new Promise((r) => setTimeout(r, 25)); } }

async function open(c: Ctx, l: Login, lang: 'ar' | 'en'): Promise<Page> {
  const dom = new JSDOM(read('app.html'), { url: `${BASE}/app#/g/${G1}/verify`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Win; const calls: Page['calls'] = [];
  win.localStorage.setItem('aon_lang', lang);
  (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false });
  (win as unknown as { fetch: unknown }).fetch = async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = opts.method ?? 'GET'; const headers: Record<string, string> = { ...(opts.headers ?? {}), cookie: `aon_session=${l.cookies['aon_session']}` }; if (method !== 'GET') headers['origin'] = BASE;
    const res = await c.app.inject({ method: method as 'GET', url: String(url), headers, ...(opts.body ? { payload: opts.body } : {}) });
    calls.push({ method, url: String(url), status: res.statusCode, ...(opts.body ? { body: opts.body } : {}) });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
  };
  for (const f of ['i18n.js', 'common.js', 'picker.js', 'app.js']) win.eval(read(f));
  if (win.document.readyState !== 'loading') win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  return { win, doc: win.document, calls, $: (s) => win.document.querySelector(s), $$: (s) => [...win.document.querySelectorAll<HTMLElement>(s)] };
}
const type = (p: Page, el: Element | null, v: string) => { if (!el) throw new Error('missing'); (el as HTMLInputElement).value = v; el.dispatchEvent(new p.win.Event('input', { bubbles: true })); };
const click = (p: Page, el: Element | null) => { if (!el) throw new Error('missing element'); el.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true })); };
const select = (p: Page, el: Element | null, v: string) => { (el as HTMLSelectElement).value = v; el!.dispatchEvent(new p.win.Event('change', { bubbles: true })); };
async function boot(lang: 'ar' | 'en' = 'en', over: (c: Ctx) => void = () => undefined) {
  const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
  c.bot.channels.set(G1, [{ id: '700001', name: 'verify-here', type: 0, position: 1 }, { id: '700003', name: 'news', type: 5, position: 2 }]); over(c);
  await updateGuildSettings(c.db, G1, { language: 'en' }, null);
  const p = await open(c, l, lang); await waitFor(() => p.$('#pn-card'), 'panel card');
  return { c, l, p };
}
const toast = (p: Page) => p.$('.toast')?.textContent ?? '';

describe('verification page: panel editor (jsdom, real shipped scripts, real API)', () => {
  it('shows stats, the channel selector and the panel editor with the default preview; no untranslated keys in Arabic or English', async () => {
    for (const lang of ['en', 'ar'] as const) {
      const { p } = await boot(lang);
      expect(p.$$('.stats .stat').length).toBe(4); expect(p.$('#vf-channel')).toBeTruthy(); expect(p.$('#pn-publish')).toBeTruthy();
      expect(p.$('.ep-title')?.textContent).toBe('Account verification');      // default texts follow the SERVER language (en here), not the dashboard language
      expect(p.doc.documentElement.getAttribute('dir')).toBe(lang === 'ar' ? 'rtl' : 'ltr');
      const text = p.doc.body.textContent ?? ''; expect(text).not.toMatch(/\b(tab_|vf_|pn_|pd_|e_)[a-z_]+\b/);
    }
  });
  it('typing updates the live preview: title, description, colour, footer, button text/emoji/style; blank falls back to the default', async () => {
    const { p } = await boot();
    type(p, p.$('#pn-title'), 'Nationality request'); type(p, p.$('#pn-desc'), 'Line 1\nLine 2'); type(p, p.$('#pn-footer'), 'EG'); type(p, p.$('#pn-label'), 'Request'); type(p, p.$('#pn-emoji'), '🇪🇬'); select(p, p.$('#pn-style'), 'success');
    type(p, p.$('#pn-color'), '#00ff7f');
    expect(p.$('.ep-title')?.textContent).toBe('Nationality request'); expect(p.$('.ep-desc')?.textContent).toBe('Line 1\nLine 2'); expect(p.$('.ep-foot')?.textContent).toBe('EG');
    const btn = p.$('.dc-btn')!; expect(btn.textContent).toBe('🇪🇬Request'); expect(btn.classList.contains('success')).toBe(true);
    expect(p.$('.embed-preview')?.getAttribute('style')).toContain('#00ff7f');
    type(p, p.$('#pn-title'), '   '); expect(p.$('.ep-title')?.textContent).toBe('Account verification');
    click(p, p.$('#pn-color-default')); expect(p.$('.embed-preview')?.getAttribute('style')).toContain('#6d5dfb');
    expect(p.$('#pn-status')?.textContent).toContain('Unsaved changes');
  });
  it('the preview never loads external images (only a placeholder) and never injects markup from the text fields', async () => {
    const { p } = await boot(); type(p, p.$('#pn-thumb'), 'https://evil.example/a.png'); type(p, p.$('#pn-title'), '<img src=x onerror=alert(1)><b>x</b>');
    expect(p.$('.embed-preview img')).toBeNull(); expect(p.$('.ep-thumb')).toBeTruthy(); expect(p.$('.ep-title img')).toBeNull(); expect(p.$('.ep-title')?.textContent).toContain('<img');
  });
  it('Save stores everything in the database, shows success, and a fresh page load shows the saved values', async () => {
    const { c, l, p } = await boot();
    type(p, p.$('#pn-title'), 'طلب الجنسية'); type(p, p.$('#pn-emoji'), '🇪🇬'); select(p, p.$('#pn-style'), 'danger'); type(p, p.$('#pn-color'), '#112233'); select(p, p.$('#pn-lang'), 'ar');
    click(p, p.$('#pn-save')); await waitFor(() => toast(p).includes('saved'), 'saved toast');
    const put = p.calls.find((x) => x.method === 'PUT' && x.url.endsWith('/verification/panel'))!; expect(put.status).toBe(200); expect(JSON.parse(put.body!)).toMatchObject({ title: 'طلب الجنسية', buttonEmoji: '🇪🇬', buttonStyle: 'danger', color: '#112233', language: 'ar' });
    expect((await getPanel(c.db, G1)).settings).toMatchObject({ title: 'طلب الجنسية', buttonStyle: 'danger', color: 0x112233, language: 'ar' });
    const p2 = await open(c, l, 'en'); await waitFor(() => p2.$('#pn-card'), 'reload');
    expect((p2.$('#pn-title') as HTMLInputElement).value).toBe('طلب الجنسية'); expect((p2.$('#pn-style') as HTMLSelectElement).value).toBe('danger'); expect((p2.$('#pn-color') as HTMLInputElement).value).toBe('#112233'); expect((p2.$('#pn-emoji') as HTMLInputElement).value).toBe('🇪🇬');
    expect(p2.$('#pn-status')?.textContent).not.toContain('Unsaved');
  });
  it('server-side validation errors are shown next to the field, in the page language, and nothing is saved', async () => {
    const { c, p } = await boot(); type(p, p.$('#pn-emoji'), 'abc'); type(p, p.$('#pn-thumb'), 'http://x.example/a.png'); click(p, p.$('#pn-save'));
    await waitFor(() => !p.$('[data-field="buttonEmoji"] .err')?.hasAttribute('hidden'), 'field error');
    expect(p.$('[data-field="buttonEmoji"] .err')?.textContent).toContain('one emoji'); expect(p.$('[data-field="thumbnailUrl"] .err')?.textContent).toContain('https://'); expect(p.$('[data-field="buttonEmoji"]')?.classList.contains('invalid')).toBe(true);
    expect(toast(p)).toContain('highlighted'); expect((await getPanel(c.db, G1)).settings.buttonEmoji).toBeNull();
    type(p, p.$('#pn-emoji'), '🎫'); type(p, p.$('#pn-thumb'), ''); click(p, p.$('#pn-save')); await waitFor(() => toast(p).includes('saved'), 'saved after fixing');
    expect(p.$('[data-field="buttonEmoji"] .err')?.hasAttribute('hidden')).toBe(true);
  });
  it('Publish without a channel does nothing and says so', async () => {
    const { c, p } = await boot(); click(p, p.$('#pn-publish')); await waitFor(() => toast(p).includes('verification channel'), 'toast');
    expect(p.calls.filter((x) => x.method === 'POST')).toHaveLength(0); expect(c.panel.calls).toEqual([]);
  });
  it('choosing a channel and pressing Publish saves the channel + unsaved edits, posts the panel in that channel, and shows where it is', async () => {
    const { c, p } = await boot(); select(p, p.$('#vf-channel'), '700001'); type(p, p.$('#pn-title'), 'Nationality request'); select(p, p.$('#pn-style'), 'success');
    click(p, p.$('#pn-publish')); await waitFor(() => toast(p).includes('published'), 'published toast');
    expect(p.calls.filter((x) => x.method !== 'GET').map((x) => `${x.method} ${x.url.replace(`/api/guilds/${G1}`, '')}`)).toEqual(['PUT /settings', 'PUT /verification/panel', 'POST /verification/panel/publish']);
    const m = [...c.panel.messages.values()][0]!; expect(m.channelId).toBe('700001'); expect(m.message.embed.title).toBe('Nationality request'); expect(m.message.button).toMatchObject({ style: 'success', customId: 'vt:open' });
    const st = p.$('#pn-status')!.textContent!; expect(st).toContain('Published in # verify-here'); expect(st).toContain('Up to date'); expect(st).not.toContain('Unsaved');
    expect(p.$('#pn-publish')?.textContent).toBe('Update published panel'); expect(p.$('#pn-repost')?.hasAttribute('hidden')).toBe(false);
    expect(p.$('#pn-status a')?.getAttribute('href')).toBe(`https://discord.com/channels/${G1}/700001/90001`); expect(p.$('#pn-status a')?.getAttribute('rel')).toContain('noopener');
  });
  it('Update edits the same message (no duplicate); an edit after publishing is flagged "changed since publishing"; "post as new" asks for confirmation first', async () => {
    const { c, p } = await boot(); select(p, p.$('#vf-channel'), '700001'); click(p, p.$('#pn-publish')); await waitFor(() => toast(p).includes('published'), 'first');
    type(p, p.$('#pn-title'), 'Changed'); click(p, p.$('#pn-save')); await waitFor(() => p.$('#pn-status')?.textContent?.includes('Changed since publishing'), 'outdated flag');
    click(p, p.$('#pn-publish')); await waitFor(() => toast(p).includes('updated'), 'updated'); expect(c.panel.messages.size).toBe(1); expect(c.panel.calls.filter((x) => x.startsWith('post'))).toHaveLength(1);
    click(p, p.$('#pn-repost')); await waitFor(() => p.$('.overlay'), 'confirm dialog'); expect(c.panel.calls.filter((x) => x.startsWith('post'))).toHaveLength(1);
    click(p, p.$('.overlay .btn.primary')); await waitFor(() => toast(p).includes('old one was removed'), 'reposted'); expect([...c.panel.messages.keys()]).toEqual(['90002']);
  });
  it('bot permission failures show the missing permissions; the panel stays "not published"', async () => {
    const { c, p } = await boot(); c.panel.failWith = new PanelPublishError('missing_permissions', ['SendMessages', 'EmbedLinks']);
    select(p, p.$('#vf-channel'), '700001'); click(p, p.$('#pn-publish')); await waitFor(() => toast(p).includes('Missing permissions'), 'error toast');
    expect(toast(p)).toContain('SendMessages, EmbedLinks'); expect(p.$('.toast')?.classList.contains('bad')).toBe(true); expect(p.$('#pn-status')?.textContent).toContain('Not published yet'); expect((p.$('#pn-publish') as HTMLButtonElement).disabled).toBe(false);
  });
  it('Reset asks for confirmation, then returns every field to the default and saves', async () => {
    const { c, p } = await boot(); type(p, p.$('#pn-title'), 'Custom'); click(p, p.$('#pn-save')); await waitFor(() => toast(p).includes('saved'), 'saved');
    click(p, p.$('#pn-reset')); await waitFor(() => p.$('.overlay'), 'dialog'); click(p, p.$('.overlay .btn.danger'));
    await waitFor(async () => (await getPanel(c.db, G1)).settings.title === null, 'reset in db').catch(() => undefined); await new Promise((r) => setTimeout(r, 300));
    expect((await getPanel(c.db, G1)).settings.title).toBeNull(); expect((p.$('#pn-title') as HTMLInputElement).value).toBe(''); expect(p.$('.ep-title')?.textContent).toBe('Account verification');
  });
  it('without a connected bot the publish buttons are disabled and a notice explains why', async () => {
    const c = await makeApp({ noPanelPublisher: true }); const l = await login(c, '42', [guildInfo(G1, ADMIN)]); c.bot.channels.set(G1, []);
    const p = await open(c, l, 'en'); await waitFor(() => p.$('#pn-card'), 'card');
    expect((p.$('#pn-publish') as HTMLButtonElement).disabled).toBe(true); expect(p.$('#pn-card .callout')?.textContent).toContain('not connected');
  });
  it('Arabic page: RTL document, Arabic labels/status; the panel-language selector switches the DEFAULT texts to Arabic', async () => {
    const { p } = await boot('ar'); expect(p.doc.documentElement.getAttribute('dir')).toBe('rtl');
    expect(p.$('label[for="pn-title"]')?.textContent).toBe('عنوان الرسالة'); expect(p.$('#pn-publish')?.textContent).toBe('نشر اللوحة'); expect(p.$('#pn-status')?.textContent).toContain('لم تُنشر بعد');
    select(p, p.$('#pn-lang'), 'ar'); expect(p.$('.ep-title')?.textContent).toBe('توثيق الحساب'); expect(p.$('.dc-btn')?.textContent).toBe('فتح تذكرة توثيق');
    select(p, p.$('#pn-lang'), 'en'); expect(p.$('.ep-title')?.textContent).toBe('Account verification');
  });
  it('responsive/RTL rules exist in the stylesheet (static check: jsdom does no layout): stacked on narrow screens, logical properties only', () => {
    const css = read('app.css'); const block = css.slice(css.indexOf('verification panel editor'), css.lastIndexOf('7 motion'));
    expect(block).toMatch(/@media \(max-width: 900px\)[^}]*\.panel-edit \{ grid-template-columns: minmax\(0, 1fr\)/); expect(block).toMatch(/@media \(max-width: 640px\)/);
    expect(block).not.toMatch(/\b(margin|padding)-(left|right)\b|\b(left|right):|text-align:\s*(left|right)/);
  });
});
