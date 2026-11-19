import { describe, expect, it } from 'vitest';
import type { Fetched } from '@aon/core';
import type { PartySummary, PlayerProfile, UnitSummary } from '@aon/client';
import { addRoleMapping, setEntityMemberRole, setIdentityRole, updateGuildSettings } from '@aon/db';
import { syncOneUser } from '../src/index.js';
import { FakeGame, link, map, profileOf, setup } from './harness.js';

/** M1.1 — strict ONE party / ONE unit membership role per player. */
const PR = { a: '400001', b: '400002', c: '400003' }, UR = { a: '400011', b: '400012', c: '400013' }, PRES = '400021', LEADER = '400022', OWNER = '400023';
class Game extends FakeGame {
  parties: Fetched<PartySummary[]> = { status: 'ok', data: [] }; units: Fetched<UnitSummary[]> = { status: 'ok', data: [] };
  /** Optional script: what each successive profile read returns (the last one repeats). */
  script: Fetched<PlayerProfile>[] | null = null;
  async countryParties() { return this.parties; }
  async countryUnits() { return this.units; }
  override async playerProfile(id: string) { if (!this.script) return super.playerProfile(id); this.requests.profile++; return this.script[Math.min(this.requests.profile - 1, this.script.length - 1)]!; }
}
const party = (id: string): PartySummary => ({ id, name: id, leaderId: 'x', leaderName: null, members: 1, ruling: false });
const unit = (id: string, ownerId: string | null = 'o'): UnitSummary => ({ id, name: id, countryId: 'eg', ownerId, ownerName: null, members: 1, capacity: 10, joinPolicy: null, logoUrl: null } as unknown as UnitSummary);
const inParty = (id: string | null, role = 'member') => profileOf('p1', { party: id ? { id, name: id, role } : null });
const inUnit = (id: string | null, role = 'member') => profileOf('p1', { militaryUnit: id ? { id, name: id, role } : null });

async function world() {
  const h = await setup(); const game = new Game(); (h as { game: FakeGame }).game = game;
  await updateGuildSettings(h.db, 'A', { community_type: 'country', country_id: 'eg', modules: { government: true, party: true, unit: true, alliance: false, ranks: false } }, null);
  for (const [e, r] of [['pa', PR.a], ['pb', PR.b], ['pc', PR.c]] as const) expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_party_member', entityId: e, discordRoleId: r, actor: null })).toEqual({ ok: true });
  for (const [e, r] of [['mu1', UR.a], ['mu2', UR.b], ['mu3', UR.c]] as const) expect(await setEntityMemberRole(h.db, { guildId: 'A', kind: 'country_unit_member', entityId: e, discordRoleId: r, actor: null })).toEqual({ ok: true });
  await setIdentityRole(h.db, { guildId: 'A', kind: 'country_party_president', discordRoleId: PRES, actor: null });
  await setIdentityRole(h.db, { guildId: 'A', kind: 'country_unit_leader', discordRoleId: LEADER, actor: null }); await setIdentityRole(h.db, { guildId: 'A', kind: 'country_unit_owner', discordRoleId: OWNER, actor: null });
  game.parties = { status: 'ok', data: [party('pa'), party('pb'), party('pc')] }; game.units = { status: 'ok', data: [unit('mu1'), unit('mu2'), unit('mu3')] };
  await link(h.db, 'A', 'd1', 'p1');
  return { ...h, game };
}
type W = Awaited<ReturnType<typeof world>>;
const run = async (h: W) => { const r = await syncOneUser({ db: h.db, game: h.game, discord: h.discord }, 'A', 'd1'); if ('error' in r) throw new Error(r.error); return r; };
const held = (h: W) => [...h.discord.has('A', 'd1')].sort();
const subsets = <T,>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

