import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { getGuildConfig, getLadder, claimLink, listLinks, saveLadder } from '@aon/db';
import { ADMIN, BASE, guildInfo, login, makeApp, role, type Ctx, type Login } from './harness.js';

const PUB = join(__dirname, '..', 'public');
const G1 = '100000001', G2 = '100000002';
const read = (f: string) => readFileSync(join(PUB, f), 'utf8');

interface Page { dom: JSDOM; doc: Document; win: Window & typeof globalThis; $: (s: string) => Element | null; $$: (s: string) => Element[]; calls: { method: string; url: string; status: number; body?: string }[] }
async function waitFor<T>(fn: () => T | null | undefined | false, label: string, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`); await new Promise((r) => setTimeout(r, 25)); }
}

async function openApp(c: Ctx, l: Login, hash = '#/', override?: (url: string, method: string) => { status: number; body: unknown } | null): Promise<Page> {
  const dom = new JSDOM(read('app.html'), { url: `${BASE}/app${hash}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Page['win'];
  const calls: Page['calls'] = [];
  (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false });
  (win as unknown as { fetch: unknown }).fetch = async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = opts.method ?? 'GET';
    const o = override?.(String(url), method);
    if (o) { calls.push({ method, url: String(url), status: o.status }); return { ok: o.status < 400, status: o.status, json: async () => o.body }; }
    const headers: Record<string, string> = { ...(opts.headers ?? {}), cookie: `aon_session=${l.cookies['aon_session']}` };
    if (method !== 'GET') headers['origin'] = BASE;                                  // browsers add Origin to same-origin mutations
    const res = await c.app.inject({ method: method as 'GET', url: String(url), headers, ...(opts.body ? { payload: opts.body } : {}) });
    calls.push({ method, url: String(url), status: res.statusCode, ...(opts.body ? { body: opts.body } : {}) });
    return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
  };
  for (const f of ['i18n.js', 'common.js', 'app.js']) win.eval(read(f));          // the REAL shipped scripts
  // jsdom fires DOMContentLoaded itself while the document is still 'loading'; only fire manually if it already did.
  if (win.document.readyState !== 'loading') win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  const $ = (s: string) => win.document.querySelector(s); const $$ = (s: string) => [...win.document.querySelectorAll(s)];
  return { dom, doc: win.document, win, $, $$, calls };
}
const type = (p: Page, el: Element, value: string) => { (el as HTMLInputElement).value = value; el.dispatchEvent(new p.win.Event('input', { bubbles: true })); };
const click = (p: Page, el: Element | null) => { if (!el) throw new Error('element not found'); el.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true })); };
const rowOf = (p: Page, key: string) => p.$(`tr[data-key="${key}"]`) as HTMLTableRowElement;
const dmgInput = (p: Page, key: string) => rowOf(p, key).querySelector('input[type="number"]') as HTMLInputElement;

async function setup() {
  const c = await makeApp();
  const l = await login(c, '42', [guildInfo(G1, ADMIN), guildInfo(G2, ADMIN), guildInfo('100000009', ADMIN)]);
  for (const g of [G1, G2]) { c.bot.roles.set(g, [role(g, 0), role('900001', 5), role('900002', 6), role('900003', 60)]); c.bot.top.set(g, 50); }
  await c.app.inject({ method: 'POST', url: `/api/guilds/${G1}/ranks/reset`, headers: { ...l.headers, cookie: `aon_session=${l.cookies['aon_session']}`, 'content-type': 'application/json' }, payload: '{}' });
  return { c, l };
}

