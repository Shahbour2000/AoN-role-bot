import type { Fetched } from '@aon/core';
import { AonHttp, type HttpClientOptions } from './http.js';
import { extractCountryNames, extractCountryOptions, extractEntityName, type EntityOption, extractProfileCard, extractStatsCard, extractAllTimeDamageFromProfile, extractAllTimeDamageFromStats, extractCitizensPage, extractGovernmentRoster, extractParties, extractPlayer, extractPlayerProfile, extractUnits, type Citizen, type CitizensIndex, type ProfileCard, type StatsCard, type GovernmentRoster, type PartySummary, type PlayerIdentity, type PlayerProfile, type UnitSummary } from './mappers.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const bad = (what: string): Fetched<never> => ({ status: 'error', message: `invalid ${what}` });

/** Typed façade. Every method returns Fetched<T>; none throws on API trouble. */
export class AonClient {
  readonly http: AonHttp;
  constructor(opts: HttpClientOptions) {
    this.http = new AonHttp(opts);
  }

  countries() { return this.http.get('/countries'); }

  private countryNameCache: { at: number; names: Map<string, string> } | null = null;
  /** Display name of a country, or null when unknown/unavailable (callers then omit the row; they never show the raw ID). Cached 6 h. */
  async countryName(id: string): Promise<string | null> {
    if (!ID.test(id)) return null;
    const now = Date.now();
    if (!this.countryNameCache || now - this.countryNameCache.at > 6 * 3_600_000) {
      const res = extractCountryNames(await this.countries());
      if (res.status !== 'ok') return this.countryNameCache?.names.get(id) ?? null;      // keep serving the stale cache on failure
      this.countryNameCache = { at: now, names: res.data };
    }
    return this.countryNameCache.names.get(id) ?? null;
  }
  /** All countries as options (unverified shape: anything unrecognised is `incomplete`, never a guess). */
  async countryOptions(): Promise<Fetched<EntityOption[]>> { return extractCountryOptions(await this.countries()); }
  /** Server-side unit search via the documented `GET /units?search=&countryId=`. The response shape is not sampled: it is read with the verified list extractor, otherwise `incomplete`. */
  async searchUnits(search: string, countryId?: string): Promise<Fetched<UnitSummary[]>> {
    const q = search.trim().slice(0, 40);
    if (countryId !== undefined && !ID.test(countryId)) return bad('countryId');
    return extractUnits(await this.http.get('/units', { search: q || undefined, countryId }));
  }
  /** Name of one party/unit (unverified single-entity shape, only a top-level string `name` is read). */
  async entityName(type: 'party' | 'unit', id: string): Promise<Fetched<string>> {
    if (!ID.test(id)) return bad('id');
    return extractEntityName(await this.http.get(type === 'party' ? `/parties/${id}` : `/units/${id}`));
  }
  countrySummary(id: string) { return ID.test(id) ? this.http.get(`/countries/${id}/summary`) : Promise.resolve(bad('countryId')); }
  async countryUnits(id: string): Promise<Fetched<UnitSummary[]>> { return ID.test(id) ? extractUnits(await this.http.get(`/countries/${id}/units`)) : bad('countryId'); }
  async countryParties(id: string): Promise<Fetched<PartySummary[]>> { return ID.test(id) ? extractParties(await this.http.get(`/countries/${id}/parties`)) : bad('countryId'); }

