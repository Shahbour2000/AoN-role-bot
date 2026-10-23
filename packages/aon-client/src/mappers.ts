/**
 * ALL knowledge about Age of Nations response shapes lives in this file.
 *
 * VERIFIED against real responses supplied by the project owner (handoff file, 2026-10-17; large arrays were
 * abbreviated there, so those fixtures are labelled PARTIAL):
 *   GET /players/by-name/{u}  : id, username, deleted, countryId, damage.{total,day,week,month} (numeric STRINGS),
 *                               offices[] (top level), militaryUnit.{id,name,role}, party.{id,name,role}
 *                               (the game-native `rank` object is deliberately ignored)
 *   GET /players/{id}/stats   : id, username, countryId, damage.{all,day,week,month}, work.all, trade.all, companies.count
 *   GET /countries/{c}/government/members : countryId, countryName, count, members[]
 *        member: role, userId, username, level, source, electionId, startedAt, label, party (nullable)
 *        observed role values: president, vicePresident, ministerDefense, ministerEconomy, congress
 *   GET /countries/{c}/citizens : citizens[{id,username,avatarUrl,level,countryId,homeRegionId,regionId,lastActiveAt,
 *                               citizenshipChangedAt,active,offices[]}], total, hasMore, offset, limit
 *   GET /countries/{c}/parties : countryId, createCost, parties[{id,name,leaderId?,leaderName,members(count),ruling,ethics[]}]
 *   GET /countries/{c}/units   : [{id,name,countryId,regionId,joinPolicy,ownerId,ownerName,members(count),damage,capacity,...}]
 * NOT verified: profile of a player WITHOUT a party/unit (null vs absent), the exact `role` values other than
 *   party "leader" / unit "commander", ALL alliance responses, /parties/{id}, /units/{id} member lists,
 *   the batch /players?ids= response shape.
 *
 * Rule for every extractor: unsure => `incomplete` (callers then change no roles).
 */
import { parseDamage, type Fetched } from '@aon/core';

export const MAPPING_STATUS = {
  allTimeDamageStats: 'verified',      // damage.all
  allTimeDamageProfile: 'verified',    // damage.total
  playerProfileCore: 'verified',       // id, username, countryId
  playerPartyUnit: 'verified-present', // party / militaryUnit objects confirmed when set; null-case unconfirmed
  citizensPaged: 'verified',
  partiesList: 'verified',
  unitsList: 'verified',
  governmentRoster: 'verified',
  alliance: 'unverified',
  partyMemberList: 'unverified',
  unitMemberList: 'unverified',
} as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const idString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** Strict numeric parse via the core rules. Anything unusable => incomplete (never 0). */
function damageAt(body: unknown, path: string): Fetched<number> {
  const raw = getPath(body, path);
  const p = parseDamage(raw);
  return p.ok ? { status: 'ok', data: p.value } : { status: 'incomplete', missing: [`${path} (${p.reason})`] };
}

// ---------------------------------------------------------------- damage

/** Preferred source: stats endpoint, `damage.all`. Never reads day/week/month. */
export function extractAllTimeDamageFromStats(res: Fetched<unknown>): Fetched<number> {
  return res.status === 'ok' ? damageAt(res.data, 'damage.all') : res;
}
/** Documented alternative: public profile, `damage.total`. */
export function extractAllTimeDamageFromProfile(res: Fetched<unknown>): Fetched<number> {
  return res.status === 'ok' ? damageAt(res.data, 'damage.total') : res;
}

// ---------------------------------------------------------------- player profile

export interface Affiliation { id: string; name: string | null; role: string | null }
export type Membership<T> = { state: 'member'; value: T } | { state: 'not_member' } | { state: 'unknown' };

export interface PlayerProfile {
  id: string;
  username: string | null;
  countryId: string | null;
  /** damage.total, or incomplete. */
  damageTotal: Fetched<number>;
  party: Membership<Affiliation>;
  unit: Membership<Affiliation>;
  /** Top-level `offices` (e.g. ["congress","vicePresident"]); null when the field is absent/unreadable. */
  offices: string[] | null;
}

function affiliation(root: Json, key: 'party' | 'unit' | 'militaryUnit'): Membership<Affiliation> {
  if (!(key in root)) return { state: 'unknown' };          // key absent: cannot conclude anything
  const v = root[key];
  if (v === null) return { state: 'not_member' };            // explicit null: confirmed-by-owner field, null-case still to be sampled
  if (!isObj(v)) return { state: 'unknown' };
  const id = idString(v['id']);
  if (!id) return { state: 'unknown' };
  return { state: 'member', value: { id, name: typeof v['name'] === 'string' ? v['name'] : null, role: typeof v['role'] === 'string' ? v['role'] : null } };
}

