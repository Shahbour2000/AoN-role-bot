import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { addAdminRole, listRoleMappings, updateGuildSettings } from '@aon/db';
import { ADMIN, BASE, SEND_ONLY, guildInfo, login, makeApp, role, type Ctx, type Login } from './harness.js';

const PUB = join(__dirname, '..', 'public'); const G1 = '100000001', G2 = '100000002', MEMBER = '77';
const read = (f: string) => readFileSync(join(PUB, f), 'utf8');
type Win = Window & typeof globalThis;
interface Page { win: Win; doc: Document; $: (s: string) => HTMLElement | null; $$: (s: string) => HTMLElement[]; calls: { method: string; url: string; status: number; body?: string }[] }
async function waitFor<T>(fn: () => T | null | undefined | false, label: string, ms = 8000): Promise<T> { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`); await new Promise((r) => setTimeout(r, 25)); } }
async function open(c: Ctx, l: Login, hash: string, lang: 'ar' | 'en' = 'en'): Promise<Page> {
  const dom = new JSDOM(read('app.html'), { url: `${BASE}/app${hash}`, runScripts: 'outside-only', pretendToBeVisual: true }); const win = dom.window as unknown as Win; const calls: Page['calls'] = [];
  win.localStorage.setItem('aon_lang', lang); (win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false });
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
const click = (p: Page, el: Element | null) => { if (!el) throw new Error('missing element'); el.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true })); };
const down = (p: Page, el: Element | null) => { if (!el) throw new Error('missing element'); el.dispatchEvent(new p.win.MouseEvent('mousedown', { bubbles: true, cancelable: true })); };
const key = (p: Page, el: Element, k: string) => el.dispatchEvent(new p.win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const typeIn = (p: Page, el: Element, v: string) => { (el as HTMLInputElement).value = v; el.dispatchEvent(new p.win.Event('input', { bubbles: true })); };
const toast = (p: Page) => p.$('.toast')?.textContent ?? '';
const roleOpt = (scope: ParentNode, id: string) => scope.querySelector(`.rolepick li[data-role-id="${id}"]`) as HTMLElement;
const dis = (o: Element) => o.getAttribute('aria-disabled') === 'true';

async function boot(opts: { type?: 'country' | 'party'; perm?: string } = {}) {
  const c = await makeApp({ guilds: [G1, G2] }); const l = await login(c, '42', [guildInfo(G1, opts.perm ?? ADMIN), guildInfo(G2, SEND_ONLY)]);
  c.bot.roles.set(G1, [role(G1, 0), role('900001', 5, { color: 0x1abc9c, name: 'Sudan citizen' }), role('900002', 6, { color: 0xe74c3c, name: 'Libya citizen' }), role('900003', 60, { name: 'Above bot' }), role('900004', 2, { managed: true, name: 'Bot role' }), role('900005', 7, { name: 'Plain' }), role('900006', 8, { name: 'Party members' }), role('900007', 9, { name: 'Unit members' })]); c.bot.top.set(G1, 50);
  await updateGuildSettings(c.db, G1, opts.type === 'party' ? { community_type: 'party', party_id: 'p1' } : { community_type: 'country', country_id: 'eg', modules: { government: true, party: true, unit: true, alliance: false, ranks: false } }, null);
  c.game.countriesRes = { status: 'ok', data: [{ id: 'eg', name: 'Egypt' }, { id: 'sd', name: 'Sudan' }, { id: 'ly', name: 'Libya' }, { id: 'pl', name: 'Poland' }] };
  return { c, l };
}

describe('role picker (replaces the native role <select>)', () => {
  it('shows each role with its real name and its real Discord colour; no colour = Discord grey; searchable; roles of other servers never appear', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#px-card'), 'page');
    const scope = p.$('#px-card')!; const sudan = roleOpt(scope, '900001');
    expect(sudan.textContent).toContain('Sudan citizen'); expect(sudan.querySelector('.role-dot')!.getAttribute('style')).toContain('background:#1abc9c');
    expect(roleOpt(scope, '900005').querySelector('.role-dot')!.getAttribute('style')).toContain('#99aab5');
    const input = scope.querySelector('.rolepick .rp-search') as HTMLInputElement; typeIn(p, input, 'lib');
    expect([...scope.querySelectorAll('.rolepick li[role="option"]')].map((o) => o.getAttribute('data-role-id'))).toEqual(['900002']);
    typeIn(p, input, 'zzz'); expect(scope.querySelector('.rolepick li.empty')!.textContent).toContain('No matching roles');
    expect(p.doc.body.innerHTML).not.toContain('role-' + G2);
  });
  it('@everyone, integration roles and roles the bot cannot assign are visibly marked; blocked ones cannot be chosen (mouse or keyboard)', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#px-card'), 'page'); const scope = p.$('#px-card')!;
    expect(dis(roleOpt(scope, G1))).toBe(true); expect(dis(roleOpt(scope, '900004'))).toBe(true); expect(dis(roleOpt(scope, '900001'))).toBe(false);
    expect(roleOpt(scope, '900003').querySelector('.badge.warn')).not.toBeNull();                                // above the bot: allowed to pick, but warned
    const pick = scope.querySelector('.proxy-add .rolepick') as unknown as HTMLInputElement; const input = pick.querySelector('.rp-search') as HTMLInputElement;
    down(p, roleOpt(pick as unknown as Element, G1)); expect(pick.value).toBe('');
    typeIn(p, input, 'Bot role'); key(p, input, 'ArrowDown'); key(p, input, 'Enter'); expect(pick.value).toBe('');                  // keyboard cannot select a blocked option either
    typeIn(p, input, 'Plain'); key(p, input, 'ArrowDown'); key(p, input, 'Enter'); expect(pick.value).toBe('900005');
  });
  it('selecting fires change, the chip shows the colour and name, and the clear button empties it', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#px-card'), 'page');
    const pick = p.$('.proxy-add .rolepick') as unknown as HTMLElement & { value: string }; let fired = 0; pick.addEventListener('change', () => fired++);
    down(p, roleOpt(pick, '900001')); expect(pick.value).toBe('900001'); expect(fired).toBe(1);
    expect(pick.querySelector('.picker-selected .role-dot')!.getAttribute('style')).toContain('#1abc9c'); expect(pick.querySelector('.picker-selected')!.textContent).toContain('Sudan citizen');
    click(p, pick.querySelector('.picker-selected button')); expect(pick.value).toBe(''); expect(fired).toBe(2);
  });
});

describe('Country roles page: proxy countries', () => {
  it('add a proxy country through the pickers (real names, no ids), see it listed, change its role, remove it — all persisted', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#px-card'), 'page');
    expect(p.$('#px-none')).not.toBeNull(); const cp = p.$('#px-card .picker[data-type="country"]')!; const input = cp.querySelector('input[role="combobox"]') as HTMLInputElement;
    input.dispatchEvent(new p.win.Event('focus')); const opts = await waitFor(() => { const o = [...cp.querySelectorAll('li.picker-opt')]; return o.length === 4 ? o : null; }, 'countries');
    expect(opts.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Sudan'), expect.stringContaining('Libya')])); expect(cp.textContent).not.toMatch(/\bsd\b/);
    down(p, opts.find((o) => o.textContent!.includes('Sudan'))!); down(p, roleOpt(p.$('.proxy-add')!, '900001')); click(p, p.$('#px-add'));
    await waitFor(() => p.$('.proxy-row[data-country="sd"]'), 'row'); expect(toast(p)).toContain('saved');
    expect(p.$('.proxy-row[data-country="sd"]')!.textContent).toContain('Sudan'); expect((await listRoleMappings(c.db, G1)).filter((m) => m.kind === 'proxy_citizen').map((m) => [m.gameRef, m.discordRoleId])).toEqual([['sd', '900001']]);
    // edit the role
    const row = p.$('.proxy-row[data-country="sd"]')!; const save = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Save')!; expect(save.hidden).toBe(true);
    down(p, roleOpt(row, '900002')); expect(save.hidden).toBe(false); click(p, save);
    await waitFor(async () => (await listRoleMappings(c.db, G1)).find((m) => m.kind === 'proxy_citizen')?.discordRoleId === '900002', 'role changed in the database').catch(() => undefined);
    for (let i = 0; i < 80 && (await listRoleMappings(c.db, G1)).find((m) => m.kind === 'proxy_citizen')?.discordRoleId !== '900002'; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await listRoleMappings(c.db, G1)).find((m) => m.kind === 'proxy_citizen')!.discordRoleId).toBe('900002');
    // remove (confirmation first)
    click(p, p.$('.proxy-row[data-country="sd"] button.danger')); const dlg = await waitFor(() => p.$('.overlay .dialog'), 'dialog'); expect((await listRoleMappings(c.db, G1)).length).toBe(1);
    click(p, dlg.querySelector('button.danger')); await waitFor(() => p.$('#px-none'), 'removed'); expect((await listRoleMappings(c.db, G1)).length).toBe(0);
  });
  it('shows server errors in the page language (the server\'s own country, a role already used) and never adds anything', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#px-card'), 'page');
    const cp = p.$('#px-card .picker[data-type="country"]')!; cp.querySelector('input')!.dispatchEvent(new p.win.Event('focus')); const o = await waitFor(() => [...cp.querySelectorAll('li.picker-opt')].find((x) => x.textContent!.includes('Egypt')), 'egypt');
    down(p, o); down(p, roleOpt(p.$('.proxy-add')!, '900001')); click(p, p.$('#px-add')); await waitFor(() => toast(p).includes('own country'), 'error toast'); expect(p.$('.toast')!.classList.contains('bad')).toBe(true);
    expect((await listRoleMappings(c.db, G1)).length).toBe(0);
    click(p, cp.querySelector('.picker-selected button')); const t0 = p.calls.length; click(p, p.$('#px-add')); await waitFor(() => toast(p).includes('Choose a country and a role'), 'pick both'); expect(p.calls.length).toBe(t0);          // nothing is sent without both
  });
  it('a server that is not a country server (or has no country) shows an explanation instead of the section', async () => {
    const { c, l } = await boot({ type: 'party' }); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#px-unavailable'), 'notice');
    expect(p.$('#px-card')).toBeNull(); expect(p.$('#px-unavailable')!.textContent).toContain('country servers');
  });
});

describe('Country roles page: country-wide party and unit roles', () => {
  const KINDS = ['country_party_member', 'country_party_president', 'country_unit_member', 'country_unit_leader', 'country_unit_owner'];
  it('lists the five kinds with descriptions, saves only what changed, and a role taken by one kind is disabled in the others', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#id-card'), 'page');
    expect(KINDS.every((k) => p.$(`#id-${k}`))).toBe(true); expect(p.$('#id-card')!.textContent).toContain('Nationality does not matter');
    const pick = (k: string) => p.$(`#id-${k}`) as unknown as HTMLElement & { value: string };
    down(p, roleOpt(pick('country_party_member'), '900006')); down(p, roleOpt(pick('country_unit_member'), '900007')); down(p, roleOpt(pick('country_unit_owner'), '900001'));
    click(p, p.$('#id-save')); await waitFor(() => toast(p).includes('Country roles saved'), 'saved');
    expect(p.calls.filter((x) => x.method === 'PUT' && x.url.endsWith('/identity-roles')).length).toBe(3);
    expect(Object.fromEntries((await listRoleMappings(c.db, G1)).map((m) => [m.kind, m.discordRoleId]))).toEqual({ country_party_member: '900006', country_unit_member: '900007', country_unit_owner: '900001' });
    await waitFor(() => { try { return dis(roleOpt(pick('country_party_president'), '900006')); } catch { return false; } }, 'used elsewhere (page re-rendered after the save)');                // after the reload, the role is shown as used
    click(p, p.$('#id-save')); await new Promise((r) => setTimeout(r, 200)); expect(p.calls.filter((x) => x.method === 'PUT' && x.url.endsWith('/identity-roles')).length).toBe(3);   // nothing changed -> no requests
  });
  it('clearing a role removes the mapping; a hint appears when the Parties / Military units module is switched off', async () => {
    const { c, l } = await boot(); await updateGuildSettings(c.db, G1, { modules: { government: true, party: false, unit: true, alliance: false, ranks: false } }, null);
    const { setIdentityRole } = await import('@aon/db'); await setIdentityRole(c.db, { guildId: G1, kind: 'country_party_member', discordRoleId: '900006', actor: null });
    const p = await open(c, l, `#/g/${G1}/proxy`); await waitFor(() => p.$('#id-card'), 'page'); expect(p.$('#id-card .callout')!.textContent).toContain('switched off');
    const pick = p.$('#id-country_party_member') as unknown as HTMLElement; click(p, pick.querySelector('.picker-selected button')); click(p, p.$('#id-save'));
    await waitFor(() => toast(p).includes('saved'), 'saved'); expect((await listRoleMappings(c.db, G1)).length).toBe(0);
  });
});