  /**
   * EVERY citizen of a country, following `offset`/`limit` (API max 100 per page, offset max 10000).
   * Returns `ok` only if the collected count equals the reported `total`; otherwise `incomplete`, because a partial
   * list must never be read as "these players are not citizens". Capped at `maxPages` requests.
   */
  async countryCitizens(countryId: string, opts: { pageSize?: number; maxPages?: number } = {}): Promise<Fetched<CitizensIndex>> {
    if (!ID.test(countryId)) return bad('countryId');
    const limit = Math.min(100, Math.max(1, opts.pageSize ?? 100));
    const maxPages = opts.maxPages ?? 30;
    const byId = new Map<string, Citizen>();
    let total = -1;
    for (let page = 0, offset = 0; ; page++, offset += limit) {
      if (page >= maxPages || offset > 10_000) return { status: 'incomplete', missing: ['citizens (too many pages)'] };
      const res = extractCitizensPage(await this.http.get(`/countries/${countryId}/citizens`, { limit, offset }));
      if (res.status !== 'ok') return res;
      if (total === -1) total = res.data.total;
      else if (res.data.total !== total) return { status: 'incomplete', missing: ['citizens (total changed while paging)'] };
      for (const c of res.data.citizens) byId.set(c.id, c);
      if (!res.data.hasMore) break;
      if (res.data.citizens.length === 0) return { status: 'incomplete', missing: ['citizens (empty page while hasMore)'] };
    }
    if (byId.size !== total) return { status: 'incomplete', missing: [`citizens (${byId.size} collected, total ${total})`] };
    return { status: 'ok', data: { countryId, total, byId } };
  }
  party(id: string) { return ID.test(id) ? this.http.get(`/parties/${id}`) : Promise.resolve(bad('partyId')); }
  unit(id: string) { return ID.test(id) ? this.http.get(`/units/${id}`) : Promise.resolve(bad('muId')); }
  alliances() { return this.http.get('/alliances'); }
  alliance(id: string) { return ID.test(id) ? this.http.get(`/alliances/${id}`) : Promise.resolve(bad('allianceId')); }

  /** Whole roster or a non-ok result. An empty/partial roster is `incomplete` and must never revoke roles. */
  async governmentRoster(countryId: string): Promise<Fetched<GovernmentRoster>> {
    if (!ID.test(countryId)) return bad('countryId');
    return extractGovernmentRoster(await this.http.get(`/countries/${countryId}/government/members`), countryId);
  }

  async playerByName(username: string): Promise<Fetched<PlayerIdentity>> {
    const name = username.trim();
    if (name.length < 1 || name.length > 40) return bad('username');
    return extractPlayer(await this.http.get(`/players/by-name/${encodeURIComponent(name)}`));
  }

  async playerProfileByName(username: string): Promise<Fetched<PlayerProfile>> {
    const name = username.trim();
    if (name.length < 1 || name.length > 40) return bad('username');
    return extractPlayerProfile(await this.http.get(`/players/by-name/${encodeURIComponent(name)}`));
  }

  async playerProfile(userId: string): Promise<Fetched<PlayerProfile>> {
    if (!ID.test(userId)) return bad('userId');
    return extractPlayerProfile(await this.http.get(`/players/${userId}`));
  }

  /**
   * All-time damage from /players/{id}/stats (`damage.all`). Only when `fallbackToProfile` is set and the
   * stats result is `incomplete` (NOT on errors/rate limits) is the profile's `damage.total` consulted.
   */
  async playerAllTimeDamage(userId: string, opts: { fallbackToProfile?: boolean } = {}): Promise<Fetched<number>> {
    if (!ID.test(userId)) return bad('userId');
    const fromStats = extractAllTimeDamageFromStats(await this.http.get(`/players/${userId}/stats`));
    if (fromStats.status === 'incomplete' && opts.fallbackToProfile) {
      return extractAllTimeDamageFromProfile(await this.http.get(`/players/${userId}`));
    }
    return fromStats;
  }

  /**
   * Everything /profile needs: the public profile and the stats, fetched together. Either half may fail independently;
   * the caller decides what to show (a failed stats half simply leaves those fields out).
   */
  async playerCard(userId: string): Promise<{ profile: Fetched<ProfileCard>; stats: Fetched<StatsCard> }> {
    if (!ID.test(userId)) return { profile: bad('userId'), stats: bad('userId') };
    const [p, st] = await Promise.all([this.http.get(`/players/${userId}`), this.http.get(`/players/${userId}/stats`)]);
    return { profile: extractProfileCard(p), stats: extractStatsCard(st) };
  }
}
