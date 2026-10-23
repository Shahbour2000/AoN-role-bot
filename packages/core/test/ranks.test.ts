import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKS, computeRank, decideRankAction, parseDamage, validateLadder, type RankDefinition } from '../src/index.js';

/** Thresholds exactly as given by the project owner (starter configuration, 17 ranks). */
const HANDOFF: [string, number][] = [
  ['عسكري', 10_000], ['عريف', 50_000], ['رقيب', 100_000], ['رقيب أول', 200_000], ['مساعد', 400_000],
  ['مساعد أول', 700_000], ['ملازم', 1_000_000], ['ملازم أول', 2_500_000], ['نقيب', 5_000_000], ['رائد', 10_000_000],
  ['مقدم', 20_000_000], ['عقيد', 35_000_000], ['عميد', 60_000_000], ['لواء', 90_000_000], ['فريق', 130_000_000],
  ['فريق أول', 180_000_000], ['مشير', 250_000_000],
];
const keyOf = (d: unknown, ladder: readonly RankDefinition[] = DEFAULT_RANKS) => {
  const r = computeRank(d, ladder);
  return r.status === 'ranked' ? r.rank.key : r.status;
};
const edit = (key: string, patch: Partial<RankDefinition>): RankDefinition[] => DEFAULT_RANKS.map((r) => (r.key === key ? { ...r, ...patch } : { ...r }));

describe('default starter ladder (17 ranks as specified by the owner)', () => {
  it('is valid and matches the owner\'s table exactly (Arabic names + thresholds)', () => {
    expect(validateLadder(DEFAULT_RANKS)).toEqual({ ok: true });
    expect(DEFAULT_RANKS).toHaveLength(17);
    expect(DEFAULT_RANKS.map((r) => [r.nameAr, r.minDamage])).toEqual(HANDOFF);
    expect(DEFAULT_RANKS.map((r) => r.order)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });
  it('every default has both language names, a stable key, no role mapped yet, and is enabled', () => {
    for (const r of DEFAULT_RANKS) { expect(r.nameEn).toBeTruthy(); expect(r.key).toMatch(/^[a-z][a-z0-9_]*$/); expect(r.discordRoleId).toBeNull(); expect(r.enabled).toBe(true); }
    expect(new Set(DEFAULT_RANKS.map((r) => r.key)).size).toBe(17);
  });
});

describe('computeRank boundaries', () => {
  it('below the first threshold means no military rank', () => {
    for (const d of [0, 1, 9_999]) expect(keyOf(d)).toBe('unranked');
  });
  it.each(DEFAULT_RANKS.map((r, i) => [r.key, r.minDamage, DEFAULT_RANKS[i - 1]?.key ?? 'unranked'] as const))(
    '%s: exactly at %i qualifies; one below falls to %s', (key, min, prev) => {
      expect(keyOf(min)).toBe(key);
      expect(keyOf(min - 1)).toBe(prev);
    });
  it('between thresholds returns the lower rank', () => {
    expect(keyOf(49_999)).toBe('soldier');
    expect(keyOf(25_000)).toBe('soldier');                     // the old 'private first class' threshold no longer starts a rank
    expect(keyOf(1_999_999)).toBe('lieutenant');
    expect(keyOf(3_000_000)).toBe('first_lieutenant');
    expect(keyOf(249_999_999)).toBe('general');
  });
  it('250,000,000 and above is the top rank', () => {
    expect(keyOf(250_000_000)).toBe('field_marshal');
    expect(keyOf(9_000_000_000)).toBe('field_marshal');
  });
  it('REAL SAMPLE: lifetime damage "649601" => warrant_officer (the game-native "lieutenant" rank is irrelevant)', () => {
    expect(keyOf('649601')).toBe('warrant_officer');
  });
  it('accepts numeric strings (as the API returns) and bigint', () => {
    expect(keyOf('2500000')).toBe('first_lieutenant');
    expect(keyOf(2_500_000n)).toBe('first_lieutenant');
  });
  it('failed or incomplete data is unknown, never zero', () => {
    for (const bad of [undefined, null, '', 'abc', '1,000', NaN, Infinity, -5, {}, []]) expect(keyOf(bad)).toBe('unknown');
  });
  it('a disabled rank is skipped entirely (the next lower enabled rank wins)', () => {
    expect(keyOf(5_000_000, edit('captain', { enabled: false }))).toBe('first_lieutenant');
  });
});

describe('customisable ladders (nothing depends on 18)', () => {
  const three: RankDefinition[] = [
    { key: 'a', order: 1, nameAr: 'أ', nameEn: 'A', minDamage: 1, discordRoleId: null, enabled: true },
    { key: 'b', order: 2, nameAr: 'ب', nameEn: 'B', minDamage: 100, discordRoleId: null, enabled: true },
    { key: 'c', order: 3, nameAr: 'ج', nameEn: 'C', minDamage: 1000, discordRoleId: null, enabled: true },
  ];
  it('a 3-rank ladder, a 30-rank ladder, and a ladder with ranks removed all validate and match', () => {
    expect(validateLadder(three).ok).toBe(true);
    expect(keyOf(150, three)).toBe('b');
    const many = Array.from({ length: 30 }, (_, i): RankDefinition => ({ key: `r${i + 1}`, order: i + 1, nameAr: `ر${i}`, nameEn: `R${i}`, minDamage: (i + 1) * 1000, discordRoleId: null, enabled: true }));
    expect(validateLadder(many).ok).toBe(true);
    expect(keyOf(30_000, many)).toBe('r30');
    expect(validateLadder(DEFAULT_RANKS.filter((r) => r.key !== 'corporal')).ok).toBe(true);
  });
  it('an admin can rename a rank and change its threshold', () => {
    const l = edit('captain', { nameAr: 'نقيب ركن', nameEn: 'Staff Captain', minDamage: 6_000_000 });
    expect(validateLadder(l).ok).toBe(true);
    expect(keyOf(5_999_999, l)).toBe('first_lieutenant');
    expect(keyOf(6_000_000, l)).toBe('captain');
  });
});

describe('validateLadder', () => {
  it('rejects a higher rank with a lower threshold (Lt Colonel below Captain)', () => {
    const res = validateLadder(edit('lieutenant_colonel', { minDamage: 4_000_000 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.code === 'THRESHOLD_NOT_INCREASING' && i.rankKey === 'lieutenant_colonel')).toBe(true);
  });
  it('rejects equal thresholds (ambiguous) by default, allows them only when opted in', () => {
    const equal = edit('major', { minDamage: 5_000_000 });
    expect(validateLadder(equal).ok).toBe(false);
    expect(validateLadder(equal, { allowEqualThresholds: true }).ok).toBe(true);
  });
  it('rejects non-integers, negatives and zero', () => {
    expect(validateLadder(edit('captain', { minDamage: 5.5 })).ok).toBe(false);
    expect(validateLadder(edit('soldier', { minDamage: -1 })).ok).toBe(false);
    expect(validateLadder(edit('soldier', { minDamage: 0 })).ok).toBe(false);
  });
  it('rejects duplicate order, duplicate key, empty ladder, bad keys and missing names', () => {
    expect(validateLadder(DEFAULT_RANKS.map((r) => (r.key === 'major' ? { ...r, order: 3 } : { ...r }))).ok).toBe(false);
    expect(validateLadder(DEFAULT_RANKS.map((r) => (r.key === 'major' ? { ...r, key: 'captain' } : { ...r }))).ok).toBe(false);
    expect(validateLadder([]).ok).toBe(false);
    expect(validateLadder(edit('major', { key: 'Bad Key!' })).ok).toBe(false);
    expect(validateLadder(edit('major', { nameAr: '  ' })).ok).toBe(false);
  });
  it('rejects the same Discord role mapped to two ranks', () => {
    const l = DEFAULT_RANKS.map((r) => (r.order <= 2 ? { ...r, discordRoleId: '111111' } : { ...r }));
    const res = validateLadder(l);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.code)).toContain('DUPLICATE_ROLE');
  });
  it('ordering is checked among ENABLED ranks only (a disabled rank may sit out of order)', () => {
    expect(validateLadder(edit('captain', { minDamage: 1, enabled: false })).ok).toBe(true);
    expect(validateLadder(edit('captain', { minDamage: 1 })).ok).toBe(false);
  });
  it('validates by explicit order, not by array position', () => {
    const shuffled = [...DEFAULT_RANKS].reverse();
    expect(validateLadder(shuffled).ok).toBe(true);
    expect(keyOf(10_000_000, shuffled)).toBe('major');
  });
});