export function extractPlayerProfile(res: Fetched<unknown>): Fetched<PlayerProfile> {
  if (res.status !== 'ok') return res;
  const root = res.data;
  if (!isObj(root)) return { status: 'incomplete', missing: ['profile object'] };
  if (root['deleted'] === true) return { status: 'not_found' };      // deleted accounts behave like missing players
  const id = idString(root['id']);
  if (!id) return { status: 'incomplete', missing: ['id'] };
  const offices = Array.isArray(root['offices']) && root['offices'].every((o) => typeof o === 'string') ? (root['offices'] as string[]) : null;
  return {
    status: 'ok',
    data: {
      id,
      username: typeof root['username'] === 'string' ? root['username'] : null,
      countryId: idString(root['countryId']),
      damageTotal: damageAt(root, 'damage.total'),
      party: affiliation(root, 'party'),
      // The real profile uses `militaryUnit`; `unit` is accepted as an alias only if `militaryUnit` is absent.
      unit: 'militaryUnit' in root ? affiliation(root, 'militaryUnit') : affiliation(root, 'unit'),
      offices,
    },
  };
}

/** Back-compat identity used by /link (id + username only). */
export interface PlayerIdentity { id: string; username: string | null }
export function extractPlayer(res: Fetched<unknown>): Fetched<PlayerIdentity> {
  const p = extractPlayerProfile(res);
  return p.status === 'ok' ? { status: 'ok', data: { id: p.data.id, username: p.data.username } } : p;
}

/** Citizenship: only a DIFFERENT non-empty country id proves "not a citizen". Missing/null => unknown. */
export function citizenshipOf(profile: PlayerProfile, countryId: string): Membership<string> {
  if (profile.countryId === null) return { state: 'unknown' };
  return profile.countryId === countryId ? { state: 'member', value: countryId } : { state: 'not_member' };
}

// ---------------------------------------------------------------- government roster

/** Canonical kinds for the role values actually observed. Everything else stays `other` + raw role. */
export type GovernmentKind = 'president' | 'vice_president' | 'minister_defense' | 'minister_economy' | 'congress' | 'other';

const OBSERVED_ROLES: Readonly<Record<string, GovernmentKind>> = {
  president: 'president',
  vicePresident: 'vice_president',
  ministerDefense: 'minister_defense',
  ministerEconomy: 'minister_economy',
  congress: 'congress',
};

export interface GovernmentMember {
  playerId: string;
  username: string | null;
  /** Raw API role value, always preserved (guilds map roles by this string). */
  role: string;
  kind: GovernmentKind;
  label: string | null;
  level: number | null;
  partyId: string | null;
  partyName: string | null;
  startedAt: string | null;
}

export interface GovernmentRoster {
  countryId: string;
  countryName: string | null;
  members: GovernmentMember[];
  /** Role values not in the observed table. Surfaced to admins; members are NOT dropped. */
  unknownRoles: string[];
}

function partyOf(v: unknown): { id: string | null; name: string | null } {
  if (v === null || v === undefined) return { id: null, name: null };
  if (isObj(v)) return { id: idString(v['id']), name: typeof v['name'] === 'string' ? v['name'] : null };
  return { id: idString(v), name: null };
}

