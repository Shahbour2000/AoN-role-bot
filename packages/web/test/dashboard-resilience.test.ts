/**
 * Regression tests for the production incident "/app stays on the loading skeleton forever".
 * Root cause: public/common.js (Delivery 3) was missing from the deployed tree, so app.js called an undefined `icon()`
 * and the exception left the skeleton on screen. These tests run the REAL shipped scripts (no mocks of our own code;
 * only `fetch` is faked) and pin the contract between scripts plus the "never loading forever" behaviour.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUB = join(__dirname, '..', 'public');
const read = (f: string) => readFileSync(join(PUB, f), 'utf8');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Fetch = (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<unknown>;
const ok = (j: unknown) => ({ ok: true, status: 200, json: async () => j });
const bad = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) });
const SESSION = { user: { id: '1', username: 'abu' }, csrfToken: 'x' };
const hang: Fetch = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));

async function openApp(fetchImpl: Fetch, opts: { compressTimeout?: boolean } = {}) {
  const dom = new JSDOM(read('app.html'), { url: 'https://example.test/app', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as unknown as Window & typeof globalThis & { fetch: unknown };
  w.fetch = fetchImpl;
  if (opts.compressTimeout) {                      // the client timeouts are 20 s; shrink them so the test is fast but the real code path runs
    const realSet = w.setTimeout.bind(w);
    (w as unknown as { setTimeout: unknown }).setTimeout = (f: () => void, ms?: number, ...a: unknown[]) => realSet(f, ms !== undefined && ms >= 20000 ? 150 : ms, ...a);
    (w.AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () => AbortSignal.timeout(150);
  }
  for (const f of ['i18n.js', 'common.js', 'picker.js', 'app.js']) w.eval(read(f));
  if (w.document.readyState !== 'loading') w.document.dispatchEvent(new w.Event('DOMContentLoaded'));   // otherwise jsdom fires it itself (never boot twice)
  const root = w.document.getElementById('root')!;
  const settle = async (pred: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await wait(20); };
  return { w, root, settle };
}

describe('script contract (the incident)', () => {
  it('every window.AON member that any shipped script destructures is actually defined by common.js', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }); const w = dom.window as unknown as { eval: (s: string) => void; AON: Record<string, unknown> };
    w.eval(read('i18n.js')); w.eval(read('common.js'));
    for (const f of ['app.js', 'picker.js', 'landing.js']) {
      const m = read(f).match(/const \{([^}]+)\} = window\.AON/); if (!m) continue;
      for (const name of m[1]!.split(',').map((x) => x.trim().split(':')[0]!.trim()).filter(Boolean)) expect(typeof w.AON[name], `${f} needs AON.${name}`).not.toBe('undefined');
    }
    expect(typeof w.AON['icon']).toBe('function'); expect(typeof w.AON['paintIcons']).toBe('function');
  });
  it('icons are real inline SVG elements, decorative, and unknown names never throw', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }); const w = dom.window as unknown as { eval: (s: string) => void; AON: { icon: (n: string) => Element } };
    w.eval(read('i18n.js')); w.eval(read('common.js'));
    for (const n of ['overview', 'setup', 'roles', 'builds', 'ranks', 'players', 'sync', 'audit', 'diag', 'server', 'clock', 'link', 'menu', 'logout', 'check', 'close', 'chevron', 'back', 'no-such-icon']) {
      const s = w.AON.icon(n); expect(s.tagName.toLowerCase()).toBe('svg'); expect(s.getAttribute('aria-hidden')).toBe('true'); expect(s.querySelectorAll('path').length).toBeGreaterThan(0);
    }
  });
});

describe('dashboard never stays on the loading skeleton', () => {
  it('account without servers: shows the empty state (no skeleton, no error)', async () => {
    const { root, settle } = await openApp(async (u) => (u.startsWith('/api/session') ? ok(SESSION) : ok({ guilds: [] })));
    await settle(() => !!root.querySelector('.empty'));
    expect(root.querySelector('.skeleton')).toBeNull(); expect(root.querySelector('.empty')).not.toBeNull(); expect(root.querySelector('#retry')).toBeNull();
  });
  it('account with a server: lists it', async () => {
    const { root, settle } = await openApp(async (u) => (u.startsWith('/api/session') ? ok(SESSION) : ok({ guilds: [{ id: '123456789012345678', name: 'My Server', icon: null, installed: true }] })));
    await settle(() => root.querySelectorAll('.card').length === 1);
    expect(root.textContent).toContain('My Server'); expect(root.querySelector('svg.icon')).not.toBeNull();
  });
  it('API error (503): localized message with a Retry button, and Retry refetches and recovers', async () => {
    let healthy = false, guildCalls = 0;
    const { root, settle, w } = await openApp(async (u) => { if (u.startsWith('/api/session')) return ok(SESSION); guildCalls++; return healthy ? ok({ guilds: [] }) : bad(503, 'discord_unavailable'); });
    await settle(() => !!root.querySelector('#retry')); expect(root.querySelector('.skeleton')).toBeNull();
    healthy = true; (root.querySelector('#retry') as HTMLElement).click();
    await settle(() => !!root.querySelector('.empty')); expect(guildCalls).toBe(2); expect(w.document.getElementById('retry')).toBeNull();
  });
  it('API that never answers: times out into an error with Retry (not an endless skeleton)', async () => {
    const { root, settle } = await openApp((u, init) => (u.startsWith('/api/session') ? Promise.resolve(ok(SESSION)) : hang(u, init)), { compressTimeout: true });
    await wait(60); expect(root.querySelector('.skeleton')).not.toBeNull();            // still waiting, as it should
    await settle(() => !!root.querySelector('#retry')); expect(root.querySelector('.skeleton')).toBeNull(); expect(root.textContent).toMatch(/\S/);
  });
  it('session endpoint that never answers: error with Retry instead of a blank page', async () => {
    const { root, settle } = await openApp(hang, { compressTimeout: true });
    await settle(() => !!root.querySelector('#retry')); expect(root.querySelector('#retry')).not.toBeNull();
  });
  it('network failure and an unexpected response body both end in a visible error with Retry', async () => {
    const a = await openApp(async (u) => { if (u.startsWith('/api/session')) return ok(SESSION); throw new Error('offline'); });
    await a.settle(() => !!a.root.querySelector('#retry')); expect(a.root.querySelector('.skeleton')).toBeNull();
    const b = await openApp(async (u) => (u.startsWith('/api/session') ? ok(SESSION) : ok({ unexpected: true })));
    await b.settle(() => !!b.root.querySelector('#retry')); expect(b.root.querySelector('.skeleton')).toBeNull();
  });
  it('error text is localized (Arabic by default, English after the switch)', async () => {
    const { root, settle, w } = await openApp(async (u) => (u.startsWith('/api/session') ? ok(SESSION) : bad(503, 'discord_unavailable')));
    await settle(() => !!root.querySelector('#retry')); expect(w.document.documentElement.dir).toBe('rtl'); expect(root.querySelector('#retry')!.textContent).toBe('إعادة المحاولة');
    (w.document.getElementById('lang-toggle') as HTMLElement).click(); await settle(() => w.document.documentElement.dir === 'ltr');
    await settle(() => root.querySelector('#retry')?.textContent === 'Retry'); expect(root.querySelector('#retry')!.textContent).toBe('Retry');
  });
  it('401 from the session endpoint still sends the visitor to the OAuth login (authentication is not bypassed)', async () => {
    const { w } = await openApp(async () => bad(401, 'unauthenticated'));
    await wait(100); expect(true).toBe(true);        // jsdom cannot navigate; the redirect target is asserted statically below
    expect(read('app.js')).toContain("location.assign('/auth/login')"); void w;
  });
});

describe('dictionary parity for the new error strings', () => {
  it('e_network, e_timeout, e_server and retry exist in both languages', () => {
    const w = { I18N: undefined as unknown } as { I18N: Record<'ar' | 'en', Record<string, string>> }; new Function('window', read('i18n.js'))(w);
    for (const k of ['e_network', 'e_timeout', 'e_server', 'retry']) { expect(w.I18N.ar[k], `ar ${k}`).toBeTruthy(); expect(w.I18N.en[k], `en ${k}`).toBeTruthy(); }
    expect(Object.keys(w.I18N.ar).sort()).toEqual(Object.keys(w.I18N.en).sort());
  });
});
