import { describe, expect, it } from 'vitest';
import { BUILD_THRESHOLDS, ECO_SKILLS, SUPPORT_SKILLS, WAR_SKILLS, classifyBuild } from '../src/index.js';

/** Builds a full skills array: every war skill at `war`% and every eco skill at `eco`% of maxLevel 100 (plus supporting skills at 100%). */
const skills = (war: number, eco: number, extra: { code: string; level: number; maxLevel: number }[] = []) => [
  ...WAR_SKILLS.map((code) => ({ code, level: war, maxLevel: 100 })), ...ECO_SKILLS.map((code) => ({ code, level: eco, maxLevel: 100 })),
  ...SUPPORT_SKILLS.map((code) => ({ code, level: 100, maxLevel: 100 })), ...extra,
];
const kind = (w: number, e: number) => classifyBuild(skills(w, e)).kind;

describe('classification rules', () => {
  it('documents the provisional skill groups and the proposed thresholds', () => {
    expect([...WAR_SKILLS]).toHaveLength(8); expect([...ECO_SKILLS]).toHaveLength(4);
    expect(BUILD_THRESHOLDS).toEqual({ primaryMin: 60, primaryLead: 15, hybridMin: 50, hybridGap: 15 });
  });
  it.each([
    [80, 20, 'war'], [20, 80, 'eco'], [70, 65, 'hybrid'], [10, 10, 'unclassified'], [55, 20, 'unclassified'], [100, 100, 'hybrid'],
  ])('war %i / eco %i => %s', (w, e, k) => expect(kind(w, e)).toBe(k));
  it('boundaries: war needs ≥ 60 AND a lead of ≥ 15; exactly 60/45 is War', () => {
    expect(kind(60, 45)).toBe('war'); expect(kind(60, 46)).toBe('unclassified'); expect(kind(75, 60)).toBe('war');
    expect(kind(74, 60)).toBe('hybrid'); expect(kind(59, 20)).toBe('unclassified');
  });
  it('boundaries: eco mirrors war', () => { expect(kind(45, 60)).toBe('eco'); expect(kind(46, 60)).toBe('unclassified'); expect(kind(60, 74)).toBe('hybrid'); expect(kind(60, 75)).toBe('eco'); });
  it('boundaries: hybrid needs both ≥ 50 and a gap < 15 (a gap of exactly 15 qualifies as a primary build, never hybrid)', () => {
    expect(kind(50, 50)).toBe('hybrid'); expect(kind(49, 49)).toBe('unclassified'); expect(kind(50, 49)).toBe('unclassified');
    expect(kind(65, 50)).toBe('war'); expect(kind(50, 65)).toBe('eco'); expect(kind(64, 50)).toBe('hybrid'); expect(kind(50, 64)).toBe('hybrid');
  });
  it('equal scores are hybrid when both ≥ 50, otherwise unclassified', () => { expect(kind(70, 70)).toBe('hybrid'); expect(kind(40, 40)).toBe('unclassified'); });
  it('the outcomes are mutually exclusive over a dense grid', () => {
    for (let w = 0; w <= 100; w += 5) for (let e = 0; e <= 100; e += 5) {
      const k = kind(w, e); const war = w >= 60 && w - e >= 15, eco = e >= 60 && e - w >= 15, hyb = w >= 50 && e >= 50 && Math.abs(w - e) < 15;
      expect([war, eco, hyb].filter(Boolean).length).toBeLessThanOrEqual(1);
      expect(k).toBe(war ? 'war' : eco ? 'eco' : hyb ? 'hybrid' : 'unclassified');
    }
  });
  it('float artefacts do not move a boundary', () => {
    const w = WAR_SKILLS.map((code) => ({ code, level: 3, maxLevel: 5 })); const e = ECO_SKILLS.map((code) => ({ code, level: 9, maxLevel: 20 }));
    expect(classifyBuild([...w, ...e])).toMatchObject({ kind: 'war', warScore: 60, ecoScore: 45 });
  });
});

describe('normalisation and invalid data', () => {
  it('scores are means of level/maxLevel·100 per group (different max levels)', () => {
    const r = classifyBuild([...WAR_SKILLS.map((code, i) => ({ code, level: i % 2 ? 10 : 5, maxLevel: 10 })), ...ECO_SKILLS.map((code) => ({ code, level: 1, maxLevel: 4 }))]);
    expect(r.warScore).toBe(75); expect(r.ecoScore).toBe(25); expect(r.kind).toBe('war'); expect([r.warSkills, r.ecoSkills]).toEqual([8, 4]);
  });
  it('supporting skills (energy, stamina, hunger) and unknown skills never affect the score', () => {
    const base = classifyBuild(skills(80, 20)); const noisy = classifyBuild(skills(80, 20, [{ code: 'mystery', level: 0, maxLevel: 100 }, { code: 'energy', level: 0, maxLevel: 100 }]));
    expect(noisy).toEqual(base);
  });
  it('zero maximum, negative, impossible, non-numeric and missing values are excluded (no division by zero)', () => {
    const bad: unknown[] = [{ code: 'attack', level: 5, maxLevel: 0 }, { code: 'armor', level: -1, maxLevel: 10 }, { code: 'dodge', level: 11, maxLevel: 10 }, { code: 'health', level: '5', maxLevel: 10 },
      { code: 'precision', level: NaN, maxLevel: 10 }, { code: 'lootChance', maxLevel: 10 }, null, 'x', 5, { level: 1, maxLevel: 2 }];
    const r = classifyBuild([...bad, ...ECO_SKILLS.map((code) => ({ code, level: 1, maxLevel: 4 }))]);
    expect(r.warSkills).toBe(0); expect(r.kind).toBe('insufficient'); expect(r.warScore).toBeNull();
  });
  it('a skill listed twice is ambiguous and excluded', () => {
    const r = classifyBuild([...skills(80, 20), { code: 'attack', level: 0, maxLevel: 100 }]); expect(r.warSkills).toBe(7); expect(r.kind).toBe('war');
  });
  it('insufficient data is never forced into a build: needs ≥ 4 war and ≥ 2 eco skills', () => {
    expect(classifyBuild(skills(90, 10).filter((s) => !['attack', 'armor', 'dodge', 'health', 'precision'].includes(s.code))).kind).toBe('insufficient');
    expect(classifyBuild(skills(90, 10).filter((s) => !['production', 'entrepreneurship', 'companies'].includes(s.code))).kind).toBe('insufficient');
    expect(classifyBuild(skills(90, 10).filter((s) => !['attack', 'armor', 'dodge', 'health'].includes(s.code))).kind).toBe('war');
  });
  it('missing / malformed skills arrays are insufficient with null scores', () => {
    for (const s of [undefined, null, [], {}, 'skills', 7]) expect(classifyBuild(s)).toEqual({ kind: 'insufficient', warScore: null, ecoScore: null, warSkills: 0, ecoSkills: 0 });
  });
  it('is deterministic, does not mutate its input, and ignores everything except skills (damage, rank…)', () => {
    const input = skills(80, 20); const copy = JSON.stringify(input);
    expect(classifyBuild(input)).toEqual(classifyBuild(input)); expect(JSON.stringify(input)).toBe(copy);
    expect(classifyBuild(skills(80, 20).map((s) => ({ ...s, damage: 9e9, rank: 'general' })))).toEqual(classifyBuild(input));
  });
});
