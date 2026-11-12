import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { getGuildConfig, getLadder, claimLink, listLinks, saveLadder, updateGuildSettings } from '@aon/db';
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
  for (const f of ['i18n.js', 'common.js', 'picker.js', 'app.js']) win.eval(read(f));          // the REAL shipped scripts
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
    expect(p.$$('script[src]')).toHaveLength(4);                                  // only the page's own four files (i18n, common, picker, app)
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
  it('choosing a community type shows ONLY the modules it offers (pre-selected, editable); alliance is not offered anywhere in setup', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/setup`);
    await waitFor(() => p.$('#mod-government'), 'form');
    const box = (id: string) => p.$(id) as HTMLInputElement | null; const type = p.$$('.card select')[1] as HTMLSelectElement;
    expect([...type.options].map((o) => o.value)).toEqual(['general', 'country', 'party', 'military_unit']);   // no alliance option
    type.value = 'party'; type.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect(box('#mod-government')).toBeNull(); expect(box('#mod-unit')).toBeNull(); expect(box('#mod-party')!.checked).toBe(true); expect(box('#mod-ranks')).not.toBeNull();
    expect(p.$('#preset-note')!.hasAttribute('hidden')).toBe(false);
    type.value = 'military_unit'; type.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect(box('#mod-party')).toBeNull(); expect(box('#mod-unit')!.checked).toBe(true);
    type.value = 'country'; type.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    expect(['#mod-government', '#mod-party', '#mod-unit', '#mod-ranks'].every((id) => box(id))).toBe(true); expect(box('#mod-government')!.checked).toBe(true); expect(box('#mod-unit')!.checked).toBe(false);
    expect(p.$('#mod-alliance')).toBeNull(); expect(p.$('#alliance-note')).toBeNull(); expect(p.$('.card')!.textContent).not.toContain('تحالف');
  });
  it('a legacy guild that already stores the alliance type sees only a disabled, localized "Closed" option (no "coming soon")', async () => {
    const { c, l } = await setup();
    await c.db.query(`UPDATE guilds SET community_type='alliance' WHERE guild_id=$1`, [G1]);
    const p = await openApp(c, l, `#/g/${G1}/setup`); await waitFor(() => p.$('#type-desc')?.textContent, 'form');
    const type = p.$$('.card select')[1] as HTMLSelectElement; const o = [...type.options].find((x) => x.value === 'alliance')!;
    expect(p.$('#type-desc')!.textContent).toContain('التحالف'); expect(p.$('#mod-government')).toBeNull(); expect(p.$('.picker')).toBeNull();        // legacy data is kept, nothing new is offered
    expect(o.disabled).toBe(true); expect(o.textContent).toContain('مغلق'); expect(o.textContent).not.toMatch(/قريب|بعد/);
  });
  it('saves link mode, the unit-leader option and modules; the military system stays an independent switch', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/setup`);
    await waitFor(() => p.$('#mod-government'), 'form');
    expect((p.$('#mod-ranks') as HTMLInputElement).checked).toBe(false);                       // optional: off by default
    const selects = p.$$('.card select') as HTMLSelectElement[]; const linkMode = selects[selects.length - 1]!;
    expect([...linkMode.options].map((o) => o.value)).toEqual(['direct', 'staff_approval']); expect(linkMode.value).toBe('direct');
    expect(p.$('#advanced')!.textContent).toContain('لا يثبت أن العضو يملك حساب اللعبة');          // the limitation is stated in the UI (under Advanced options)
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
    expect(g.map((x) => x[0])).toEqual(['سيرفر الدولة', 'سيرفر الحزب', 'سيرفر الوحدة العسكرية']);
    expect(g[0]![1]).toEqual(['president', 'vice_president', 'minister_defense', 'minister_foreign', 'minister_economy', 'congress', 'citizen', 'government_role']);
    expect(g[1]![1]).toEqual(['party_leader', 'party_role', 'party_member']); expect(g[2]![1]).toEqual(['unit_leader', 'unit_member']);
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

describe('player build roles page', () => {
  const sel = (p: Page, k: string) => p.$(`#build-${k}`) as HTMLSelectElement;
  it('always shows the three entries, explains an unset build, and saves the chosen roles', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/builds`);
    await waitFor(() => p.$('#build-war'), 'form');
    expect(['war', 'eco', 'hybrid'].every((k) => p.$(`#card-${k}`))).toBe(true); expect(p.$('#card-war')!.textContent).toContain('غير محدد');
    sel(p, 'war').value = '900001'; sel(p, 'war').dispatchEvent(new p.win.Event('change', { bubbles: true })); sel(p, 'eco').value = '900002'; sel(p, 'eco').dispatchEvent(new p.win.Event('change', { bubbles: true }));
    click(p, p.$('#builds-save')); await waitFor(() => p.calls.some((x) => x.method === 'PUT' && x.url.endsWith('/builds') && x.status === 200), 'saved');
    const { getBuildRoles } = await import('@aon/db'); expect(await getBuildRoles(c.db, G1)).toEqual({ war: '900001', eco: '900002', hybrid: null });
  });
  it('the same role for two builds disables saving and shows why; the rules are explained in the selected language', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/builds`); await waitFor(() => p.$('#build-war'), 'form');
    for (const k of ['war', 'eco']) { sel(p, k).value = '900001'; sel(p, k).dispatchEvent(new p.win.Event('change', { bubbles: true })); }
    expect((p.$('#builds-save') as HTMLButtonElement).disabled).toBe(true); expect(p.$('#card-eco')!.textContent).toContain('الدور نفسه');
    expect(p.$('details')!.textContent).toContain('نتيجة الحرب');
  });
  it('roles used as military ranks or mappings are not selectable', async () => {
    const { c, l } = await setup(); await c.app.inject({ method: 'POST', url: `/api/guilds/${G1}/mappings`, headers: { ...l.headers, cookie: `aon_session=${l.cookies['aon_session']}`, 'content-type': 'application/json' }, payload: JSON.stringify({ kind: 'president', discordRoleId: '900002' }) });
    const p = await openApp(c, l, `#/g/${G1}/builds`); await waitFor(() => p.$('#build-war'), 'form');
    expect((([...sel(p, 'war').options].find((o) => o.value === '900002')) as HTMLOptionElement).disabled).toBe(true);
  });
});