export function extractGovernmentRoster(res: Fetched<unknown>, expectedCountryId?: string): Fetched<GovernmentRoster> {
  if (res.status !== 'ok') return res;
  const body = res.data;
  if (!isObj(body)) return { status: 'incomplete', missing: ['roster object'] };
  const list = body['members'];
  if (!Array.isArray(list)) return { status: 'incomplete', missing: ['members[]'] };
  const countryId = idString(body['countryId']);
  if (!countryId) return { status: 'incomplete', missing: ['countryId'] };
  if (expectedCountryId !== undefined && countryId !== expectedCountryId) return { status: 'incomplete', missing: ['countryId mismatch'] };
  // An empty roster can never be taken as proof that everyone left office.
  if (list.length === 0) return { status: 'incomplete', missing: ['empty roster'] };
  const count = body['count'];
  if (typeof count === 'number' && count !== list.length) return { status: 'incomplete', missing: [`count ${count} != members ${list.length}`] };

  const members: GovernmentMember[] = [];
  const bad: string[] = [];
  const unknown = new Set<string>();
  list.forEach((m, i) => {
    if (!isObj(m)) return bad.push(`members[${i}]`);
    const playerId = idString(m['userId']);
    const role = typeof m['role'] === 'string' && m['role'] ? m['role'] : null;
    if (!playerId || !role) return bad.push(`members[${i}] userId/role`);
    const kind = OBSERVED_ROLES[role] ?? 'other';
    if (kind === 'other') unknown.add(role);
    const party = partyOf(m['party']);
    members.push({
      playerId, role, kind,
      username: typeof m['username'] === 'string' ? m['username'] : null,
      label: typeof m['label'] === 'string' ? m['label'] : null,
      level: typeof m['level'] === 'number' ? m['level'] : null,
      partyId: party.id, partyName: party.name,
      startedAt: typeof m['startedAt'] === 'string' ? m['startedAt'] : null,
    });
  });
  if (bad.length) return { status: 'incomplete', missing: bad };
  return { status: 'ok', data: { countryId, countryName: typeof body['countryName'] === 'string' ? body['countryName'] : null, members, unknownRoles: [...unknown].sort() } };
}

/** One player can hold several offices: collect all raw role values per player. */
export function rolesByPlayer(roster: GovernmentRoster): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of roster.members) {
    const s = out.get(m.playerId) ?? new Set<string>();
    s.add(m.role);
    out.set(m.playerId, s);
  }
  return out;
}


// ---------------------------------------------------------------- citizens (paginated)

export interface Citizen { id: string; username: string | null; active: boolean | null; level: number | null; offices: string[] }
export interface CitizensPage { citizens: Citizen[]; total: number; hasMore: boolean; offset: number; limit: number }

export function extractCitizensPage(res: Fetched<unknown>): Fetched<CitizensPage> {
  if (res.status !== 'ok') return res;
  const b = res.data;
  if (!isObj(b) || !Array.isArray(b['citizens'])) return { status: 'incomplete', missing: ['citizens[]'] };
  const total = b['total'], offset = b['offset'], limit = b['limit'];
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return { status: 'incomplete', missing: ['total'] };
  if (typeof offset !== 'number' || typeof limit !== 'number') return { status: 'incomplete', missing: ['offset/limit'] };
  const citizens: Citizen[] = [];
  const bad: string[] = [];
  b['citizens'].forEach((c, i) => {
    if (!isObj(c)) return bad.push(`citizens[${i}]`);
    const id = idString(c['id']);
    if (!id) return bad.push(`citizens[${i}].id`);
    citizens.push({
      id, username: typeof c['username'] === 'string' ? c['username'] : null,
      active: typeof c['active'] === 'boolean' ? c['active'] : null, level: typeof c['level'] === 'number' ? c['level'] : null,
      offices: Array.isArray(c['offices']) ? c['offices'].filter((o): o is string => typeof o === 'string') : [],
    });
  });
  if (bad.length) return { status: 'incomplete', missing: bad };
  return { status: 'ok', data: { citizens, total, hasMore: b['hasMore'] === true, offset, limit } };
}

export interface CitizensIndex { countryId: string; total: number; byId: Map<string, Citizen> }

// ---------------------------------------------------------------- parties & units (for the dashboard pickers)

export interface PartySummary { id: string; name: string | null; leaderId: string | null; leaderName: string | null; members: number | null; ruling: boolean | null }
export function extractParties(res: Fetched<unknown>): Fetched<PartySummary[]> {
  if (res.status !== 'ok') return res;
  const list = isObj(res.data) ? res.data['parties'] : undefined;
  if (!Array.isArray(list)) return { status: 'incomplete', missing: ['parties[]'] };
  const out: PartySummary[] = [];
  for (const [i, p] of list.entries()) {
    const id = isObj(p) ? idString(p['id']) : null;
    if (!isObj(p) || !id) return { status: 'incomplete', missing: [`parties[${i}].id`] };
    out.push({ id, name: typeof p['name'] === 'string' ? p['name'] : null, leaderId: idString(p['leaderId']), leaderName: typeof p['leaderName'] === 'string' ? p['leaderName'] : null,
      members: typeof p['members'] === 'number' ? p['members'] : null, ruling: typeof p['ruling'] === 'boolean' ? p['ruling'] : null });
  }
  return { status: 'ok', data: out };
}

