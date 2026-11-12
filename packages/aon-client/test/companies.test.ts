import { describe, expect, it } from 'vitest';
import type { Fetched } from '@aon/core';
import { AonClient, extractCompaniesPage } from '../src/index.js';

const ok = (data: unknown): Fetched<unknown> => ({ status: 'ok', data });
describe('extractCompaniesPage (shape UNVERIFIED: fails closed)', () => {
  it('reads names from `companies` or a bare array, skips foreign owners', () => {
    const r = extractCompaniesPage(ok({ companies: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B', ownerId: 'usr_x' }, { id: 'c3', name: 'C', ownerId: 'p1' }], total: 3 }), 'p1');
    expect(r).toEqual({ status: 'ok', data: { companies: [{ id: 'c1', name: 'A' }, { id: 'c3', name: 'C' }], count: 3, total: 3, hasMore: null, ignoredForeignOwner: 1 } });
    expect(extractCompaniesPage(ok([{ name: 'Z' }]), 'p1')).toMatchObject({ status: 'ok', data: { companies: [{ id: null, name: 'Z' }] } });
  });
  it('is incomplete (never ok) when no list or no string name', () => {
    expect(extractCompaniesPage(ok({ nothing: 1 }), 'p1').status).toBe('incomplete');
    expect(extractCompaniesPage(ok({ companies: [{ id: 'c1' }] }), 'p1').status).toBe('incomplete');
    expect(extractCompaniesPage(ok({ companies: [{ id: 'c1', name: 5 }] }), 'p1').status).toBe('incomplete');
    expect(extractCompaniesPage({ status: 'not_found' }, 'p1')).toEqual({ status: 'not_found' });
  });
});

function clientWith(pages: unknown[] | ((url: string) => Response)) {
  const urls: string[] = [];
  const fetchImpl = (async (u: string) => {
    urls.push(u);
    if (typeof pages === 'function') return pages(u);
    const i = urls.length - 1; return new Response(JSON.stringify(pages[Math.min(i, pages.length - 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { c: new AonClient({ baseUrl: 'https://x.test/api/v1', fetchImpl, cacheTtlMs: 0, minIntervalMs: 0 } as never), urls };
}
const co = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, name: `Co ${from + i}` }));
describe('AonClient.playerCompanies', () => {
  it('requests limit=50&offset=0 first and follows full pages by offset', async () => {
    const { c, urls } = clientWith([{ companies: co(50) }, { companies: co(50, 50) }, { companies: co(3, 100) }]);
    const r = await c.playerCompanies('usr_1');
    expect(r.status === 'ok' && r.data.companies.length).toBe(103);
    expect(urls[0]).toContain('/players/usr_1/companies?limit=50&offset=0'); expect(urls[1]).toContain('offset=50'); expect(urls[2]).toContain('offset=100');
  });
  it('uses total/hasMore hints and stops on a short page', async () => {
    const { c, urls } = clientWith([{ companies: co(2), total: 2 }]);
    expect((await c.playerCompanies('usr_1')).status).toBe('ok'); expect(urls.length).toBe(1);
  });
  it('is incomplete when pages never end, or an empty page follows an announced one', async () => {
    const { c } = clientWith((u) => new Response(JSON.stringify({ companies: co(50, Number(new URL(u).searchParams.get('offset'))) }), { status: 200 }));
    expect((await c.playerCompanies('usr_1', { maxPages: 3 })).status).toBe('incomplete');
    const b = clientWith([{ companies: [], hasMore: true }]);
    expect((await b.c.playerCompanies('usr_1')).status).toBe('incomplete');
  });
  it('rejects a malformed id without a request, reports API failure as not ok', async () => {
    const { c, urls } = clientWith([{}]);
    expect((await c.playerCompanies('../x')).status).toBe('error'); expect(urls.length).toBe(0);
    const f = clientWith(() => new Response('{}', { status: 500 }));
    expect((await f.c.playerCompanies('usr_1')).status).not.toBe('ok');
  });
});
