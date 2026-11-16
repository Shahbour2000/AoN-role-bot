import { describe, expect, it } from 'vitest';
import { AonClient, extractCountryOptions, extractEntityName, extractParties, extractUnits, partyOptions, unitOptions } from '../src/index.js';
import { parties, units } from './fixtures.js';

const ok = (data: unknown) => ({ status: 'ok' as const, data });
function client(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  return { c: new AonClient({ baseUrl: 'https://x.test/api/v1', fetchImpl }), calls };
}

describe('entity options', () => {
  it('parties and units (VERIFIED real-sample shapes) become id+name options; unnamed ones are skipped; no image field is invented', () => {
    const p = extractParties(ok(parties)); const u = extractUnits(ok(units));
    expect(p.status === 'ok' && partyOptions(p.data)).toEqual([{ id: 'pty_66rrvzjjnzub3gr7', name: 'Ummah Caliphate Party' }, { id: 'pty_ngnxi04pbn7v8jkr', name: 'The National Party Of EGYPT NPE' }]);
    expect(u.status === 'ok' && unitOptions(u.data).map((x) => x.name)).toEqual(['ALQAHERA', 'Black Flags']);
    expect(unitOptions([{ id: 'x', name: null, countryId: null, ownerId: null, ownerName: null, members: null, capacity: null, joinPolicy: null, logoUrl: null }])).toEqual([]);
    for (const o of [...partyOptions(p.status === 'ok' ? p.data : []), ...unitOptions(u.status === 'ok' ? u.data : [])]) expect(Object.keys(o).sort()).toEqual(['id', 'name']);
  });
  it('country options (UNVERIFIED shape, synthetic fixture) are sorted A–Z; unknown shapes are incomplete, never guessed', () => {
    const r = extractCountryOptions(ok({ countries: [{ id: 'pl', name: 'Poland' }, { id: 'eg', name: 'Egypt' }] })); expect(r.status === 'ok' && r.data.map((c) => c.id)).toEqual(['eg', 'pl']);
    expect(extractCountryOptions(ok({ items: [] })).status).toBe('incomplete'); expect(extractCountryOptions({ status: 'error', message: 'x' }).status).toBe('error');
  });
  it('single-entity name reads only a top-level string name', () => {
    expect(extractEntityName(ok({ name: ' Ummah ' }))).toEqual({ status: 'ok', data: 'Ummah' });
    for (const bad of [{}, { name: 5 }, { party: { name: 'x' } }, null, 'x']) expect(extractEntityName(ok(bad)).status).toBe('incomplete');
  });
});

describe('AonClient entity methods', () => {
  it('searchUnits uses the documented /units endpoint with search/countryId, trims and caps the term, and validates the country id', async () => {
    const h = client(units); const r = await h.c.searchUnits('  Black  ', 'eg');
    expect(r.status).toBe('ok'); expect(h.calls).toHaveLength(1); const u = new URL(h.calls[0]!); expect(u.pathname).toBe('/api/v1/units'); expect(u.searchParams.get('search')).toBe('Black'); expect(u.searchParams.get('countryId')).toBe('eg');
    await h.c.searchUnits('x'.repeat(100)); expect(new URL(h.calls[1]!).searchParams.get('search')!.length).toBe(40);
    expect((await h.c.searchUnits('a', '../etc')).status).toBe('error'); expect(h.calls).toHaveLength(2);        // rejected before any request
  });
  it('searchUnits on an unrecognised response is incomplete, not a guess; API failures are passed through', async () => {
    expect((await client({ weird: true }).c.searchUnits('a')).status).toBe('incomplete');
    expect((await client({}, 429).c.searchUnits('a')).status).not.toBe('ok');
  });
  it('entityName calls the single-entity endpoint and validates ids', async () => {
    const h = client({ name: 'Ummah' }); expect(await h.c.entityName('party', 'pty_1')).toEqual({ status: 'ok', data: 'Ummah' }); expect(new URL(h.calls[0]!).pathname).toBe('/api/v1/parties/pty_1');
    await h.c.entityName('unit', 'mu_1'); expect(new URL(h.calls[1]!).pathname).toBe('/api/v1/units/mu_1');
    expect((await h.c.entityName('unit', '../x')).status).toBe('error'); expect(h.calls).toHaveLength(2);
  });
  it('countryOptions reads GET /countries through the tolerant extractor', async () => {
    const h = client([{ id: 'eg', name: 'Egypt' }]); const r = await h.c.countryOptions(); expect(r.status === 'ok' && r.data).toEqual([{ id: 'eg', name: 'Egypt' }]); expect(new URL(h.calls[0]!).pathname).toBe('/api/v1/countries');
  });
});

describe('entity images (units): only an absolute https logo is ever used', () => {
  it('maps logoUrl to imageUrl for https URLs and ignores everything else (relative paths, http, credentials, non-strings)', () => {
    const mk = (logoUrl: unknown) => extractUnits({ status: 'ok', data: [{ id: 'u1', name: 'U', countryId: 'eg', ownerId: 'o', logoUrl }] });
    const img = (v: unknown) => { const r = mk(v); return r.status === 'ok' ? unitOptions(r.data)[0]!.imageUrl : 'ERR'; };
    expect(img('https://cdn.example.com/a.webp')).toBe('https://cdn.example.com/a.webp');
    for (const bad of [null, undefined, '', '/media/a.webp', 'http://cdn.example.com/a.webp', 'https://u:p@cdn.example.com/a.webp', 'javascript:alert(1)', 5, {}]) expect(img(bad), String(bad)).toBeUndefined();
  });
  it('parties and countries never carry an image (no verified field)', () => {
    expect(partyOptions([{ id: 'p', name: 'P', leaderId: null, leaderName: null, members: null, ruling: null }])[0]).toEqual({ id: 'p', name: 'P' });
  });
});