export interface UnitSummary { id: string; name: string | null; countryId: string | null; ownerId: string | null; ownerName: string | null; members: number | null; capacity: number | null; joinPolicy: string | null }
export function extractUnits(res: Fetched<unknown>): Fetched<UnitSummary[]> {
  if (res.status !== 'ok') return res;
  const list = Array.isArray(res.data) ? res.data : isObj(res.data) && Array.isArray(res.data['units']) ? res.data['units'] : undefined; // sample is a bare array
  if (!list) return { status: 'incomplete', missing: ['units[]'] };
  const out: UnitSummary[] = [];
  for (const [i, u] of list.entries()) {
    const id = isObj(u) ? idString(u['id']) : null;
    if (!isObj(u) || !id) return { status: 'incomplete', missing: [`units[${i}].id`] };
    out.push({ id, name: typeof u['name'] === 'string' ? u['name'] : null, countryId: idString(u['countryId']), ownerId: idString(u['ownerId']), ownerName: typeof u['ownerName'] === 'string' ? u['ownerName'] : null,
      members: typeof u['members'] === 'number' ? u['members'] : null, capacity: typeof u['capacity'] === 'number' ? u['capacity'] : null, joinPolicy: typeof u['joinPolicy'] === 'string' ? u['joinPolicy'] : null });
  }
  return { status: 'ok', data: out };
}


// ---------------------------------------------------------------- player card (for /profile)
// Only fields present in the real profile / stats samples are read. Anything missing or malformed becomes null and is simply
// left out of the card; nothing is guessed. Money values (strings in 1/10,000 gold) are deliberately NOT read: wallets are private.

const numOrNull = (v: unknown): number | null => { const p = parseDamage(v); return p.ok ? p.value : null; };
const periodTriple = (o: unknown, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, isObj(o) ? numOrNull(o[k]) : null])) as Record<string, number | null>;

export interface ProfileCard {
  id: string; username: string | null; avatarUrl: string | null; countryId: string | null;
  level: number | null; xp: number | null; prestige: number | null;
  damage: { total: number | null; day: number | null; week: number | null; month: number | null };
  offices: string[] | null; party: Membership<Affiliation>; unit: Membership<Affiliation>;
  joinedAt: string | null; serverTime: string | null;
}
export function extractProfileCard(res: Fetched<unknown>): Fetched<ProfileCard> {
  const base = extractPlayerProfile(res);
  if (base.status !== 'ok' || !isObj((res as { data: unknown }).data)) return base as Fetched<never>;
  const root = (res as { data: Json }).data;
  const d = periodTriple(root['damage'], ['total', 'day', 'week', 'month']);
  return { status: 'ok', data: {
    id: base.data.id, username: base.data.username, countryId: base.data.countryId, offices: base.data.offices, party: base.data.party, unit: base.data.unit,
    avatarUrl: typeof root['avatarUrl'] === 'string' && root['avatarUrl'] ? root['avatarUrl'] : null,
    level: numOrNull(root['level']), xp: numOrNull(root['xp']), prestige: numOrNull(root['prestige']),
    damage: { total: d['total']!, day: d['day']!, week: d['week']!, month: d['month']! },
    joinedAt: typeof root['joinedAt'] === 'string' ? root['joinedAt'] : null, serverTime: typeof root['serverTime'] === 'string' ? root['serverTime'] : null,
  } };
}

export interface StatsCard {
  damage: { all: number | null; day: number | null; week: number | null; month: number | null };
  work: { all: number | null; day: number | null; week: number | null; month: number | null };
  trade: { all: number | null; day: number | null; week: number | null; month: number | null };
  companies: number | null;
}
export function extractStatsCard(res: Fetched<unknown>): Fetched<StatsCard> {
  if (res.status !== 'ok') return res;
  const b = res.data;
  if (!isObj(b)) return { status: 'incomplete', missing: ['stats object'] };
  const k = ['all', 'day', 'week', 'month'] as const;
  const w = periodTriple(b['work'], k), t = periodTriple(b['trade'], k), dm = periodTriple(b['damage'], k);
  return { status: 'ok', data: {
    damage: { all: dm['all']!, day: dm['day']!, week: dm['week']!, month: dm['month']! }, work: { all: w['all']!, day: w['day']!, week: w['week']!, month: w['month']! },
    trade: { all: t['all']!, day: t['day']!, week: t['week']!, month: t['month']! }, companies: isObj(b['companies']) ? numOrNull(b['companies']['count']) : null,
  } };
}