describe('strict one-party membership: exhaustive matrix', () => {
  type PS = { name: string; profile: Fetched<PlayerProfile>; id: string | null | 'unknown' };
  const states: PS[] = [
    { name: 'no party', profile: inParty(null), id: null }, { name: 'in pa', profile: inParty('pa'), id: 'pa' }, { name: 'in pb as president', profile: inParty('pb', 'leader'), id: 'pb' },
    { name: 'in a party of another country', profile: inParty('foreign'), id: 'foreign' },
    { name: 'malformed party data', profile: profileOf('p1', { party: 'garbage' }), id: 'unknown' }, { name: 'profile unreadable', profile: { status: 'error', message: 'down' }, id: 'unknown' },
  ];
  const lists: [string, Fetched<PartySummary[]>][] = [['list ok', { status: 'ok', data: [party('pa'), party('pb'), party('pc')] }], ['list error', { status: 'error', message: 'x' }], ['list incomplete', { status: 'incomplete', missing: ['parties[]'] } as never]];
  it('after one run the party roles are EXACTLY what the evidence proves: swap / leave / foreign handled, at most one, and nothing is removed on unknown evidence', async () => {
    const h = await world(); let combos = 0;
    for (const [listName, list] of lists) for (const st of states) for (const start of subsets(['pa', 'pb', 'pc'] as const)) {
      h.game.parties = list; h.game.profiles.set('p1', st.profile); h.discord.give('A', 'd1', ...start.map((e) => ({ pa: PR.a, pb: PR.b, pc: PR.c })[e]));
      await run(h); combos++;
      const expected = (['pa', 'pb', 'pc'] as const).filter((e) => {
        const had = start.includes(e);
        if (st.id === 'unknown') return had;                                   // unreadable / malformed profile: nothing may change
        if (st.id === e) return list.status === 'ok' ? true : had;              // in this party: granted when the country list proves it; otherwise unchanged
        return false;                                                          // not in this party (none / other party / foreign): removed
      }).map((e) => ({ pa: PR.a, pb: PR.b, pc: PR.c })[e]).sort();
      // only membership roles are compared here: the shared President role is evaluated separately (and covered in its own test)
      expect(held(h).filter((r) => (Object.values(PR) as string[]).includes(r)), `${listName} / ${st.name} / start [${start}]`).toEqual(expected);
      if (st.id !== 'unknown' && list.status === 'ok') expect(held(h).filter((r) => Object.values(PR).includes(r)).length).toBeLessThanOrEqual(1);      // never two
    }
    expect(combos).toBe(3 * 6 * 8);
  });
  it('a swap makes exactly ONE removal and ONE addition; the next run makes no Discord call at all; leaving removes the last role', async () => {
    const h = await world(); h.game.profiles.set('p1', inParty('pa')); h.discord.give('A', 'd1'); await run(h); expect(held(h)).toEqual([PR.a]);
    h.discord.calls.length = 0; h.game.profiles.set('p1', inParty('pb')); await run(h); expect(h.discord.calls.sort()).toEqual([`+d1:${PR.b}`, `-d1:${PR.a}`].sort()); expect(held(h)).toEqual([PR.b]);
    h.discord.calls.length = 0; await run(h); expect(h.discord.calls).toEqual([]);
    h.game.profiles.set('p1', inParty(null)); await run(h); expect(held(h)).toEqual([]);
  });
  it('the shared President role is independent of the membership role: it stays across a party switch and goes only with leadership', async () => {
    const h = await world(); h.discord.give('A', 'd1'); h.game.profiles.set('p1', inParty('pa', 'leader')); await run(h); expect(held(h)).toEqual([PR.a, PRES].sort());
    h.game.profiles.set('p1', inParty('pb', 'leader')); await run(h); expect(held(h)).toEqual([PR.b, PRES].sort());
    h.game.profiles.set('p1', inParty('pb', 'member')); await run(h); expect(held(h)).toEqual([PR.b]);
  });
});