describe('dashboard UI against the real backend (jsdom)', () => {
  it('defaults to Arabic RTL, switches to English LTR and back, and translates visible text', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l);
    await waitFor(() => p.$('.card h3'), 'guild list');
    expect(p.doc.documentElement.dir).toBe('rtl'); expect(p.doc.documentElement.lang).toBe('ar');
    expect(p.$('h2')!.textContent).toBe('اختر سيرفراً');
    click(p, p.$('#lang-toggle'));
    await waitFor(() => p.doc.documentElement.dir === 'ltr', 'ltr');
    await waitFor(() => p.$('h2')?.textContent === 'Choose a server', 'english heading');
    click(p, p.$('#lang-toggle')); await waitFor(() => p.doc.documentElement.dir === 'rtl', 'rtl again');
  });
  it('lists only manageable guilds with install state (installed => Manage link, not installed => invite link)', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l);
    await waitFor(() => p.$$('.card').length >= 3, 'cards');
    const links = p.$$('.card a.btn').map((a) => (a as HTMLAnchorElement).getAttribute('href')!);
    expect(links.filter((h) => h.startsWith('#/g/')).length).toBe(2);
    const invite = links.find((h) => h.startsWith('https://discord.com/'))!; expect(invite).toContain('permissions=268435456');
  });
  it('rank editor shows all 17 ranks in ascending order with Arabic names and thresholds', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, '17 rows');
    expect((rowOf(p, 'soldier').querySelector('input') as HTMLInputElement).value).toBe('عسكري');
    expect(dmgInput(p, 'soldier').value).toBe('10000'); expect(dmgInput(p, 'field_marshal').value).toBe('250000000');
    const nums = p.$$('tr[data-key] input[type="number"]').map((i) => Number((i as HTMLInputElement).value)); expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });
  it('typing a threshold that breaks the ordering flags the row, shows the reason and DISABLES saving; fixing it re-enables', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    const save = () => [...p.$$('button')].find((b) => b.textContent === 'حفظ التغييرات') as HTMLButtonElement;
    expect(save().disabled).toBe(false);
    type(p, dmgInput(p, 'lieutenant_colonel'), '4000000');         // below captain (5,000,000)
    expect(rowOf(p, 'lieutenant_colonel').classList.contains('invalid')).toBe(true);
    expect(rowOf(p, 'lieutenant_colonel').querySelector('.errs')!.textContent).toContain('يجب أن يزيد الحد');
    expect(save().disabled).toBe(true);
    type(p, dmgInput(p, 'lieutenant_colonel'), '21000000'); expect(save().disabled).toBe(false);
    type(p, dmgInput(p, 'captain'), '');                           // empty / non-integer
    expect(save().disabled).toBe(true);
    type(p, dmgInput(p, 'captain'), '5.5'); expect(save().disabled).toBe(true);
  });
  it('save: asks for confirmation, lists what changed, then persists (verified in the database)', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    type(p, dmgInput(p, 'captain'), '6000000');
    click(p, [...p.$$('button')].find((b) => b.textContent === 'حفظ التغييرات')!);
    const dlg = await waitFor(() => p.$('.overlay .dialog'), 'confirm dialog');
    expect(dlg.textContent).toMatch(/حدود 1/);
    expect(p.calls.filter((x) => x.method === 'PUT')).toHaveLength(0);                          // nothing sent before confirming
    click(p, [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'تأكيد')!);
    await waitFor(() => p.calls.some((x) => x.method === 'PUT' && x.status === 200), 'PUT 200');
    expect((await getLadder(c.db, G1)).find((r) => r.key === 'captain')!.minDamage).toBe(6_000_000);
  });
  it('cancelling the confirmation sends nothing', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows'); type(p, dmgInput(p, 'captain'), '6000000');
    click(p, [...p.$$('button')].find((b) => b.textContent === 'حفظ التغييرات')!);
    const dlg = await waitFor(() => p.$('.overlay .dialog'), 'dialog');
    click(p, [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'إلغاء')!);
    expect(p.$('.overlay')).toBeNull(); expect(p.calls.filter((x) => x.method === 'PUT')).toHaveLength(0);
  });
  it('add / disable / remove ranks; a disabled rank may sit out of order; same role on two ranks is blocked', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    click(p, [...p.$$('button')].find((b) => b.textContent === 'إضافة رتبة')!); expect(p.$$('tr[data-key]').length).toBe(18);
    click(p, rowOf(p, 'soldier').querySelector('button.danger'));
    const del = await waitFor(() => p.$('.overlay .dialog'), 'delete warning'); expect(del.textContent).toContain('المزامنة الكاملة التالية');
    click(p, [...del.querySelectorAll('button')].find((b) => b.textContent === 'تأكيد')!); await waitFor(() => p.$$('tr[data-key]').length === 17, 'rank removed after confirmation');
    const save = () => [...p.$$('button')].find((b) => b.textContent === 'حفظ التغييرات') as HTMLButtonElement;
    type(p, dmgInput(p, 'major'), '1');                              // invalid while enabled
    expect(save().disabled).toBe(true);
    const cb = rowOf(p, 'major').querySelector('input[type="checkbox"]') as HTMLInputElement; cb.checked = false; cb.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect(save().disabled).toBe(false);                             // disabled ranks are excluded from ordering
    const sels = ['corporal', 'sergeant'].map((k) => rowOf(p, k).querySelector('select') as HTMLSelectElement);
    for (const s of sels) { s.value = '900001'; s.dispatchEvent(new p.win.Event('change', { bubbles: true })); }
    expect(save().disabled).toBe(true); expect(rowOf(p, 'sergeant').querySelector('.errs')!.textContent).toContain('نفس رتبة ديسكورد');
  });
  it('a rank with no Discord role shows the "earned but no role" hint; roles the bot cannot manage are labelled', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    expect(rowOf(p, 'soldier').querySelector('.hint')!.textContent).toContain('لم تُربط');
    const opts = [...rowOf(p, 'soldier').querySelectorAll('option')].map((o) => o.textContent!);
    expect(opts.some((t) => t.includes('900003') || t.includes('role-900003'))).toBe(true);
    expect(opts.find((t) => t.includes('role-900003'))).toContain('⚠');
  });
  it('server-side rejection (422) is shown on the offending row and nothing is silently accepted', async () => {
    const { c, l } = await setup();
    const p = await openApp(c, l, `#/g/${G1}/ranks`, (url, method) => method === 'PUT' && url.endsWith('/ranks') ? { status: 422, body: { error: 'invalid_ladder', issues: [{ code: 'THRESHOLD_NOT_INCREASING', rankKey: 'major', message: 'Major must require more than Captain' }] } } : null);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows'); type(p, dmgInput(p, 'captain'), '6000000');
    click(p, [...p.$$('button')].find((b) => b.textContent === 'حفظ التغييرات')!);
    click(p, [...(await waitFor(() => p.$('.overlay .dialog'), 'dialog')).querySelectorAll('button')].find((b) => b.textContent === 'تأكيد')!);
    await waitFor(() => rowOf(p, 'major').querySelector('.errs')!.textContent!.includes('Major must require'), 'server error on row');
    expect(rowOf(p, 'major').classList.contains('invalid')).toBe(true);
  });
  it('XSS: hostile rank names / usernames are rendered as inert text', async () => {
    const { c, l } = await setup();
    await c.db.query(`UPDATE military_ranks SET name_en=$1 WHERE guild_id=$2 AND key='soldier'`, ['<img src=x onerror=alert(1)>', G1]);
    const link = await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: '<script>alert(1)</script>' }); void link;
    const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    expect(p.$$('img[src="x"]')).toHaveLength(0); expect((rowOf(p, 'soldier').querySelectorAll('input')[1] as HTMLInputElement).value).toBe('<img src=x onerror=alert(1)>');
    p.win.location.hash = `#/g/${G1}/players`;
    await waitFor(() => p.$$('tbody tr').some((r) => r.textContent!.includes('<script>')), 'player row');
    expect(p.$$('script').filter((x) => !x.hasAttribute('src'))).toHaveLength(0);   // no inline script was ever created
    expect(p.$$('script[src]')).toHaveLength(3);                                  // only the page's own three files
  });
  it('mappings: add through the form, appears in the table; delete removes it', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/roles`);
    await waitFor(() => p.$('.card select'), 'form');
    const [kind, , ] = p.$$('.card select') as HTMLSelectElement[]; kind!.value = 'president';
    const roleSel = p.$$('.card select')[1] as HTMLSelectElement; roleSel.value = '900001';
    click(p, [...p.$$('button')].find((b) => b.textContent === 'إضافة ربط')!);
    await waitFor(() => p.$$('tbody tr').length === 1, 'mapping row');
    expect(p.$('tbody tr')!.textContent).toContain('الرئيس');
    click(p, p.$('tbody tr button.danger')); await waitFor(() => p.$$('tbody tr').length === 0, 'row removed');
  });
  it('players: approve a pending request from the UI', async () => {
    const { c, l } = await setup(); await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: 'One' });
    const p = await openApp(c, l, `#/g/${G1}/players`);
    const btn = await waitFor(() => [...p.$$('button')].find((b) => b.textContent === 'موافقة'), 'approve button'); click(p, btn);
    await waitFor(() => p.calls.some((x) => x.url.endsWith('/approve') && x.status === 200), 'approve call');
    expect(await listLinks(c.db, G1, 'verified')).toHaveLength(1);
  });
  it('setup page no longer carries a free-form interval (scheduling lives on the Sync page)', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/setup`);
    await waitFor(() => p.$('.card select'), 'form');
    expect(p.$('input[type="number"][max="10080"]')).toBeNull(); expect(p.$('#sync-interval')).toBeNull();
  });
  it('sync page starts a sync through the API', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/sync`);
    const start = await waitFor(() => [...p.$$('button')].find((b) => b.textContent === 'مزامنة الآن'), 'start button'); click(p, start);
    await waitFor(() => c.syncCalls.length === 1, 'sync call'); expect(c.syncCalls[0]).toEqual([G1, '42']);
  });
  it('a 401 from the API tells the user the session ended', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/overview`, (url) => (url.includes('/overview') ? { status: 401, body: { error: 'unauthenticated' } } : null));
    await waitFor(() => p.$('.toast.bad'), 'session toast'); expect(p.$('.toast.bad')!.textContent).toContain('انتهت الجلسة');
  });
});

describe('server setup page', () => {
  it('choosing a community type pre-selects its modules (editable), alliance is shown as unavailable and cannot be ticked', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/setup`);
    await waitFor(() => p.$('#mod-government'), 'form');
    const box = (id: string) => p.$(id) as HTMLInputElement; const type = p.$$('.card select')[1] as HTMLSelectElement;
    type.value = 'party'; type.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect([box('#mod-government').checked, box('#mod-party').checked, box('#mod-unit').checked]).toEqual([false, true, false]);
    expect(p.$('#preset-note')!.hasAttribute('hidden')).toBe(false);
    type.value = 'military_unit'; type.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect([box('#mod-government').checked, box('#mod-party').checked, box('#mod-unit').checked]).toEqual([false, false, true]);
    expect(box('#mod-alliance').disabled).toBe(true); expect(box('#mod-alliance').checked).toBe(false);
    expect(p.$('#alliance-note')!.textContent).toContain('غير متاحة بعد');
  });
  it('saves link mode, the unit-leader option and modules; the military system stays an independent switch', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/setup`);
    await waitFor(() => p.$('#mod-government'), 'form');
    expect((p.$('#mod-ranks') as HTMLInputElement).checked).toBe(false);                       // optional: off by default
    const selects = p.$$('.card select') as HTMLSelectElement[]; const linkMode = selects[selects.length - 1]!;
    expect([...linkMode.options].map((o) => o.value)).toEqual(['direct', 'staff_approval']); expect(linkMode.value).toBe('direct');
    expect(p.$('.card')!.textContent).toContain('لا يثبت أن العضو يملك حساب اللعبة');          // the limitation is stated in the UI
    linkMode.value = 'staff_approval'; (p.$('#unit-leader-replaces') as HTMLInputElement).checked = true; (p.$('#mod-unit') as HTMLInputElement).checked = true;
    click(p, [...p.$$('button')].find((b) => b.textContent === 'حفظ')!);
    await waitFor(() => p.$('.toast:not(.bad)'), 'saved');
    expect(await getGuildConfig(c.db, G1)).toMatchObject({ linkMode: 'staff_approval', unitLeaderReplacesMember: true });
    expect((await getGuildConfig(c.db, G1))!.modules).toEqual({ government: true, party: false, unit: true, alliance: false, ranks: false });
  });
});

describe('role mappings page', () => {
  const opts = (p: Page) => [...p.$$('#map-kind optgroup')].map((g) => [g.getAttribute('label'), [...g.querySelectorAll('option')].map((o) => o.getAttribute('value'))] as const);
  it('groups kinds by community type, includes party roles, and offers no alliance mapping', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/roles`);
    await waitFor(() => p.$('#map-kind'), 'form'); const g = opts(p);
    expect(g.map((x) => x[0])).toEqual(['سيرفر الدولة', 'سيرفر الحزب', 'سيرفر الوحدة العسكرية', 'سيرفر التحالف (غير متاح بعد)']);
    expect(g[0]![1]).toEqual(['president', 'vice_president', 'minister_defense', 'minister_foreign', 'minister_economy', 'congress', 'citizen', 'government_role']);
    expect(g[1]![1]).toEqual(['party_leader', 'party_role', 'party_member']); expect(g[2]![1]).toEqual(['unit_leader', 'unit_member']);
    expect(g[3]![1]).toEqual(['']); expect(p.$('#map-kind optgroup:last-child option')!.hasAttribute('disabled')).toBe(true);       // not selectable
    expect([...p.$$('#map-kind option')].some((o) => (o.getAttribute('value') ?? '').startsWith('alliance'))).toBe(false);
  });
  it('kinds that need the game value refuse to submit without it; values the bot saw in the last sync are offered as one-click chips', async () => {
    const { c, l } = await setup();
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status, finished_at, counts, details) VALUES ($1,'all','succeeded', now(), '{}'::jsonb, $2::jsonb)`, [G1, JSON.stringify({ seenRoles: { party: { leader: 1, treasurer: 2 }, unit: {}, governmentUnknown: ['ministerForeign'] } })]);
    const p = await openApp(c, l, `#/g/${G1}/roles`); await waitFor(() => p.$('#map-kind'), 'form');
    const kind = p.$('#map-kind') as HTMLSelectElement; const role = p.$$('.card select')[1] as HTMLSelectElement; const add = [...p.$$('button')].find((b) => b.textContent === 'إضافة ربط')!;
    kind.value = 'party_role'; kind.dispatchEvent(new p.win.Event('change', { bubbles: true })); role.value = '900001';
    expect([...p.$$('#seen-values button')].map((b) => b.textContent)).toEqual(['leader', 'treasurer']);
    click(p, add); await waitFor(() => p.$('.toast.bad'), 'needs value'); expect(p.$('.toast.bad')!.textContent).toContain('يتطلب قيمة'); expect(p.calls.filter((x) => x.method === 'POST')).toHaveLength(0);
    click(p, [...p.$$('#seen-values button')].find((b) => b.textContent === 'treasurer')!); expect((p.$('#map-ref') as HTMLInputElement).value).toBe('treasurer');
    click(p, add); await waitFor(() => p.$$('tbody tr').length === 1, 'row'); expect(p.$('tbody tr')!.textContent).toContain('treasurer');
    const kind2 = p.$('#map-kind') as HTMLSelectElement;                                      // the page re-rendered after the add: use the new elements
    kind2.value = 'minister_foreign'; kind2.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect([...p.$$('#seen-values button')].map((b) => b.textContent)).toEqual(['ministerForeign']);
  });
  it('sensitive roles and roles already used as military ranks cannot be picked', async () => {
    const { c, l } = await setup();
    c.bot.roles.set(G1, [...c.bot.roles.get(G1)!, role('930001', 3, { permissions: String(0x8) })]);
    const ranks = await getLadder(c.db, G1); await saveLadder(c.db, G1, ranks.map((r) => (r.key === 'captain' ? { ...r, discordRoleId: '900002' } : r)), null);
    const p = await openApp(c, l, `#/g/${G1}/roles`); await waitFor(() => p.$('#map-kind'), 'form');
    const options = [...(p.$$('.card select')[1] as HTMLSelectElement).options];
    expect(options.find((o) => o.value === '930001')!.disabled).toBe(true); expect(options.find((o) => o.value === '930001')!.textContent).toContain('غير مسموحة');
    expect(options.find((o) => o.value === '900002')!.disabled).toBe(true); expect(options.find((o) => o.value === '900002')!.textContent).toContain('مستخدمة في ربط آخر');
    expect(options.find((o) => o.value === '900001')!.disabled).toBe(false);
  });
});

