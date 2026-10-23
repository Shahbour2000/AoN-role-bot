import { describe, expect, it } from 'vitest';
import {
  AonClient, citizenshipOf, extractAllTimeDamageFromProfile, extractAllTimeDamageFromStats, extractCitizensPage, extractGovernmentRoster,
  extractParties, extractPlayer, extractPlayerProfile, extractUnits, rolesByPlayer,
} from '../src/index.js';
import { citizensPages, parties, profileAbuDujana, profileNoAffiliation, rosterAbbreviated, rosterComplete, statsAbuDujana, units } from './fixtures.js';

const ok = (data: unknown) => ({ status: 'ok' as const, data });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('all-time damage (stats: damage.all)', () => {
  it('REAL SAMPLE: reads damage.all "649601"', () => expect(extractAllTimeDamageFromStats(ok(statsAbuDujana))).toEqual({ status: 'ok', data: 649_601 }));
  it('NEVER substitutes day/week/month (even though month equals the total in the sample)', () => {
    for (const body of [{ damage: { day: '5', week: '6', month: '649601' } }, { damage: { total: '9' } }, { damage: { day: 5 } }]) {
      expect(extractAllTimeDamageFromStats(ok(body)).status).toBe('incomplete');
    }
  });
  it('missing, malformed, negative or non-finite values are incomplete (never 0)', () => {
    for (const all of [undefined, null, '', 'lots', '1,000', -1, NaN, Infinity, {}, []]) expect(extractAllTimeDamageFromStats(ok({ damage: { all } })).status).toBe('incomplete');
    expect(extractAllTimeDamageFromStats(ok(null)).status).toBe('incomplete');
  });
  it('passes failures through untouched', () => {
    expect(extractAllTimeDamageFromStats({ status: 'rate_limited', retryAfterMs: 5 })).toEqual({ status: 'rate_limited', retryAfterMs: 5 });
    expect(extractAllTimeDamageFromStats({ status: 'not_found' })).toEqual({ status: 'not_found' });
  });
});

describe('profile damage alternative (damage.total)', () => {
  it('REAL SAMPLE: reads damage.total "649601"', () => expect(extractAllTimeDamageFromProfile(ok(profileAbuDujana))).toEqual({ status: 'ok', data: 649_601 }));
  it('does not read damage.all or day/week/month', () => expect(extractAllTimeDamageFromProfile(ok({ damage: { all: 5, day: 5 } })).status).toBe('incomplete'));
});