// ====================================================================== Phase 2: design system, landing page, app shell
describe('app shell (sidebar, server switcher, mobile drawer, page header)', () => {
  it('renders grouped sidebar navigation with icons, marks the current page, and shows the page title + short description', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/builds`);
    await waitFor(() => p.$('#build-war'), 'builds page');
    const groups = p.$$('#nav .nav-group h4').map((h) => h.textContent); expect(groups).toEqual(['عام', 'الرتب', 'المجتمع', 'التشغيل']);
    const links = p.$$('#nav a'); expect(links.length).toBe(10); expect(links.every((a) => a.querySelector('svg.icon'))).toBe(true);
    const cur = p.$$('#nav a[aria-current="page"]'); expect(cur.length).toBe(1); expect((cur[0] as HTMLAnchorElement).getAttribute('href')).toBe(`#/g/${G1}/builds`);
    expect(p.$('.page-head h2')!.textContent).toBe('أدوار البناء'); expect(p.$('.page-head p')!.textContent!.length).toBeGreaterThan(5);
  });
  it('server switcher shows the current server and offers the other installed servers plus "all servers"', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/overview`);
    await waitFor(() => p.$('#switcher .name'), 'switcher'); expect(p.$('#switcher .name')!.textContent).toBe(`Guild ${G1}`);
    const menu = p.$('#switcher .menu') as HTMLElement; expect(menu.hidden).toBe(true);
    click(p, p.$('#switcher > button')); expect(menu.hidden).toBe(false); expect(p.$('#switcher > button')!.getAttribute('aria-expanded')).toBe('true');
    const hrefs = [...menu.querySelectorAll('a')].map((a) => a.getAttribute('href')); expect(hrefs).toEqual([`#/g/${G2}/overview`, '#/']);   // current guild and the not-installed one are not listed
    p.doc.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(menu.hidden).toBe(true);
  });
  it('mobile drawer: the menu button opens/closes the sidebar and scrim, Escape closes, and navigating closes it', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/overview`); await waitFor(() => p.$('#nav a'), 'nav');
    const side = p.$('#sidebar')!; const btn = p.$('#menu-toggle')!;
    expect(side.classList.contains('open')).toBe(false); click(p, btn);
    expect(side.classList.contains('open')).toBe(true); expect(p.$('#scrim')!.classList.contains('show')).toBe(true); expect(btn.getAttribute('aria-expanded')).toBe('true');
    p.doc.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(side.classList.contains('open')).toBe(false); expect(btn.getAttribute('aria-expanded')).toBe('false');
    click(p, btn); p.win.location.hash = `#/g/${G1}/sync`; await waitFor(() => !side.classList.contains('open'), 'closed on navigation');
  });
  it('the guild list keeps a minimal sidebar (all servers) and hides the server switcher', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l); await waitFor(() => p.$$('.card').length >= 3, 'cards');
    expect((p.$('#switcher') as HTMLElement).hidden).toBe(true); expect(p.$$('#nav a').length).toBe(1);
  });
});