describe('military-rank editor: optional system, reorder, deletion', () => {
  it('system off + no ranks: shows the OFF banner and a single switch; turning it on creates the 17 starter ranks', async () => {
    const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, ADMIN)]);
    c.bot.roles.set(G1, [role(G1, 0), role('900001', 5)]); c.bot.top.set(G1, 50);
    const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$('#rank-system-banner'), 'banner'); expect(p.$('#rank-system-banner')!.textContent).toContain('معطّل'); expect(p.$$('tr[data-key]')).toHaveLength(0);
    click(p, p.$('#rank-system-toggle')); await waitFor(() => p.$$('tr[data-key]').length === 17, 'ranks created');
    expect(p.$('#rank-system-banner')!.textContent).toContain('مفعّل'); expect((await getGuildConfig(c.db, G1))!.modules.ranks).toBe(true);
    click(p, p.$('#rank-system-toggle')); await waitFor(() => p.$('#rank-system-banner')?.textContent?.includes('معطّل'), 'off again');
    expect((await getLadder(c.db, G1))).toHaveLength(17);                                      // turning it off keeps the configuration
  });
  it('moving a rank swaps positions but the thresholds stay in their slots, so the ladder remains valid', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/ranks`);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    const before = p.$$('tr[data-key] input[type="number"]').map((i) => (i as HTMLInputElement).value);
    click(p, [...rowOf(p, 'corporal').querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'أعلى')!);       // corporal (2nd) moves above soldier (1st)
    expect(p.$$('tr[data-key]').map((r) => (r as HTMLElement).dataset['key']).slice(0, 2)).toEqual(['corporal', 'soldier']);
    expect(p.$$('tr[data-key] input[type="number"]').map((i) => (i as HTMLInputElement).value)).toEqual(before);                   // thresholds stayed in place
    expect((p.$$('button').find((b) => b.textContent === 'حفظ التغييرات') as HTMLButtonElement).disabled).toBe(false);              // still valid
  });
  it('a role that is already a mapped role cannot be chosen for a rank; server 409/422 errors are explained', async () => {
    const { c, l } = await setup(); await c.app.inject({ method: 'POST', url: `/api/guilds/${G1}/mappings`, headers: { ...l.headers, cookie: `aon_session=${l.cookies['aon_session']}`, 'content-type': 'application/json' }, payload: JSON.stringify({ kind: 'president', discordRoleId: '900001' }) });
    const p = await openApp(c, l, `#/g/${G1}/ranks`, (url, method) => method === 'PUT' && url.endsWith('/ranks') ? { status: 409, body: { error: 'sync_running' } } : null);
    await waitFor(() => p.$$('tr[data-key]').length === 17, 'rows');
    const opt = [...rowOf(p, 'soldier').querySelectorAll('option')].find((o) => (o as HTMLOptionElement).value === '900001') as HTMLOptionElement;
    expect(opt.disabled).toBe(true); expect(opt.textContent).toContain('مستخدمة في ربط آخر');
    type(p, dmgInput(p, 'captain'), '6000000'); click(p, [...p.$$('button')].find((b) => b.textContent === 'حفظ التغييرات')!);
    click(p, [...(await waitFor(() => p.$('.overlay .dialog'), 'dialog')).querySelectorAll('button')].find((b) => b.textContent === 'تأكيد')!);
    await waitFor(() => p.$('.toast.bad'), 'toast'); expect(p.$('.toast.bad')!.textContent).toContain('أثناء مزامنة جارية');
  });
});

