import { describe, expect, it } from 'vitest';
import { AonHttp, parseRetryAfter } from '../src/index.js';

type Step = { status: number; body?: unknown; headers?: Record<string, string>; throws?: boolean; rawBody?: string };
function harness(steps: Step[], opts: Partial<ConstructorParameters<typeof AonHttp>[0]> = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s.throws) throw new Error('ECONNRESET');
    return new Response(s.rawBody ?? JSON.stringify(s.body ?? {}), { status: s.status, headers: s.headers ?? {} });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const http = new AonHttp({ baseUrl: 'https://x.test/api/v1', fetchImpl, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, ...opts });
  return { http, calls, sleeps, advance: (ms: number) => { t += ms; } };
}

describe('AonHttp', () => {
  it('returns ok and caches within TTL', async () => {
    const h = harness([{ status: 200, body: { a: 1 } }]);
    expect(await h.http.get('/game')).toEqual({ status: 'ok', data: { a: 1 } });
    await h.http.get('/game');
    expect(h.calls).toHaveLength(1);
    expect(h.http.stats.cacheHits).toBe(1);
    h.advance(31_000);
    await h.http.get('/game');
    expect(h.calls).toHaveLength(2);
  });
  it('de-duplicates concurrent identical requests', async () => {
    const h = harness([{ status: 200, body: {} }]);
    await Promise.all([h.http.get('/countries'), h.http.get('/countries'), h.http.get('/countries')]);
    expect(h.calls).toHaveLength(1);
    expect(h.http.stats.dedupHits).toBe(2);
  });
  it('maps 404 to not_found (not an error)', async () => {
    expect(await harness([{ status: 404 }]).http.get('/players/nope')).toEqual({ status: 'not_found' });
  });
  it('honours Retry-After on 429 and retries within the inline limit', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '3' } }, { status: 200, body: { ok: true } }]);
    expect(await h.http.get('/x')).toEqual({ status: 'ok', data: { ok: true } });
    expect(h.sleeps).toContain(3000);
  });
  it('returns rate_limited (no retry storm) when Retry-After is long', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '120' } }]);
    const r = await h.http.get('/x');
    expect(r).toEqual({ status: 'rate_limited', retryAfterMs: 120_000 });
    expect(h.calls).toHaveLength(1);
    // subsequent calls are short-circuited while blocked
    expect((await h.http.get('/y')).status).toBe('rate_limited');
    expect(h.calls).toHaveLength(1);
  });
  it('retries 5xx with backoff then reports error', async () => {
    const h = harness([{ status: 503 }], { maxRetries: 2 });
    expect(await h.http.get('/x')).toEqual({ status: 'error', message: 'HTTP 503' });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1500]);
  });
  it('recovers when a retry succeeds', async () => {
    const h = harness([{ status: 500 }, { status: 200, body: { v: 1 } }]);
    expect(await h.http.get('/x')).toEqual({ status: 'ok', data: { v: 1 } });
  });
  it('network failure and malformed JSON are errors, not empty results', async () => {
    expect((await harness([{ status: 200, throws: true }], { maxRetries: 0 }).http.get('/x')).status).toBe('error');
    expect(await harness([{ status: 200, rawBody: '<html>' }]).http.get('/x')).toEqual({ status: 'error', message: 'malformed JSON in response' });
  });
  it('does not retry or cache unexpected 4xx', async () => {
    const h = harness([{ status: 400 }]);
    expect((await h.http.get('/x')).status).toBe('error');
    expect(h.calls).toHaveLength(1);
  });
  it('never exceeds the per-minute window', async () => {
    const h = harness([{ status: 200, body: {} }], { maxPerMinute: 3 });
    for (let n = 0; n < 7; n++) await h.http.get(`/p/${n}`);
    expect(h.calls).toHaveLength(7);
    expect(h.sleeps.length).toBeGreaterThan(0); // had to wait for the window to roll
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });
  it('builds stable cache keys regardless of query order', async () => {
    const h = harness([{ status: 200, body: {} }]);
    await h.http.get('/c', { limit: 5, offset: 0 });
    await h.http.get('/c', { offset: 0, limit: 5 });
    expect(h.calls).toHaveLength(1);
  });
  it('parseRetryAfter handles seconds, dates and junk', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000);
    expect(parseRetryAfter(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