describe('Bot administrators page', () => {
  it('an administrator adds and removes trusted roles (real names and colours); the list persists', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/admins`); await waitFor(() => p.$('#ad-info'), 'page');
    expect(p.$('#ad-none')).not.toBeNull(); expect(p.$('#ad-info')!.textContent).toContain('Administrator'); expect(p.$('#ad-info')!.textContent).toContain('cannot change these trusted roles');
    const pick = p.$('#ad-addcard .rolepick') as unknown as HTMLElement; down(p, roleOpt(pick, G1)); down(p, roleOpt(pick, '900001')); click(p, p.$('#ad-add'));
    await waitFor(() => p.$('.proxy-row[data-role-id="900001"]'), 'row'); const row = p.$('.proxy-row[data-role-id="900001"]')!;
    expect(row.textContent).toContain('Sudan citizen'); expect(row.querySelector('.role-dot')!.getAttribute('style')).toContain('#1abc9c');
    click(p, row.querySelector('button.danger')); const dlg = await waitFor(() => p.$('.overlay .dialog'), 'dialog'); click(p, dlg.querySelector('button.danger')); await waitFor(() => p.$('#ad-none'), 'removed');
  });
  it('@everyone cannot even be selected; the server also refuses it if forced', async () => {
    const { c, l } = await boot(); const p = await open(c, l, `#/g/${G1}/admins`); await waitFor(() => p.$('#ad-info'), 'page'); expect(dis(roleOpt(p.$('#ad-addcard')!, G1))).toBe(true);
    const r = await c.app.inject({ method: 'POST', url: `/api/guilds/${G1}/admin-roles`, cookies: l.cookies, headers: { origin: BASE, 'x-csrf-token': l.csrf }, payload: { roleId: G1 } }); expect(r.statusCode).toBe(422);
  });
  it('a trusted bot administrator sees the page read-only (no add form, no remove buttons) and the server marked as trusted in the list', async () => {
    const c = await makeApp({ guilds: [G1, G2] }); const l = await login(c, MEMBER, [guildInfo(G1, SEND_ONLY)]);
    c.bot.roles.set(G1, [role(G1, 0), role('900001', 5, { name: 'Staff' })]); c.bot.top.set(G1, 50); c.bot.members.set(`${G1}:${MEMBER}`, ['900001']); await addAdminRole(c.db, { guildId: G1, roleId: '900001', actor: 'owner' });
    const p = await open(c, l, `#/g/${G1}/admins`); await waitFor(() => p.$('#ad-viewonly'), 'view only');
    expect(p.$('#ad-add')).toBeNull(); expect(p.$('#ad-list button.danger')).toBeNull(); expect(p.$('#ad-info')!.textContent).toContain('Trusted bot administrator');
    const g = await open(c, l, '#/'); await waitFor(() => g.$('.card .badge'), 'guild list'); expect(g.doc.body.textContent).toContain('Trusted bot administrator');
  });
});