describe('strict one-unit membership: exhaustive matrix', () => {
  const ids = ['mu1', 'mu2', 'mu3'] as const; const roleOf = { mu1: UR.a, mu2: UR.b, mu3: UR.c };
  const states = [
    { name: 'no unit', profile: inUnit(null), id: null as string | null }, { name: 'in mu1', profile: inUnit('mu1'), id: 'mu1' }, { name: 'commander of mu2', profile: inUnit('mu2', 'commander'), id: 'mu2' },
    { name: 'in a foreign unit', profile: inUnit('muF'), id: 'muF' }, { name: 'malformed unit data', profile: profileOf('p1', { militaryUnit: 42 }), id: 'unknown' },
    { name: 'profile rate-limited', profile: { status: 'rate_limited', retryAfterMs: 1 } as Fetched<PlayerProfile>, id: 'unknown' },
  ];
  const lists: [string, Fetched<UnitSummary[]>][] = [['list ok', { status: 'ok', data: ids.map((i) => unit(i)) }], ['list error', { status: 'error', message: 'x' }], ['list incomplete', { status: 'incomplete', missing: ['units[]'] } as never]];
  it('exactly the proven unit role after one run; leader / owner roles never confuse it', async () => {
    const h = await world(); let combos = 0;
    for (const [listName, list] of lists) for (const st of states) for (const start of subsets(ids)) {
      h.game.units = list; h.game.profiles.set('p1', st.profile); h.discord.give('A', 'd1', ...start.map((e) => roleOf[e]));
      await run(h); combos++;
      const expected = ids.filter((e) => (st.id === 'unknown' ? start.includes(e) : st.id === e ? (list.status === 'ok' ? true : start.includes(e)) : false)).map((e) => roleOf[e]);
      // leadership roles are evaluated separately; only membership roles are compared here
      expect(held(h).filter((r) => (Object.values(UR) as string[]).includes(r)), `${listName} / ${st.name} / start [${start}]`).toEqual(expected.sort());
    }
    expect(combos).toBe(3 * 6 * 8);
  });
  it('a unit switch swaps the membership role, keeps the shared Unit Leader role for a commander, and the next run is silent', async () => {
    const h = await world(); h.discord.give('A', 'd1'); h.game.profiles.set('p1', inUnit('mu1', 'commander')); await run(h); expect(held(h)).toEqual([UR.a, LEADER].sort());
    h.discord.calls.length = 0; h.game.profiles.set('p1', inUnit('mu2', 'commander')); await run(h); expect(held(h)).toEqual([UR.b, LEADER].sort()); expect(h.discord.calls.sort()).toEqual([`+d1:${UR.b}`, `-d1:${UR.a}`].sort());
    h.discord.calls.length = 0; await run(h); expect(h.discord.calls).toEqual([]);
    h.game.profiles.set('p1', inUnit(null)); await run(h); expect(held(h)).toEqual([]);
  });
  it('the Unit Owner role is separate: an owner outside any unit holds only the owner role; a member who is not owner never does', async () => {
    const h = await world(); h.game.units = { status: 'ok', data: [unit('mu1', 'p1'), unit('mu2'), unit('mu3')] }; h.discord.give('A', 'd1'); h.game.profiles.set('p1', inUnit(null)); await run(h); expect(held(h)).toEqual([OWNER]);
    h.game.units = { status: 'ok', data: [unit('mu1'), unit('mu2'), unit('mu3')] }; h.game.profiles.set('p1', inUnit('mu3')); await run(h); expect(held(h)).toEqual([UR.c]);
  });
});