describe('language switching keeps the page state', () => {
  it('unsaved form values (including a changed server type that rebuilds the form), the selected server and tab survive an Arabic→English→Arabic switch without any save', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/setup`);
    await waitFor(() => p.$('#mod-government'), 'form');
    const typeSel = () => p.$$('#tab-content .card select')[1] as HTMLSelectElement; const search = () => p.$('#tab-content .picker-input') as HTMLInputElement;
    typeSel().value = 'party'; typeSel().dispatchEvent(new p.win.Event('change', { bubbles: true }));          // rebuilds the area: party picker + party/ranks modules only
    (p.$('#mod-ranks') as HTMLInputElement).checked = true; type(p, search(), 'unsaved-search');
    const writesBefore = p.calls.filter((x) => x.method !== 'GET').length;
    click(p, p.$('#lang-toggle')); await waitFor(() => p.doc.documentElement.dir === 'ltr', 'ltr');
    await waitFor(() => (p.$('#tab-content .picker-input') as HTMLInputElement | null)?.value === 'unsaved-search', 'restored');
    expect(typeSel().value).toBe('party'); expect((p.$('#mod-ranks') as HTMLInputElement).checked).toBe(true); expect((p.$('#mod-party') as HTMLInputElement).checked).toBe(true); expect(p.$('#mod-government')).toBeNull();
    expect(p.win.location.hash).toBe(`#/g/${G1}/setup`); expect(p.$('#nav a[aria-current="page"]')!.getAttribute('href')).toBe(`#/g/${G1}/setup`);
    expect(p.$('#nav a[aria-current="page"] span')!.textContent).toBe('Server setup'); expect(p.$('#type-desc')!.textContent).toMatch(/^Party:/);        // texts follow the new language
    click(p, p.$('#lang-toggle')); await waitFor(() => p.doc.documentElement.dir === 'rtl', 'rtl'); await waitFor(() => search()?.value === 'unsaved-search', 'restored again');
    expect(typeSel().value).toBe('party'); expect(p.calls.filter((x) => x.method !== 'GET').length).toBe(writesBefore);       // switching language never saves anything
  });
  it('a saved (auto-applied) value is not re-fired on restore, and switching on another tab does not leak state', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l, `#/g/${G1}/builds`); await waitFor(() => p.$('#build-war'), 'form');
    const war = p.$('#build-war') as HTMLSelectElement; war.value = '900001'; war.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    click(p, p.$('#lang-toggle')); await waitFor(() => p.doc.documentElement.dir === 'ltr', 'ltr');
    await waitFor(() => (p.$('#build-war') as HTMLSelectElement | null)?.value === '900001', 'war role kept');
    p.win.location.hash = `#/g/${G1}/setup`; await waitFor(() => p.$('#mod-government'), 'setup');
    expect((p.$$('#tab-content input.wide')[0] as HTMLInputElement).value).toBe('');      // nothing from the builds page leaked into setup
  });
});