describe('player profile (real shape)', () => {
  it('maps id, username, countryId, party (role leader), militaryUnit (role commander) and offices', () => {
    const r = extractPlayerProfile(ok(profileAbuDujana));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data).toMatchObject({ id: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana', countryId: 'eg', damageTotal: { status: 'ok', data: 649_601 }, offices: ['congress', 'vicePresident'] });
    expect(r.data.party).toEqual({ state: 'member', value: { id: 'pty_66rrvzjjnzub3gr7', name: 'Ummah Caliphate Party', role: 'leader' } });
    expect(r.data.unit).toEqual({ state: 'member', value: { id: 'mu_bsgmbfr8vj8j930g', name: '<unit name>', role: 'commander' } });
  });
  it('ignores the game-native rank object entirely', () => {
    const r = extractPlayerProfile(ok(profileAbuDujana));
    expect(JSON.stringify(r)).not.toContain('"lieutenant"');
  });
  it('explicit null party/militaryUnit => not_member; absent key => unknown (never a revocation signal)', () => {
    const none = extractPlayerProfile(ok(profileNoAffiliation));
    if (none.status === 'ok') expect([none.data.party.state, none.data.unit.state]).toEqual(['not_member', 'not_member']);
    const absent = clone(profileAbuDujana) as Record<string, unknown>;
    delete absent['party']; delete absent['militaryUnit'];
    const r = extractPlayerProfile(ok(absent));
    if (r.status === 'ok') expect([r.data.party.state, r.data.unit.state]).toEqual(['unknown', 'unknown']);
  });
  it('an alias `unit` key is honoured only when militaryUnit is absent', () => {
    const a = clone(profileAbuDujana) as Record<string, unknown>; delete a['militaryUnit']; a['unit'] = { id: 'mu_1', name: 'U', role: 'member' };
    const r = extractPlayerProfile(ok(a));
    if (r.status === 'ok') expect(r.data.unit.state).toBe('member');
  });
  it('malformed party object is unknown, not not_member', () => {
    const r = extractPlayerProfile(ok({ ...profileAbuDujana, party: { name: 'no id' } }));
    if (r.status === 'ok') expect(r.data.party.state).toBe('unknown');
  });
  it('offices missing/garbled => null (unknown), empty array => []', () => {
    const o = (v: unknown) => { const r = extractPlayerProfile(ok({ ...profileAbuDujana, offices: v })); return r.status === 'ok' ? r.data.offices : 'x'; };
    expect(o([])).toEqual([]); expect(o(undefined)).toBeNull(); expect(o([1, 2])).toBeNull();
  });
  it('a DELETED player is reported as not_found', () => expect(extractPlayerProfile(ok({ ...profileAbuDujana, deleted: true }))).toEqual({ status: 'not_found' }));
  it('no id => incomplete; a bad damage.total does not invalidate the identity', () => {
    expect(extractPlayerProfile(ok({ username: 'x' })).status).toBe('incomplete');
    const r = extractPlayerProfile(ok({ ...profileAbuDujana, damage: { total: 'x' } }));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.damageTotal.status).toBe('incomplete');
  });
  it('extractPlayer exposes id + username (stable id, mutable name)', () => expect(extractPlayer(ok(profileAbuDujana))).toEqual({ status: 'ok', data: { id: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana' } }));
});

describe('citizenship helper', () => {
  const p = (countryId: unknown) => { const r = extractPlayerProfile(ok({ ...profileAbuDujana, countryId })); if (r.status !== 'ok') throw new Error('x'); return r.data; };
  it('same country => member; different => not_member; missing/null => unknown', () => {
    expect(citizenshipOf(p('eg'), 'eg').state).toBe('member');
    expect(citizenshipOf(p('pl'), 'eg').state).toBe('not_member');
    expect(citizenshipOf(p(null), 'eg').state).toBe('unknown');
  });
});

describe('government roster (real shape)', () => {
  it('maps observed roles, keeps raw role strings, handles party:null and multiple offices for one player', () => {
    const r = extractGovernmentRoster(ok(rosterComplete), 'eg');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.members.map((m) => [m.role, m.kind])).toEqual([
      ['president', 'president'], ['vicePresident', 'vice_president'], ['ministerDefense', 'minister_defense'], ['ministerEconomy', 'minister_economy'], ['congress', 'congress'], ['congress', 'congress'],
    ]);
    expect(r.data.members.at(-1)).toMatchObject({ partyId: null, partyName: null });
    expect([...rolesByPlayer(r.data).get('usr_r9s8exrd8arivqrq')!].sort()).toEqual(['congress', 'vicePresident']);
    expect(r.data.unknownRoles).toEqual([]);
  });
  it('REAL SAMPLE count 14 with only 5-6 members listed is a TRUNCATED roster => incomplete', () => {
    expect(extractGovernmentRoster(ok(rosterAbbreviated), 'eg').status).toBe('incomplete');
  });
  it('unknown role values are preserved (kind=other) and reported, not dropped', () => {
    const body = clone(rosterComplete);
    body.members.push({ role: 'ministerForeign', userId: 'u_9', username: 'F', party: null } as never); body.count += 1;
    const r = extractGovernmentRoster(ok(body), 'eg');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.data.members.at(-1)).toMatchObject({ role: 'ministerForeign', kind: 'other' }); expect(r.data.unknownRoles).toEqual(['ministerForeign']); }
  });
  it('missing, empty, inconsistent, foreign-country rosters are incomplete', () => {
    const cases: unknown[] = [{}, null, { countryId: 'eg', members: 'x' }, { ...rosterComplete, members: [], count: 0 }, { ...rosterComplete, members: [...rosterComplete.members, { weird: true }], count: 7 }, { ...rosterComplete, countryId: undefined }];
    for (const c of cases) expect(extractGovernmentRoster(ok(c), 'eg').status).toBe('incomplete');
    expect(extractGovernmentRoster(ok({ ...rosterComplete, countryId: 'pl' }), 'eg').status).toBe('incomplete');
  });
  it('transient failures pass through as failures', () => {
    for (const f of [{ status: 'error' as const, message: 'x' }, { status: 'rate_limited' as const }, { status: 'not_found' as const }]) expect(extractGovernmentRoster(f, 'eg')).toEqual(f);
  });
});

describe('citizens page / parties / units mappers', () => {
  it('REAL SHAPE: 50 of 51, hasMore true', () => {
    const r = extractCitizensPage(ok(citizensPages(50)(0)));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.data).toMatchObject({ total: 51, hasMore: true, offset: 0, limit: 50 }); expect(r.data.citizens).toHaveLength(50); expect(r.data.citizens[3]!.offices).toEqual(['congress']); expect(r.data.citizens[0]!.active).toBe(false); }
  });
  it('null/missing optional fields do not break parsing; missing id or total does', () => {
    expect(extractCitizensPage(ok({ citizens: [{ id: 'a', username: null, active: undefined, offices: null }], total: 1, hasMore: false, offset: 0, limit: 50 })).status).toBe('ok');
    expect(extractCitizensPage(ok({ citizens: [{ username: 'x' }], total: 1, hasMore: false, offset: 0, limit: 50 })).status).toBe('incomplete');
    expect(extractCitizensPage(ok({ citizens: [], hasMore: false, offset: 0, limit: 50 })).status).toBe('incomplete');
    expect(extractCitizensPage(ok({})).status).toBe('incomplete');
  });
  it('parties: leaderId may be absent; members is a COUNT', () => {
    const r = extractParties(ok(parties));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.data[0]).toMatchObject({ id: 'pty_66rrvzjjnzub3gr7', leaderId: 'usr_r9s8exrd8arivqrq', members: 11, ruling: true }); expect(r.data[1]!.leaderId).toBeNull(); }
    expect(extractParties(ok({ parties: [{ name: 'no id' }] })).status).toBe('incomplete');
  });
  it('units: bare array as in the sample (or {units}), owner info optional', () => {
    const r = extractUnits(ok(units));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data[1]).toMatchObject({ id: 'mu_wn6dmwp2fegfstw3', ownerId: null, ownerName: 'MidEastrnVonChudLand', members: 10, capacity: 10 });
    expect(extractUnits(ok({ units })).status).toBe('ok');
    expect(extractUnits(ok('nope')).status).toBe('incomplete');
  });
});