describe('no untranslated keys and correct direction on the new pages (Arabic and English)', () => {
  it.each(['en', 'ar'] as const)('%s', async (lang) => {
    const { c, l } = await boot(); await addAdminRole(c.db, { guildId: G1, roleId: '900001', actor: null });
    for (const tab of ['proxy', 'admins']) {
      const p = await open(c, l, `#/g/${G1}/${tab}`, lang); await waitFor(() => p.$(tab === 'proxy' ? '#px-card' : '#ad-info'), tab);
      expect(p.doc.documentElement.getAttribute('dir')).toBe(lang === 'ar' ? 'rtl' : 'ltr'); expect(p.doc.body.textContent).not.toMatch(/\b(tab_|pd_|px_|id_|ad_|rp_|e_)[a-z_]+\b/);
      expect(p.doc.body.textContent).not.toMatch(/\bnull\b|undefined/);
    }
  });
});

describe('entity picker: stale responses never overwrite newer results (controllable fake API)', () => {
  const boot2 = () => {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: `${BASE}/` }); const win = dom.window as unknown as Win;
    win.localStorage.setItem('aon_lang', 'en'); for (const f of ['i18n.js', 'common.js', 'picker.js']) win.eval(read(f));
    return win;
  };
  const gate = <T>() => { let res!: (v: T) => void; const p = new Promise<T>((r) => { res = r; }); return { p, res }; };
  const names = (win: Win) => [...win.document.querySelectorAll('li.picker-opt .picker-name')].map((o) => o.textContent!.trim());
  const reply = (items: string[]) => ({ ok: true, status: 200, data: { items: items.map((n) => ({ id: n.toLowerCase(), name: n })), total: items.length, needsQuery: false, verified: true } });
  type Api = (m: string, url: string) => Promise<{ ok: boolean; status: number; data: unknown }>;
  const mount = (win: Win, api: Api, extra: Record<string, unknown> = {}) => {
    const w = win as unknown as { AON: { entityPicker: (o: unknown) => { el: HTMLElement; refresh(): void; value(): string | null } } };
    const pk = w.AON.entityPicker({ type: 'country', api, guildId: G1, label: 'Country', ...extra }); win.document.getElementById('host')!.append(pk.el); return pk;
  };
  const input = (win: Win) => win.document.querySelector('input[role="combobox"]') as HTMLInputElement;
  const type = (win: Win, v: string) => { input(win).value = v; input(win).dispatchEvent(new win.Event('input', { bubbles: true })); };

  it('rapid typing: an OLDER slow answer arriving after a NEWER one is ignored', async () => {
    const win = boot2(); const slow = gate<ReturnType<typeof reply>>(); const fast = gate<ReturnType<typeof reply>>();
    const api: Api = (_m, url) => (url.includes('q=su') ? fast.p : url.includes('q=s&') ? slow.p : Promise.resolve(reply([]))) as never;
    mount(win, api); input(win).dispatchEvent(new win.Event('focus')); await new Promise((r) => setTimeout(r, 20));
    type(win, 's'); await new Promise((r) => setTimeout(r, 300)); type(win, 'su'); await new Promise((r) => setTimeout(r, 300));       // both requests are now in flight
    fast.res(reply(['Sudan'])); await waitFor(() => names(win).length === 1, 'newer results'); expect(names(win)).toEqual(['Sudan']);
    slow.res(reply(['Spain', 'Sweden', 'Syria'])); await new Promise((r) => setTimeout(r, 50)); expect(names(win)).toEqual(['Sudan']);               // the stale answer is dropped
  });
  it('switching the country filter invalidates in-flight requests (the old country\'s parties never appear under the new country)', async () => {
    const win = boot2(); let country = 'eg'; const egypt = gate<ReturnType<typeof reply>>(); const sudan = gate<ReturnType<typeof reply>>();
    const api: Api = (_m, url) => (url.includes('countryId=eg') ? egypt.p : sudan.p) as never;
    const pk = mount(win, api, { type: 'party', getCountryId: () => country }); input(win).dispatchEvent(new win.Event('focus')); await new Promise((r) => setTimeout(r, 20));    // request for eg in flight
    country = 'sd'; pk.refresh(); input(win).dispatchEvent(new win.Event('focus')); input(win).dispatchEvent(new win.Event('click')); await new Promise((r) => setTimeout(r, 20));  // request for sd in flight
    sudan.res(reply(['Sudanese Unity'])); await waitFor(() => names(win).length === 1, 'sd results'); expect(names(win)).toEqual(['Sudanese Unity']);
    egypt.res(reply(['Egyptian Party', 'Another Egyptian Party'])); await new Promise((r) => setTimeout(r, 50)); expect(names(win)).toEqual(['Sudanese Unity']);
  });
  it('refresh() while a request is in flight (list closed) also discards it and clears the loading state', async () => {
    const win = boot2(); const g1 = gate<ReturnType<typeof reply>>(); const pk = mount(win, () => g1.p as never, { type: 'party', getCountryId: () => 'eg' });
    input(win).dispatchEvent(new win.Event('focus')); await new Promise((r) => setTimeout(r, 20)); input(win).dispatchEvent(new win.Event('blur'));                              // loading, list closed
    expect(win.document.querySelector('.picker')!.getAttribute('aria-busy')).toBe('true'); pk.refresh(); expect(win.document.querySelector('.picker')!.hasAttribute('aria-busy')).toBe(false);
    g1.res(reply(['Late Party'])); await new Promise((r) => setTimeout(r, 50)); input(win).dispatchEvent(new win.Event('focus')); expect(names(win)).not.toContain('Late Party');
  });
  it('loading, empty and error states are shown and recover; the error is retryable', async () => {
    const win = boot2(); let mode: 'empty' | 'error' | 'ok' = 'empty'; const g = gate<ReturnType<typeof reply>>();
    const api: Api = () => (mode === 'empty' ? g.p : mode === 'error' ? Promise.resolve({ ok: false, status: 502, data: { error: 'game_unavailable' } }) : Promise.resolve(reply(['Egypt']))) as never;
    mount(win, api); input(win).dispatchEvent(new win.Event('focus')); await new Promise((r) => setTimeout(r, 20));
    expect(win.document.querySelector('.picker-status')!.textContent).toMatch(/Loading/i); g.res(reply([])); await waitFor(() => /No results/i.test(win.document.querySelector('.picker-status')!.textContent ?? ''), 'empty state');
    mode = 'error'; type(win, 'x'); await waitFor(() => [...win.document.querySelectorAll('.picker button')].some((b) => !(b as HTMLElement).hidden && /retry/i.test(b.textContent ?? '')), 'retry button (error state)');
    mode = 'ok'; type(win, ''); await new Promise((r) => setTimeout(r, 300)); await waitFor(() => names(win).includes('Egypt'), 'recovered');
  });
  it('rapid keystrokes are debounced: only the final query reaches the server', async () => {
    const win = boot2(); const urls: string[] = []; const api: Api = (_m, url) => { urls.push(url); return Promise.resolve(reply(['Egypt'])) as never; };
    mount(win, api); input(win).dispatchEvent(new win.Event('focus')); await new Promise((r) => setTimeout(r, 20)); urls.length = 0;
    for (const v of ['e', 'eg', 'egy', 'egyp', 'egypt']) type(win, v); await new Promise((r) => setTimeout(r, 400));
    expect(urls.length).toBe(1); expect(urls[0]).toContain('q=egypt');
  });
  it('an entity with an https image shows it; everything else (no image, a broken image) falls back to initials', async () => {
    const win = boot2(); const api: Api = () => Promise.resolve({ ok: true, status: 200, data: { items: [{ id: 'u1', name: 'Alpha Unit', imageUrl: 'https://media.example.com/a.webp' }, { id: 'u2', name: 'Beta Unit' }, { id: 'u3', name: 'Evil', imageUrl: 'javascript:alert(1)' }], total: 3, needsQuery: false, verified: true } }) as never;
    mount(win, api, { type: 'unit' }); input(win).dispatchEvent(new win.Event('focus')); await waitFor(() => names(win).length === 3, 'items');
    const av = [...win.document.querySelectorAll('li.picker-opt .avatar')]; expect(av[0]!.querySelector('img')!.getAttribute('src')).toBe('https://media.example.com/a.webp'); expect(av[0]!.textContent).toBe('AU');
    expect(av[1]!.querySelector('img')).toBeNull(); expect(av[1]!.textContent).toBe('BU'); expect(av[2]!.querySelector('img')).toBeNull();
    av[0]!.querySelector('img')!.dispatchEvent(new win.Event('error')); expect(av[0]!.querySelector('img')).toBeNull(); expect(av[0]!.textContent).toBe('AU');
  });
});