describe('one role per family when the data is ambiguous', () => {
  it('two DIFFERENT roles configured for the same party (legacy data): none is granted, nothing is removed, the conflict is reported', async () => {
    const h = await world(); await h.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','party_member','pa','400099')`);   // bypasses the writer that now refuses this
    h.game.profiles.set('p1', inParty('pa')); h.discord.give('A', 'd1'); const r = await run(h);
    expect(held(h)).toEqual([]); expect(r.notes).toContain('membership_conflict:party'); expect(r.skipped.map((s) => s.why)).toContain('membership_conflict');
    h.discord.give('A', 'd1', PR.a, '400099'); await run(h); expect(held(h)).toEqual([PR.a, '400099'].sort());                         // already held: left alone, never removed
    h.game.profiles.set('p1', inParty('pb')); await run(h); expect(held(h)).toEqual([PR.b]);                                           // a different party: the pa roles are removed, pb's role granted
  });
  it('the SAME Discord role mapped twice for one party is not a conflict (one distinct role); dedicated party servers keep their own mappings untouched', async () => {
    const h = await world(); await h.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','party_member','pa',$1)`, [PR.a]);
    h.game.profiles.set('p1', inParty('pa')); h.discord.give('A', 'd1'); const r = await run(h); expect(held(h)).toEqual([PR.a]); expect(r.notes).toBeUndefined();
    const d = await setup(); const game = new Game(); (d as { game: FakeGame }).game = game;
    await updateGuildSettings(d.db, 'A', { community_type: 'party', party_id: 'pt', modules: { government: false, party: true, unit: false, alliance: false, ranks: false } }, null);
    await map(d.db, 'A', 'party_member', '400031'); await addRoleMapping(d.db, { guildId: 'A', kind: 'party_member', discordRoleId: '400032', actor: null });         // two roles for the dedicated party, as before
    await link(d.db, 'A', 'd1', 'p1'); d.discord.give('A', 'd1'); game.profiles.set('p1', profileOf('p1', { party: { id: 'pt', name: 'pt', role: 'member' } }));
    const r2 = await syncOneUser({ db: d.db, game, discord: d.discord }, 'A', 'd1'); if ('error' in r2) throw new Error(r2.error);
    expect([...d.discord.has('A', 'd1')].sort()).toEqual(['400031', '400032']); expect(r2.notes).toBeUndefined();
  });
});

/** Overlapping transactions need a real server: PGlite is a single in-process connection and answers BUSY. */
const REAL_PG = !!process.env['TEST_DATABASE_URL'];
describe('membership changing while the sync runs', () => {
  it('a membership change is about to be written: the profile is re-read once; if it changed the plan is recomputed from the fresh data', async () => {
    const h = await world(); h.discord.give('A', 'd1'); h.game.script = [inParty('pa'), inParty('pb')];       // read 1: pa, read 2 (before writing): pb
    const r = await run(h);
    expect(h.game.requests.profile).toBe(2); expect(r.rechecked).toBe(true); expect(h.discord.calls).toEqual([`+d1:${PR.b}`]);      // pa's role was never granted
    expect(held(h)).toEqual([PR.b]);
  });
  it('the re-read agrees: same plan, one extra request, and only because a membership change was planned; no change planned = no extra request', async () => {
    const h = await world(); h.discord.give('A', 'd1'); h.game.profiles.set('p1', inParty('pa')); const r = await run(h);
    expect(h.game.requests.profile).toBe(2); expect(r.rechecked).toBeUndefined(); expect(held(h)).toEqual([PR.a]);
    h.game.requests.profile = 0; await run(h); expect(h.game.requests.profile).toBe(1);                         // converged: no re-check
  });
  it('a failed re-read never blocks or reverses the decision (the first successful read stands); the result is reported as partial', async () => {
    const h = await world(); h.discord.give('A', 'd1'); h.game.script = [inParty('pa'), { status: 'error', message: 'down' }];
    const r = await run(h); expect(held(h)).toEqual([PR.a]); expect(r.lookups['profile_recheck']).toBe('error'); expect(r.outcome).toBe('updated');
  });
  it.runIf(REAL_PG)('two overlapping syncs of one member while the player switches party converge (real PostgreSQL), and the member never holds two party roles at any moment', async () => {
    const h = await world(); h.discord.give('A', 'd1', PR.a); let max = 0;
    const origAdd = h.discord.addRole.bind(h.discord); h.discord.addRole = async (g: string, u: string, r: string) => { await origAdd(g, u, r); max = Math.max(max, held(h).filter((x) => (Object.values(PR) as string[]).includes(x)).length); };
    h.game.script = [inParty('pa'), inParty('pb'), inParty('pb')];
    await Promise.all([run(h), run(h)]); await run(h);
    expect(held(h)).toEqual([PR.b]); expect(max).toBeLessThanOrEqual(2);                                      // the removal of the old role is planned before the addition: at most the transient pair of one swap
    h.discord.calls.length = 0; await run(h); expect(h.discord.calls).toEqual([]);
  });
});