describe('parseDamage', () => {
  it('floors fractional damage and rejects negatives', () => {
    expect(parseDamage('10.9')).toEqual({ ok: true, value: 10 });
    expect(parseDamage(-1)).toEqual({ ok: false, reason: 'negative' });
  });
});

describe('decideRankAction / demotion policy', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const lower = computeRank(300_000, DEFAULT_RANKS); // sergeant_first_class (order 4)
  it('promotes automatically', () => {
    expect(decideRankAction({ currentOrder: 1, computed: lower, policy: { mode: 'never' }, now })).toEqual({ action: 'set', targetOrder: 4, reason: 'promotion' });
  });
  it('grants initial rank', () => {
    expect(decideRankAction({ currentOrder: null, computed: lower, policy: { mode: 'never' }, now })).toMatchObject({ action: 'set', reason: 'initial' });
  });
  it('never mode keeps the higher rank', () => {
    expect(decideRankAction({ currentOrder: 8, computed: lower, policy: { mode: 'never' }, now })).toEqual({ action: 'keep', reason: 'demotion_disabled' });
  });
  it('immediate mode demotes', () => {
    expect(decideRankAction({ currentOrder: 8, computed: lower, policy: { mode: 'immediate' }, now })).toMatchObject({ action: 'set', reason: 'demotion', targetOrder: 4 });
  });
  it('grace mode waits, then demotes', () => {
    const policy = { mode: 'grace', graceDays: 7 } as const;
    expect(decideRankAction({ currentOrder: 8, computed: lower, policy, belowSince: new Date('2026-10-15T00:00:00Z'), now })).toEqual({ action: 'keep', reason: 'in_grace_period' });
    expect(decideRankAction({ currentOrder: 8, computed: lower, policy, belowSince: new Date('2026-10-01T00:00:00Z'), now })).toMatchObject({ action: 'set', reason: 'demotion' });
  });
  it('untrusted data never changes anything, even under immediate demotion', () => {
    expect(decideRankAction({ currentOrder: 9, computed: computeRank(undefined, DEFAULT_RANKS), policy: { mode: 'immediate' }, now })).toEqual({ action: 'keep', reason: 'untrusted_data' });
  });
});