describe('landing page', () => {
  async function openLanding(over: Record<string, unknown> = {}, signedIn = false) {
    const dom = new JSDOM(read('landing.html'), { url: `${BASE}/${over['query'] ?? ''}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window as unknown as Window & typeof globalThis;
    (win as unknown as { fetch: unknown }).fetch = async (url: string) => (String(url).startsWith('/api/public') ? { ok: true, status: 200, json: async () => ({ inviteUrl: 'https://discord.com/oauth2/authorize?client_id=1&permissions=268435456' }) } : { ok: signedIn, status: signedIn ? 200 : 401, json: async () => ({}) });
    for (const f of ['i18n.js', 'common.js', 'landing.js']) win.eval(read(f));
    if (win.document.readyState !== 'loading') win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await waitFor(() => (win.document.getElementById('add-bot') as HTMLAnchorElement).href.startsWith('https://discord.com/'), 'invite url');
    return win;
  }
  it('has the two primary actions (open dashboard, add to Discord) and the invite link is applied to both add-bot buttons', async () => {
    const w = await openLanding(); const d = w.document;
    expect(d.getElementById('open-dashboard')!.getAttribute('href')).toBe('/app'); expect((d.getElementById('add-bot') as HTMLAnchorElement).href).toContain('permissions=268435456');
    expect((d.getElementById('add-bot-2') as HTMLAnchorElement).href).toContain('permissions=268435456');
    expect(d.querySelectorAll('.feature svg.icon').length).toBeGreaterThanOrEqual(9);          // icons are painted
    expect(d.querySelector('h1')!.textContent!.length).toBeGreaterThan(10);
  });
  it('switches to English LTR and back; all visible strings come from the dictionary (no untranslated keys left on the page)', async () => {
    const w = await openLanding(); const d = w.document;
    expect(d.documentElement.dir).toBe('rtl'); (d.getElementById('lang-toggle') as HTMLElement).click();
    expect(d.documentElement.dir).toBe('ltr'); expect(d.querySelector('h1')!.textContent).toBe('Link player accounts to Discord and let roles manage themselves');
    const text = d.body.textContent!; for (const k of [...d.querySelectorAll('[data-i18n]')].map((n) => n.getAttribute('data-i18n')!)) expect(text, k).not.toContain(`${k} `);
    expect([...d.querySelectorAll('[data-i18n]')].every((n) => n.textContent !== n.getAttribute('data-i18n'))).toBe(true);
    (d.getElementById('lang-toggle') as HTMLElement).click(); expect(d.documentElement.dir).toBe('rtl');
  });
  it('signed-in visitors get "dashboard" on the header button; a failed login shows the localized error', async () => {
    const w = await openLanding({ query: '?error=login_failed' }, true); const d = w.document;
    await waitFor(() => d.getElementById('login-btn')!.getAttribute('href') === '/app', 'signed in'); expect(d.getElementById('login-error')!.hidden).toBe(false);
  });
  it('does not advertise unbuilt features or alliances', () => {
    const all = read('landing.html') + read('i18n.js').match(/(?:f\d_[td]|lt_\w+|faq\d_\w|safe_\d|feat_\w+|hero_\w+|chip_\d|cta_\w+): '[^']*'/g)!.join(' ');
    expect(all).not.toMatch(/alliance|تحالف|ticket|تذكر|proxy|بروكسي|nickname|لقب/i);
  });
});

describe('mandatory developer credit', () => {
  it('is the exact English text "Developed by AbuDujana" in both pages (static HTML, so it survives without JS) and in both dictionaries', () => {
    for (const f of ['app.html', 'landing.html']) expect(read(f), f).toContain('Developed by AbuDujana');
    const w = { I18N: undefined as unknown } as { I18N: Record<'ar' | 'en', Record<string, string>> }; new Function('window', read('i18n.js'))(w);
    expect(w.I18N.ar['credit']).toBe('Developed by AbuDujana'); expect(w.I18N.en['credit']).toBe('Developed by AbuDujana');
  });
  it('stays visible and English after a language switch in the dashboard', async () => {
    const { c, l } = await setup(); const p = await openApp(c, l); await waitFor(() => p.$$('.card').length >= 3, 'cards');
    click(p, p.$('#lang-toggle')); await waitFor(() => p.doc.documentElement.dir === 'ltr', 'ltr');
    const credits = p.$$('.credit').map((n) => n.textContent); expect(credits.length).toBeGreaterThanOrEqual(2); expect(new Set(credits)).toEqual(new Set(['Developed by AbuDujana']));
  });
});

describe('design system (static checks; layout itself needs a real browser)', () => {
  it('defines the responsive breakpoints, a mobile drawer, overflow-safe tables, RTL-aware drawer direction and reduced-motion handling', () => {
    const css = read('app.css');
    expect(css).toContain('@media (max-width: 1023px)'); expect(css).toContain('@media (max-width: 640px)'); expect(css).toContain('prefers-reduced-motion');
    expect(css).toMatch(/\.scroll\s*\{[^}]*overflow-x:\s*auto/); expect(css).toMatch(/:root\[dir="rtl"\]\s*\.sidebar\s*\{[^}]*translateX\(105%\)/);
    expect(css).toMatch(/\.grid\s*>\s*\*\s*\{\s*min-inline-size:\s*0/); expect(css).toMatch(/\.row\s*>\s*\*\s*\{\s*min-inline-size:\s*0/);
    expect(css).not.toMatch(/font-size:\s*(?:[0-9.]+)(?:px|rem)[^;]*;[^}]*@media/);   // no "shrink the font to fix layout" overrides inside breakpoints
  });
  it('uses no remote assets and ships a single dark theme (no leftover theme toggle)', () => {
    for (const f of ['app.html', 'landing.html']) expect(read(f), f).not.toContain('theme-toggle');
    expect(read('app.css')).not.toMatch(/https?:\/\//);
  });
});

const key = (p: Page, el: Element, k: string) => el.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
// ====================================================================== Phase 3: type-driven setup, searchable selectors, country reservation
import { addRoleMapping, listRoleMappings } from '@aon/db';

describe('searchable entity selectors (setup page)', () => {
  const game = (c: Ctx) => c.game as unknown as { countriesRes: unknown; parties: unknown; calls: string[]; unitsList: unknown; searchRes: unknown };
  const openSetup = async (c: Ctx, l: Login, g = G1) => { const p = await openApp(c, l, `#/g/${g}/setup`); await waitFor(() => p.$('#type-desc')?.textContent, 'setup form'); return p; };
  const setType = (p: Page, v: string) => { const sel = p.$$('#tab-content .card select')[1] as HTMLSelectElement; sel.value = v; sel.dispatchEvent(new p.win.Event('change', { bubbles: true })); };
  const optionTexts = (p: Page) => p.$$('.picker-list [role="option"]').map((o) => o.textContent);
  const save = (p: Page) => click(p, p.$('#save-settings')!);

  it('country: opens with real names (no raw ids), supports typing, arrow keys + Enter, and the chosen country is saved and reserved', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u'); const p = await openSetup(c, l);
    const input = p.$('.picker-input') as HTMLInputElement; expect(input.getAttribute('role')).toBe('combobox'); expect(input.getAttribute('aria-expanded')).toBe('false');
    input.dispatchEvent(new p.win.Event('focus')); await waitFor(() => optionTexts(p).length === 4, 'first page');
    expect(optionTexts(p).map((x) => x!.replace(/^..?(?=[A-Z])/, ''))).toEqual(expect.arrayContaining(['Egypt', 'Poland'])); expect(p.$('.picker-list')!.textContent).not.toMatch(/\b(eg|pl|de|ee)\b/);   // names only
    expect(input.getAttribute('aria-expanded')).toBe('true'); expect(p.$('.picker-status')!.textContent).toContain('4');
    type(p, input, 'ger'); await waitFor(() => optionTexts(p).length === 1, 'filtered');
    key(p, input, 'ArrowDown'); expect(input.getAttribute('aria-activedescendant')).toBe(p.$('.picker-list [role="option"]')!.id); key(p, input, 'Enter');
    await waitFor(() => p.$('.picker-selected'), 'chosen'); expect(p.$('.picker-selected')!.textContent).toContain('Germany'); expect((p.$('.picker-value') as HTMLInputElement).value).toBe('de');
    save(p); await waitFor(() => p.$('.toast:not(.bad)'), 'saved'); expect((await getGuildConfig(c.db, G1))!.countryId).toBe('de');
    await waitFor(() => p.$('#release-country'), 'reservation controls'); expect(p.$('.badge.ok')).not.toBeNull();
  });
  it('keyboard: ArrowUp wraps, Home/End jump, Escape closes the list without clearing the selection', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u'); const p = await openSetup(c, l);
    const input = p.$('.picker-input') as HTMLInputElement; input.dispatchEvent(new p.win.Event('focus')); await waitFor(() => optionTexts(p).length === 4, 'list');
    key(p, input, 'ArrowUp'); expect(p.$$('.picker-list [role="option"]')[3]!.classList.contains('active')).toBe(true);
    key(p, input, 'Home'); expect(p.$$('.picker-list [role="option"]')[0]!.classList.contains('active')).toBe(true); key(p, input, 'End'); expect(p.$$('.picker-list [role="option"]')[3]!.classList.contains('active')).toBe(true);
    key(p, input, 'Escape'); expect((p.$('.picker-list') as HTMLElement).hidden).toBe(true); expect(input.getAttribute('aria-expanded')).toBe('false');
  });
  it('shows the currently saved selection by NAME (resolved from the game) and keeps it through a reload', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country', country_id: 'eg' }, 'u'); const p = await openSetup(c, l);
    await waitFor(() => p.$('.picker-selected')?.textContent?.includes('Egypt'), 'name resolved'); expect(p.$('.picker-selected')!.textContent).not.toContain('eg');
    expect(p.$('.picker-selected button')).toBeNull();                                  // a reserved country cannot be cleared here: it is released through "Unlink country"
  });
  it('pagination: pages of 20 with "show more", result count, and an empty state for no match', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u');
    game(c).countriesRes = { status: 'ok', data: Array.from({ length: 45 }, (_, i) => ({ id: `c${i}`, name: `Land ${String(i).padStart(2, '0')}` })) };
    const p = await openSetup(c, l); const input = p.$('.picker-input') as HTMLInputElement; input.dispatchEvent(new p.win.Event('focus'));
    await waitFor(() => optionTexts(p).length === 20, 'page 1'); expect(p.$('.picker-status')!.textContent).toContain('45');
    const more = p.$$('.picker-actions button').find((b) => b.textContent === 'عرض المزيد') as HTMLButtonElement; expect(more.hidden).toBe(false); click(p, more);
    await waitFor(() => optionTexts(p).length === 40, 'page 2'); click(p, more); await waitFor(() => optionTexts(p).length === 45, 'page 3'); expect(more.hidden).toBe(true);
    type(p, input, 'zzzz'); await waitFor(() => p.$('.picker-status')!.textContent === 'لا نتائج.', 'empty');
  });
  it('a failed first load shows a retryable error (failures are not cached), and recovers when the game answers', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u'); const g = game(c); g.countriesRes = { status: 'error', message: 'x' };
    const p = await openSetup(c, l); const input = p.$('.picker-input') as HTMLInputElement; input.dispatchEvent(new p.win.Event('focus'));
    await waitFor(() => p.$('.picker-status')!.textContent === 'تعذّر تحميل القائمة.', 'error'); const retry = p.$$('.picker-actions button').find((b) => b.textContent === 'إعادة المحاولة') as HTMLButtonElement; expect(retry.hidden).toBe(false);
    g.countriesRes = { status: 'ok', data: [{ id: 'a', name: 'Land A' }] }; click(p, retry); await waitFor(() => optionTexts(p).length === 1, 'recovered'); expect(retry.hidden).toBe(true);
  });
  it('a rate-limited game says so in plain words instead of showing an empty list', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u'); game(c).countriesRes = { status: 'rate_limited', retryAfterMs: 1 };
    const p = await openSetup(c, l); (p.$('.picker-input') as HTMLInputElement).dispatchEvent(new p.win.Event('focus')); await waitFor(() => p.$('.picker-status')!.textContent!.includes('طلبات كثيرة'), 'rate limited');
    expect(optionTexts(p)).toHaveLength(0);
  });
  it('an unrecognised game response opens the manual-ID fallback (nothing is guessed); a valid manual id is accepted, an invalid one refused', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u'); game(c).countriesRes = { status: 'incomplete', missing: ['countries'] };
    const p = await openSetup(c, l); (p.$('.picker-input') as HTMLInputElement).dispatchEvent(new p.win.Event('focus'));
    await waitFor(() => p.$('.picker-status')!.textContent!.includes('يدوياً'), 'unrecognised'); expect((p.$('.picker-manual') as HTMLDetailsElement).open).toBe(true);
    const manual = p.$('.picker-manual input.wide') as HTMLInputElement; const apply = p.$('.picker-manual button') as HTMLButtonElement;
    type(p, manual, '../x'); click(p, apply); expect((p.$('.picker-manual .err') as HTMLElement).hidden).toBe(false); expect(p.$('.picker-selected')!.hasAttribute('hidden')).toBe(true);
    type(p, manual, 'zz9'); click(p, apply); await waitFor(() => !p.$('.picker-selected')!.hasAttribute('hidden'), 'applied'); expect(p.$('.picker-selected')!.textContent).toContain('العنصر المحدَّد');
    save(p); await waitFor(() => p.$('.toast:not(.bad)'), 'saved'); expect((await getGuildConfig(c.db, G1))!.countryId).toBe('zz9');
  });
  it('party servers: a country filter (not saved) is needed first, then real parties are searchable; the chosen party is saved', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'party' }, 'u');
    game(c).parties = { status: 'ok', data: [{ id: 'pty_1', name: 'Ummah Caliphate Party', leaderId: null, leaderName: null, members: 3, ruling: true }, { id: 'pty_2', name: 'National Party', leaderId: null, leaderName: null, members: 2, ruling: false }] };
    const p = await openSetup(c, l); const [scope, partyIn] = p.$$('.picker-input') as HTMLInputElement[];
    partyIn!.dispatchEvent(new p.win.Event('focus')); await waitFor(() => p.$$('.picker-status')[1]!.textContent === 'اختر الدولة أولاً.', 'needs country');
    scope!.dispatchEvent(new p.win.Event('focus')); await waitFor(() => optionTexts(p).length === 4, 'countries'); key(p, scope!, 'ArrowDown'); key(p, scope!, 'Enter'); await waitFor(() => p.$$('.picker-selected').some((x) => !x.hasAttribute('hidden')), 'scope chosen');
    partyIn!.dispatchEvent(new p.win.Event('blur')); partyIn!.dispatchEvent(new p.win.Event('focus')); await waitFor(() => p.$$('.picker-list [role="option"]').some((o) => o.textContent!.includes('Ummah')), 'parties');
    const opt = p.$$('.picker-list [role="option"]').find((o) => o.textContent!.includes('Ummah'))!; opt.dispatchEvent(new p.win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    save(p); await waitFor(() => p.$('.toast:not(.bad)'), 'saved'); const cfg = await getGuildConfig(c.db, G1); expect(cfg!.partyId).toBe('pty_1'); expect(cfg!.countryId).toBeNull();     // the scope filter was NOT saved
    expect(game(c).calls).toContain('parties:eg');                                       // the (unsaved) country filter scoped the party lookup
  });
  it('unit servers: the game search needs 2+ characters, shows the unverified-source note, and saves the chosen unit', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'military_unit' }, 'u');
    game(c).searchRes = { status: 'ok', data: [{ id: 'mu_9', name: 'Black Eagles', countryId: 'pl', ownerId: null, ownerName: null, members: 1, capacity: 10, joinPolicy: null }] };
    const p = await openSetup(c, l); const unitIn = p.$$('.picker-input')[1] as HTMLInputElement; unitIn.dispatchEvent(new p.win.Event('focus'));
    await waitFor(() => p.$$('.picker-status')[1]!.textContent!.includes('حرفين'), 'needs query'); type(p, unitIn, 'bl');
    await waitFor(() => p.$$('.picker-list [role="option"]').some((o) => o.textContent!.includes('Black Eagles')), 'result'); expect(p.$$('.picker-status')[1]!.textContent).toContain('لم يُتحقَّق');
    key(p, unitIn, 'ArrowDown'); key(p, unitIn, 'Enter'); save(p); await waitFor(() => p.$('.toast:not(.bad)'), 'saved'); expect((await getGuildConfig(c.db, G1))!.unitId).toBe('mu_9');
  });
  it('is accessible: label wired to the input, listbox and status live region, no raw ids visible', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u'); const p = await openSetup(c, l);
    const input = p.$('.picker-input') as HTMLInputElement; expect(p.$(`label[for="${input.id}"]`)).not.toBeNull(); expect(input.getAttribute('aria-controls')).toBe(p.$('.picker-list')!.id);
    expect(p.$('.picker-status')!.getAttribute('aria-live')).toBe('polite'); expect(p.$('.picker-list')!.getAttribute('role')).toBe('listbox');
    expect(p.$('.picker-status')!.textContent).toBe('');                                  // nothing searched yet: no misleading "no results"
    expect(p.$('.picker-label, .picker label')!.textContent).toBe('الدولة');                // named, not "ID"
  });
});