describe('AonClient', () => {
  const route = (map: Record<string, unknown | ((q: URLSearchParams) => unknown)>, hits: string[] = []) => (async (url: string) => {
    const u = new URL(url); const path = u.pathname.replace('/api/v1', ''); hits.push(path + u.search);
    const v = map[path];
    return v === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(typeof v === 'function' ? (v as (q: URLSearchParams) => unknown)(u.searchParams) : v), { status: 200 });
  }) as unknown as typeof fetch;
  const mk = (map: Record<string, unknown | ((q: URLSearchParams) => unknown)>, hits: string[] = []) => new AonClient({ baseUrl: 'https://x.test/api/v1', fetchImpl: route(map, hits) });

  it('rejects path-injection ids without any network call', async () => {
    const c = new AonClient({ baseUrl: 'https://x.test/api/v1', fetchImpl: (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch });
    for (const f of [() => c.governmentRoster('../../admin'), () => c.playerAllTimeDamage('a/b'), () => c.countryCitizens('x?y'), () => c.countryParties('..')]) expect((await f()).status).toBe('error');
  });
  it('uses stats damage.all; profile fallback only if enabled and stats is incomplete (not on failure)', async () => {
    expect(await mk({ '/players/u1/stats': statsAbuDujana }).playerAllTimeDamage('u1')).toEqual({ status: 'ok', data: 649_601 });
    const m = { '/players/u1/stats': { damage: { day: 1 } }, '/players/u1': profileAbuDujana };
    expect((await mk(m).playerAllTimeDamage('u1')).status).toBe('incomplete');
    expect(await mk(m).playerAllTimeDamage('u1', { fallbackToProfile: true })).toEqual({ status: 'ok', data: 649_601 });
    expect(await mk({ '/players/u1': profileAbuDujana }).playerAllTimeDamage('u1', { fallbackToProfile: true })).toEqual({ status: 'not_found' });
  });
  it('CITIZENS: follows offset/limit until the reported total (51 => 2 pages of 50, then complete)', async () => {
    const hits: string[] = [];
    const page = citizensPages(50);
    const r = await mk({ '/countries/eg/citizens': (q: URLSearchParams) => page(Number(q.get('offset'))) }, hits).countryCitizens('eg', { pageSize: 50 });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.data.byId.size).toBe(51); expect(r.data.total).toBe(51); }
    expect(hits).toEqual(['/countries/eg/citizens?limit=50&offset=0', '/countries/eg/citizens?limit=50&offset=50']);
  });
  it('CITIZENS: default page size 100 fetches 51 citizens in one request', async () => {
    const hits: string[] = [];
    const r = await mk({ '/countries/eg/citizens': (q: URLSearchParams) => citizensPages(Number(q.get('limit')))(Number(q.get('offset'))) }, hits).countryCitizens('eg');
    expect(r.status).toBe('ok'); expect(hits).toHaveLength(1);
  });
  it('CITIZENS: a later page failing, a total that changes mid-paging, or a short count => incomplete (never a partial list)', async () => {
    const page = citizensPages(50);
    expect((await mk({ '/countries/eg/citizens': (q: URLSearchParams) => (Number(q.get('offset')) === 0 ? page(0) : { nope: true }) }).countryCitizens('eg', { pageSize: 50 })).status).toBe('incomplete');
    expect((await mk({ '/countries/eg/citizens': (q: URLSearchParams) => ({ ...page(Number(q.get('offset'))), total: Number(q.get('offset')) === 0 ? 51 : 99 }) }).countryCitizens('eg', { pageSize: 50 })).status).toBe('incomplete');
    expect((await mk({ '/countries/eg/citizens': (q: URLSearchParams) => ({ ...page(Number(q.get('offset'))), total: 60 }) }).countryCitizens('eg', { pageSize: 50 })).status).toBe('incomplete');
  });
  it('CITIZENS: empty page while hasMore, and the page cap, stop the loop', async () => {
    expect((await mk({ '/countries/eg/citizens': () => ({ citizens: [], total: 10, hasMore: true, offset: 0, limit: 50 }) }).countryCitizens('eg')).status).toBe('incomplete');
    const endless = (q: URLSearchParams) => ({ citizens: [citizensPages(1)(Number(q.get('offset'))).citizens[0]], total: 99_999, hasMore: true, offset: Number(q.get('offset')), limit: 1 });
    const hits: string[] = [];
    expect((await mk({ '/countries/eg/citizens': endless }, hits).countryCitizens('eg', { pageSize: 1, maxPages: 3 })).status).toBe('incomplete');
    expect(hits).toHaveLength(3);
  });
  it('fetches a complete roster end to end; a truncated one is incomplete', async () => {
    expect((await mk({ '/countries/eg/government/members': rosterComplete }).governmentRoster('eg')).status).toBe('ok');
    expect((await mk({ '/countries/eg/government/members': rosterAbbreviated }).governmentRoster('eg')).status).toBe('incomplete');
  });
  it('parties and units go through the mappers', async () => {
    expect((await mk({ '/countries/eg/parties': parties }).countryParties('eg')).status).toBe('ok');
    expect((await mk({ '/countries/eg/units': units }).countryUnits('eg')).status).toBe('ok');
  });
});