describe('players page', () => {
  it('shows how each link was made; direct links are flagged as name-only', async () => {
    const { c, l } = await setup(); await claimLink(c.db, { guildId: G1, discordUserId: '555551', playerId: 'p1', username: 'One', direct: true });
    const p = await openApp(c, l, `#/g/${G1}/players`);
    await waitFor(() => p.$('tbody tr'), 'row'); expect(p.$('tbody tr')!.textContent).toContain('اسم فقط (الملكية غير مثبتة)');
  });
});

describe('sync page: schedule controls and transparency', () => {
  const sched = (p: Page) => ({ auto: p.$('#auto-sync') as HTMLInputElement, interval: p.$('#sync-interval') as HTMLSelectElement, save: [...p.$$('button')].find((b) => b.textContent === 'حفظ') as HTMLButtonElement });
  it('offers exactly 3 / 6 / 12 / 24 hours, defaults to 6 hours off, and shows "not scheduled"', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/sync`);
    await waitFor(() => p.$('#sync-status'), 'status card');
    const { auto, interval } = sched(p);
    expect([...interval.options].map((o) => [o.value, o.textContent])).toEqual([['3', 'كل 3 ساعات'], ['6', 'كل 6 ساعات'], ['12', 'كل 12 ساعة'], ['24', 'كل 24 ساعة']]);
    expect(auto.checked).toBe(false); expect(interval.value).toBe('6');
    const card = p.$('#sync-status')!.textContent!;
    expect(card).toContain('غير مجدولة'); expect(card).toContain('لم تتم بعد'); expect(card).toContain('خاملة');
  });
  it('saving the schedule persists it in the database and updates the next-run display', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/sync`);
    await waitFor(() => p.$('#sync-status'), 'status');
    const { auto, interval, save } = sched(p); auto.checked = true; interval.value = '12'; click(p, save);
    await waitFor(() => p.$('.toast:not(.bad)')?.textContent?.includes('تم حفظ الجدولة'), 'saved toast');
    const row = (await c.db.query<{ auto_sync_enabled: boolean; sync_interval_minutes: number; next_sync_at: Date | null }>('SELECT auto_sync_enabled, sync_interval_minutes, next_sync_at FROM guilds WHERE guild_id=$1', [G1])).rows[0]!;
    expect(row).toMatchObject({ auto_sync_enabled: true, sync_interval_minutes: 720 }); expect(row.next_sync_at).not.toBeNull();
    await waitFor(() => p.$('#sync-status')!.textContent!.includes('كل 12 ساعة'), 'status refreshed');
    expect(p.$('#sync-status')!.textContent).not.toContain('غير مجدولة');
  });
  it('shows last successful sync, last result, roles added/removed and translated reasons (Arabic, then English)', async () => {
    const { c, l } = await setup();
    await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status, created_at, finished_at, counts, details) VALUES ($1,'scheduled','succeeded', now() - interval '2 hours', now() - interval '2 hours', $2::jsonb, $3::jsonb)`,
      [G1, JSON.stringify({ rolesAdded: 4, rolesRemoved: 2, processed: 10, total: 10, skipped: 1, failed: 0 }), JSON.stringify({ skippedReasons: { alliance_data_unverified: 2, roster_rate_limited: 1 }, blockedReasons: { discord_role_deleted: 1 }, lookupFailures: { 'roster:rate_limited': 1 }, errors: [] })]);
    const p = await openApp(c, l, `#/g/${G1}/sync`);
    await waitFor(() => p.$('#sync-details'), 'details');
    const t1 = p.$('#sync-status')!.textContent!; expect(t1).not.toContain('لم تتم بعد'); expect(t1).toContain('رتب أُضيفت 4'); expect(t1).toContain('أُزيلت 2');
    const d1 = p.$('#sync-details')!.textContent!;
    expect(d1).toContain('بيانات التحالفات غير متاحة'); expect(d1).toContain('قائمة الحكومة: تجاوز حد الطلبات'); expect(d1).toContain('الرتبة محذوفة من ديسكورد'); expect(d1).toContain('لا تُسحب أي رتبة');
    click(p, p.$('#lang-toggle'));
    await waitFor(() => p.$('#sync-status')?.textContent?.includes('Roles added 4'), 'english status');
    expect(p.$('#sync-status')!.textContent).toContain('removed 2');
    expect(p.$('#sync-details')!.textContent).toContain('alliance data is not available'); expect(p.$('#sync-details')!.textContent).toContain('Government roster: rate limited');
  });
  it('a running sync disables Sync now, enables Cancel, and is labelled running', async () => {
    const { c, l } = await setup(); await c.db.query(`INSERT INTO sync_jobs (guild_id, kind, status) VALUES ($1,'all','running')`, [G1]);
    const p = await openApp(c, l, `#/g/${G1}/sync`);
    await waitFor(() => p.$('#sync-status')?.textContent?.includes('قيد التنفيذ'), 'running');
    const btn = (label: string) => [...p.$$('button')].find((b) => b.textContent === label) as HTMLButtonElement;
    expect(btn('مزامنة الآن').disabled).toBe(true); expect(btn('إلغاء المزامنة').disabled).toBe(false);
  });
  it('overview shows the next scheduled sync (or that it is off)', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/overview`);
    await waitFor(() => p.$$('.card').length >= 4, 'overview'); expect(p.$('#tab-content')!.textContent).toContain('غير مجدولة');
  });
});

describe('logo and branding', () => {
  const BRAND = join(PUB, 'brand');
  it('uses the supplied logo (not the placeholder) in the header, the landing hero and every favicon link', () => {
    for (const f of ['landing.html', 'app.html']) {
      const h = read(f);
      expect(h, f).toContain('/static/brand/mark-64.png'); expect(h, f).toContain('/static/brand/favicon.ico'); expect(h, f).toContain('apple-touch-icon'); expect(h, f).not.toContain('placeholder'); expect(h, f).toContain('<title>AoN Role Bot</title>');
    }
    expect(read('landing.html')).toContain('/static/brand/logo-full-256.webp');
  });
  it('every referenced brand file exists with the expected size; the web variants are far lighter than the 1.4 MB source', async () => {
    const { statSync, existsSync } = await import('node:fs');
    const sizes: Record<string, [number, number]> = { 'logo-full-1024.png': [1024, 1024], 'logo-full-512.webp': [512, 512], 'logo-full-256.webp': [256, 256], 'mark-256.png': [256, 256], 'mark-128.png': [128, 128], 'mark-64.png': [64, 64], 'favicon-32.png': [32, 32], 'favicon-48.png': [48, 48], 'apple-touch-icon.png': [180, 180], 'bot-avatar-1024.png': [1024, 1024] };
    for (const [f, [w, h]] of Object.entries(sizes)) {
      const buf = readFileSync(join(BRAND, f));
      if (f.endsWith('.png')) { expect(buf.readUInt32BE(16), f).toBe(w); expect(buf.readUInt32BE(20), f).toBe(h); }
      else { expect(buf.subarray(0, 4).toString(), f).toBe('RIFF'); expect(buf.subarray(8, 12).toString(), f).toBe('WEBP'); }
    }
    expect(existsSync(join(BRAND, 'favicon.ico'))).toBe(true); expect(existsSync(join(BRAND, 'source', 'aon-role-bot-logo.png'))).toBe(true);
    expect(statSync(join(BRAND, 'logo-full-512.webp')).size).toBeLessThan(60_000); expect(statSync(join(BRAND, 'mark-64.png')).size).toBeLessThan(15_000);
  });
  it('the real assets are served with the right content types, plus /favicon.ico', async () => {
    const c = await makeApp({ publicDir: PUB });
    const png = await c.app.inject({ method: 'GET', url: '/static/brand/mark-64.png' }); expect(png.statusCode).toBe(200); expect(png.headers['content-type']).toBe('image/png'); expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const webp = await c.app.inject({ method: 'GET', url: '/static/brand/logo-full-256.webp' }); expect(webp.statusCode).toBe(200); expect(webp.headers['content-type']).toBe('image/webp');
    const ico = await c.app.inject({ method: 'GET', url: '/favicon.ico' }); expect(ico.statusCode).toBe(200); expect(ico.headers['content-type']).toBe('image/x-icon');
    expect((await c.app.inject({ method: 'GET', url: '/' })).body).toContain('logo-full-256.webp');
    expect((await c.app.inject({ method: 'GET', url: '/static/brand/../../src/app.ts' })).statusCode).not.toBe(200);
  });
  it('branding is easy to replace: one source file + one script regenerate every variant', () => {
    expect(readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'make-brand-assets.py'), 'utf8')).toContain('aon-role-bot-logo.png');
    expect(readFileSync(join(BRAND, 'README.md'), 'utf8')).toMatch(/replace/i);
  });
});

describe('static assets (CSP + safety)', () => {
  it('no inline scripts/styles/handlers (CSP script-src/style-src self), no unsafe DOM APIs in shipped JS', () => {
    for (const f of readdirSync(PUB).filter((x) => /\.(html|js|css)$/.test(x))) {
      const s = read(f);
      if (f.endsWith('.html')) { expect(s, f).not.toMatch(/<script(?![^>]*\ssrc=)/); expect(s, f).not.toMatch(/\sstyle=|\son\w+=/); expect(s, f).toMatch(/lang="ar" dir="rtl"/); expect(s, f).toContain('name="viewport"'); }
      if (f.endsWith('.js')) expect(s, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
      if (f.endsWith('.css')) expect(s, f).not.toMatch(/@import|url\(\s*['"]?https?:/);
    }
  });
  it('Arabic and English dictionaries have identical keys and placeholders', () => {
    const w = { I18N: undefined as unknown } as { I18N: Record<'ar' | 'en', Record<string, string>> }; new Function('window', read('i18n.js'))(w);
    const { ar, en } = w.I18N; expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of Object.keys(en)) expect(ph(ar[k]!), k).toBe(ph(en[k]!));
    for (const k of ['k_president', 'e_forbidden', 'rk_err_order', 'rk_confirm_d']) expect(ar[k]).not.toBe(en[k]);
  });
  it('landing page uses logical CSS only for direction-sensitive layout (no left/right properties)', () => {
    expect(read('app.css')).not.toMatch(/(^|[;{\s])(margin|padding)-(left|right)\s*:|text-align\s*:\s*(left|right)|\b(left|right)\s*:\s*\d/);
  });
});