describe('server type change and country reservation (setup page)', () => {
  const openSetup = async (c: Ctx, l: Login, g = G1) => { const p = await openApp(c, l, `#/g/${g}/setup`); await waitFor(() => p.$('#type-desc')?.textContent, 'setup form'); return p; };
  const setType = (p: Page, v: string) => { const sel = p.$$('#tab-content .card select')[1] as HTMLSelectElement; sel.value = v; sel.dispatchEvent(new p.win.Event('change', { bubbles: true })); };
  const btn = (p: Page, text: string) => p.$$('button').find((b) => b.textContent === text) as HTMLButtonElement | undefined;

  it('a type change that would orphan mappings shows exactly what will be removed, needs an explicit tick, and Cancel/Escape change nothing', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country', country_id: 'eg' }, 'u');
    for (const [i, k] of (['president', 'citizen', 'party_member'] as const).entries()) await addRoleMapping(c.db, { guildId: G1, kind: k, discordRoleId: `90000${i + 1}`, actor: 'u' });
    const p = await openSetup(c, l); setType(p, 'party'); click(p, p.$('#save-settings')!);
    await waitFor(() => p.$('.dialog.wide'), 'confirmation dialog'); const items = p.$$('.dialog.wide li').map((x) => x.textContent); expect(items).toHaveLength(2);
    expect(items.join(' ')).toContain('رئيس'); expect(items.join(' ')).toContain('مواطن'); expect(items.join(' ')).not.toContain('عضو'); expect(p.$('.dialog.wide')!.textContent).toContain('لن تُحذف أي رتب في ديسكورد');
    const go = [...p.$$('.dialog.wide button')].find((b) => b.className.includes('danger')) as HTMLButtonElement; expect(go.disabled).toBe(true);
    key(p, p.$('#removal-ack')!, 'Escape'); await waitFor(() => !p.$('.dialog.wide'), 'closed');
    expect((await getGuildConfig(c.db, G1))!.communityType).toBe('country'); expect(await listRoleMappings(c.db, G1)).toHaveLength(3);        // nothing happened
    click(p, p.$('#save-settings')!); await waitFor(() => p.$('.dialog.wide'), 'dialog again'); const cancel = [...p.$$('.dialog.wide button')].find((b) => b.textContent === 'إلغاء')!; click(p, cancel);
    await waitFor(() => !p.$('.dialog.wide'), 'cancelled'); expect(await listRoleMappings(c.db, G1)).toHaveLength(3);
  });
  it('after the explicit confirmation the type changes, only the incompatible mappings go, the user is told, and the page shows the new type', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country', country_id: 'eg' }, 'u');
    for (const [i, k] of (['president', 'party_member'] as const).entries()) await addRoleMapping(c.db, { guildId: G1, kind: k, discordRoleId: `90000${i + 1}`, actor: 'u' });
    const p = await openSetup(c, l); setType(p, 'party'); click(p, p.$('#save-settings')!); await waitFor(() => p.$('.dialog.wide'), 'dialog');
    const ack = p.$('#removal-ack') as HTMLInputElement; ack.checked = true; ack.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    const go = [...p.$$('.dialog.wide button')].find((b) => b.className.includes('danger')) as HTMLButtonElement; expect(go.disabled).toBe(false); click(p, go);
    await waitFor(() => !p.$('.dialog.wide') && p.$('.toast'), 'saved'); const cfg = await getGuildConfig(c.db, G1); expect(cfg!.communityType).toBe('party'); expect((await listRoleMappings(c.db, G1)).map((m) => m.kind)).toEqual(['party_member']);
    expect(p.$$('.toast').map((x) => x.textContent).join(' ')).toContain('1');
  });
  it('a type change with nothing to remove saves directly, and modules the new type lacks are reported', async () => {
    const { c, l } = await setup(); const p = await openSetup(c, l); (p.$('#mod-government') as HTMLInputElement).checked = true; setType(p, 'party'); click(p, p.$('#save-settings')!);
    await waitFor(() => p.$('.toast:not(.bad)'), 'saved'); expect(p.$('.dialog')).toBeNull(); expect((await getGuildConfig(c.db, G1))!.communityType).toBe('party');
  });
  it('role mapping form only offers the kinds the server type allows', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'party' }, 'u'); const p = await openApp(c, l, `#/g/${G1}/roles`); await waitFor(() => p.$('#map-kind'), 'form');
    expect([...(p.$('#map-kind') as HTMLSelectElement).options].map((o) => o.value).sort()).toEqual(['party_leader', 'party_member', 'party_role']); expect(p.$$('#map-kind optgroup')).toHaveLength(1);
  });
  it('a country already linked to another server gives a clear, persistent message with the support contact; nothing is saved and the other server is not named', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G2, { community_type: 'country', country_id: 'eg' }, 'u'); await updateGuildSettings(c.db, G1, { community_type: 'country' }, 'u');
    const p = await openSetup(c, l); const input = p.$('.picker-input') as HTMLInputElement; input.dispatchEvent(new p.win.Event('focus')); await waitFor(() => p.$$('.picker-list [role="option"]').length === 4, 'list');
    const egypt = p.$$('.picker-list [role="option"]').find((o) => o.textContent!.includes('Egypt'))!; egypt.dispatchEvent(new p.win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    click(p, p.$('#save-settings')!); await waitFor(() => !(p.$('#country-conflict') as HTMLElement).hidden, 'conflict');
    const msg = p.$('#country-conflict')!.textContent!; expect(msg).toContain('abudujana15'); expect(msg).not.toContain(G2); expect((await getGuildConfig(c.db, G1))!.countryId).toBeNull(); expect(p.$('.toast:not(.bad)')).toBeNull();
  });
  it('the reservation is explained as a claim, not proof of in-game authority; Unlink needs confirmation, then frees the country', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country', country_id: 'eg' }, 'u'); const p = await openSetup(c, l);
    expect(p.$('#type-area')!.textContent).toContain('لا يثبت أنك قائد الدولة'); await waitFor(() => p.$('#release-country'), 'unlink button');
    click(p, p.$('#release-country')!); await waitFor(() => p.$('.dialog'), 'confirm'); click(p, btn(p, 'تأكيد')!);
    await waitFor(() => p.$('.toast:not(.bad)'), 'released'); expect((await getGuildConfig(c.db, G1))!.countryId).toBeNull();
    await updateGuildSettings(c.db, G2, { community_type: 'country', country_id: 'eg' }, 'u'); expect((await getGuildConfig(c.db, G2))!.countryId).toBe('eg');              // free for others
  });
  it('a pre-existing duplicate sees a notice (no identity of the other server) and keeps working', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G2, { community_type: 'country', country_id: 'eg' }, 'u');
    await c.db.query('ALTER TABLE guilds DISABLE TRIGGER guilds_country_reservation'); await c.db.query(`UPDATE guilds SET community_type='country', country_id='eg' WHERE guild_id=$1`, [G1]); await c.db.query('ALTER TABLE guilds ENABLE TRIGGER guilds_country_reservation');
    const p = await openSetup(c, l); await waitFor(() => p.$('#res-duplicate'), 'notice'); expect(p.$('#res-duplicate')!.textContent).toContain('abudujana15'); expect(p.$('#res-duplicate')!.textContent).not.toContain(G2); expect(p.$('#release-country')).toBeNull();
  });
  it('dialogs keep keyboard focus inside while open and give it back afterwards', async () => {
    const { c, l } = await setup(); await updateGuildSettings(c.db, G1, { community_type: 'country', country_id: 'eg' }, 'u'); const p = await openSetup(c, l); await waitFor(() => p.$('#release-country'), 'unlink');
    const opener = p.$('#release-country') as HTMLButtonElement; opener.focus(); click(p, opener); await waitFor(() => p.$('.dialog'), 'dialog');
    const bs = p.$$('.dialog button') as HTMLButtonElement[]; bs[bs.length - 1]!.focus(); p.doc.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); expect(p.doc.activeElement).toBe(bs[0]);
    p.doc.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await waitFor(() => !p.$('.dialog'), 'closed'); expect(p.doc.activeElement).toBe(opener);
  });
});