describe('player card mappers (for /profile)', () => {
  it('REAL SAMPLES: reads avatar, level, xp, prestige, country, damage periods, offices, party and unit', async () => {
    const { extractProfileCard, extractStatsCard } = await import('../src/index.js');
    const p = extractProfileCard(ok(profileAbuDujana));
    expect(p.status).toBe('ok');
    if (p.status !== 'ok') return;
    expect(p.data).toMatchObject({ id: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana', avatarUrl: '/media/8d126155650a12155d333ec5.gif', countryId: 'eg', level: 17, xp: 8284, prestige: 0,
      damage: { total: 649_601, day: 76_197, week: 625_446, month: 649_601 }, offices: ['congress', 'vicePresident'] });
    expect(p.data.party).toMatchObject({ state: 'member', value: { name: 'Ummah Caliphate Party', role: 'leader' } });
    const st = extractStatsCard(ok(statsAbuDujana));
    expect(st.status).toBe('ok');
    if (st.status === 'ok') expect(st.data).toEqual({ damage: { all: 649_601, day: 76_197, week: 625_446, month: 649_601 }, work: { all: 79, day: 4, week: 53, month: 79 }, trade: { all: 7354, day: 644, week: 6930, month: 7354 }, companies: 2 });
  });
  it('never reads money fields (wallets are private) and ignores the game-native rank', async () => {
    const { extractStatsCard, extractProfileCard } = await import('../src/index.js');
    const s = JSON.stringify([extractStatsCard(ok(statsAbuDujana)), extractProfileCard(ok(profileAbuDujana))]);
    expect(s).not.toMatch(/investedMoney|investedSteel|"money"|"wallet"/); expect(s).not.toContain('attackBonusPercent');
  });
  it('missing / malformed fields become null, never invented', async () => {
    const { extractProfileCard, extractStatsCard } = await import('../src/index.js');
    const p = extractProfileCard(ok({ id: 'u1', username: 'x', damage: { total: 'many', week: '12' }, level: 'x', avatarUrl: '', countryId: null }));
    expect(p.status === 'ok' && p.data).toMatchObject({ avatarUrl: null, countryId: null, level: null, xp: null, prestige: null, damage: { total: null, day: null, week: 12, month: null } });
    expect(extractStatsCard(ok({})).status).toBe('ok');
    expect(extractStatsCard(ok(null)).status).toBe('incomplete');
    expect(extractProfileCard(ok({ username: 'no id' })).status).toBe('incomplete');
    expect(extractProfileCard({ status: 'rate_limited', retryAfterMs: 1 }).status).toBe('rate_limited');
  });
  it('AonClient.playerCard fetches profile + stats; one half failing does not fail the other', async () => {
    const map: Record<string, unknown> = { '/players/u1': profileAbuDujana };                        // stats missing => 404
    const c = new AonClient({ baseUrl: 'https://x.test/api/v1', fetchImpl: (async (url: string) => { const p = new URL(url).pathname.replace('/api/v1', ''); return p in map ? new Response(JSON.stringify(map[p]), { status: 200 }) : new Response('{}', { status: 404 }); }) as unknown as typeof fetch });
    const r = await c.playerCard('u1');
    expect(r.profile.status).toBe('ok'); expect(r.stats).toEqual({ status: 'not_found' });
    expect((await c.playerCard('../x')).profile.status).toBe('error');
  });
});
