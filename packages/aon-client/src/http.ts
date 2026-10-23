/**
 * Resilient HTTP layer for the Age of Nations public API.
 * - shared sliding-window rate limiter (API limit: 60/min per IP; we default to 45 for headroom)
 * - TTL cache (API caches 30 s server-side, so a shorter client TTL is pointless)
 * - in-flight request de-duplication
 * - Retry-After aware 429 handling with bounded retries; backoff for 5xx / network errors
 * - every outcome is a `Fetched<T>`: "empty" (not_found) is never confused with "failed"
 */
import type { Fetched } from '@aon/core';

export interface HttpClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxPerMinute?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest we are willing to wait inside one call for a Retry-After. Longer => return rate_limited. */
  maxInlineWaitMs?: number;
  cacheTtlMs?: number;
  userAgent?: string;
}

export interface HttpStats {
  requestsSent: number;
  cacheHits: number;
  dedupHits: number;
  rateLimited: number;
  errors: number;
  lastSuccessAt: number | null;
  blockedUntil: number | null;
}

export class AonHttp {
  private readonly o: Required<Omit<HttpClientOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  private readonly sent: number[] = [];
  private readonly cache = new Map<string, { at: number; value: Fetched<unknown> }>();
  private readonly inflight = new Map<string, Promise<Fetched<unknown>>>();
  private blockedUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();
  readonly stats: HttpStats = { requestsSent: 0, cacheHits: 0, dedupHits: 0, rateLimited: 0, errors: 0, lastSuccessAt: null, blockedUntil: null };

  constructor(opts: HttpClientOptions) {
    this.o = {
      fetchImpl: opts.fetchImpl ?? fetch,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      maxPerMinute: opts.maxPerMinute ?? 45,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxRetries: opts.maxRetries ?? 2,
      maxInlineWaitMs: opts.maxInlineWaitMs ?? 15_000,
      cacheTtlMs: opts.cacheTtlMs ?? 30_000,
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
      userAgent: opts.userAgent ?? 'aon-roles-platform/0.1 (+discord bot)',
    };
  }

  /** GET a path (must start with "/"). Query values are URL-encoded. */
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<Fetched<unknown>> {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const url = `${this.o.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    const cached = this.cache.get(url);
    if (cached && this.o.now() - cached.at < this.o.cacheTtlMs) {
      this.stats.cacheHits++;
      return Promise.resolve(cached.value);
    }
    const pending = this.inflight.get(url);
    if (pending) {
      this.stats.dedupHits++;
      return pending;
    }
    const p = this.run(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async run(url: string): Promise<Fetched<unknown>> {
    let attempt = 0;
    for (;;) {
      const gate = await this.acquireSlot();
      if (gate === 'blocked_too_long') return { status: 'rate_limited', retryAfterMs: Math.max(0, this.blockedUntil - this.o.now()) };

      let res: Response;
      try {
        res = await this.send(url);
      } catch (e) {
        this.stats.errors++;
        if (attempt++ < this.o.maxRetries) {
          await this.o.sleep(500 * 3 ** (attempt - 1));
          continue;
        }
        return { status: 'error', message: e instanceof Error ? e.message : 'network error' };
      }

      if (res.status === 429) {
        this.stats.rateLimited++;
        const waitMs = parseRetryAfter(res.headers.get('retry-after'), this.o.now()) ?? 5_000;
        this.blockedUntil = Math.max(this.blockedUntil, this.o.now() + waitMs);
        this.stats.blockedUntil = this.blockedUntil;
        if (attempt++ < this.o.maxRetries && waitMs <= this.o.maxInlineWaitMs) continue;
        return { status: 'rate_limited', retryAfterMs: waitMs };
      }
      if (res.status === 404) return this.remember(url, { status: 'not_found' });
      if (res.status >= 500) {
        this.stats.errors++;
        if (attempt++ < this.o.maxRetries) {
          await this.o.sleep(500 * 3 ** (attempt - 1));
          continue;
        }
        return { status: 'error', message: `HTTP ${res.status}` };
      }
      if (!res.ok) {
        this.stats.errors++;
        return { status: 'error', message: `HTTP ${res.status}` }; // 4xx other than 404/429: our bug, don't retry
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        this.stats.errors++;
        return { status: 'error', message: 'malformed JSON in response' };
      }
      this.stats.lastSuccessAt = this.o.now();
      return this.remember(url, { status: 'ok', data: body });
    }
  }

  private remember(url: string, value: Fetched<unknown>): Fetched<unknown> {
    this.cache.set(url, { at: this.o.now(), value });
    return value;
  }

  private async send(url: string): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    try {
      this.stats.requestsSent++;
      return await this.o.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': this.o.userAgent }, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Serialises slot acquisition so concurrent callers can never exceed the window. */
  private acquireSlot(): Promise<'ok' | 'blocked_too_long'> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = this.o.now();
        if (this.blockedUntil > now) {
          const wait = this.blockedUntil - now;
          if (wait > this.o.maxInlineWaitMs) return 'blocked_too_long' as const;
          await this.o.sleep(wait);
          continue;
        }
        while (this.sent.length && now - this.sent[0]! >= 60_000) this.sent.shift();
        if (this.sent.length < this.o.maxPerMinute) {
          this.sent.push(now);
          return 'ok' as const;
        }
        await this.o.sleep(60_000 - (now - this.sent[0]!) + 5);
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function parseRetryAfter(h: string | null, nowMs: number): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}
