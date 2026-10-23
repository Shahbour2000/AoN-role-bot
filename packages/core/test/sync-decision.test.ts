import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKS, evaluateRankRules, planRoleChanges, type Fetched, type RankDefinition } from '../src/index.js';

const now = new Date('2026-10-17T00:00:00Z');
const withRoles = (over: (r: RankDefinition) => Partial<RankDefinition> = () => ({})): RankDefinition[] =>
  DEFAULT_RANKS.map((r) => ({ ...r, discordRoleId: `R${r.order}`, ...over(r) }));
const ladder = withRoles();
const managed = new Set(ladder.map((r) => r.discordRoleId!));
const allAssignable = new Set(managed);

const run = (damage: Fetched<unknown>, current: string[], opts: { assignable?: Set<string>; policy?: 'never' | 'immediate'; ladder?: RankDefinition[] } = {}) => {
  const currentOrder = current.length ? Math.max(...current.map((c) => Number(c.slice(1)))) : null;
  const l = opts.ladder ?? ladder;
  const evaluations = evaluateRankRules({ ladder: l, damage, currentOrder, policy: { mode: opts.policy ?? 'immediate' }, now });
  return planRoleChanges({ evaluations, managedRoleIds: new Set(l.filter((r) => r.discordRoleId).map((r) => r.discordRoleId!)), currentRoleIds: new Set(current), assignableRoleIds: opts.assignable ?? allAssignable });
};

describe('failed lookups must never revoke roles', () => {
  const failures: Fetched<unknown>[] = [
    { status: 'error', message: 'HTTP 500' }, { status: 'rate_limited', retryAfterMs: 30_000 }, { status: 'not_found' }, { status: 'incomplete', missing: ['damage'] },
  ];
  it.each(failures.map((f) => [f.status, f] as const))('%s', (_n, f) => {
    const plan = run(f, ['R12']);
    expect(plan.remove).toEqual([]); expect(plan.add).toEqual([]); expect(plan.skipped.length).toBeGreaterThan(0);
  });
  it('ok response with an unusable damage value does not revoke either', () => {
    expect(run({ status: 'ok', data: undefined }, ['R12']).remove).toEqual([]);
  });
});

describe('role plan from trusted data', () => {
  it('promotes: adds the new rank and removes the old one', () => {
    const plan = run({ status: 'ok', data: 10_000_000 }, ['R7']);
    expect(plan.add).toEqual(['R10']); expect(plan.remove).toEqual(['R7']);
  });
  it('is idempotent', () => {
    expect(run({ status: 'ok', data: 10_000_000 }, ['R10'])).toMatchObject({ add: [], remove: [], skipped: [] });
  });
  it('removes the rank role when trusted damage is below the first threshold', () => {
    expect(run({ status: 'ok', data: 10 }, ['R3']).remove).toEqual(['R3']);
  });
  it('never-demote policy keeps the higher role even if damage dropped', () => {
    const plan = run({ status: 'ok', data: 300_000 }, ['R12'], { policy: 'never' });
    expect(plan.remove).toEqual([]); expect(plan.add).toEqual([]);
  });
  it('only ONE rank role stays active: stray extra rank roles are removed', () => {
    const plan = run({ status: 'ok', data: 10_000_000 }, ['R10', 'R7', 'R3']);
    expect(plan.remove.sort()).toEqual(['R3', 'R7']); expect(plan.add).toEqual([]);
  });
  it('withheld demotion keeps the higher role and skips the rest', () => {
    const plan = run({ status: 'ok', data: 300_000 }, ['R12'], { policy: 'never' });
    expect(plan.remove).toEqual([]); expect(plan.skipped.length).toBeGreaterThan(0);
  });
  it('never touches roles outside the rank group', () => {
    const evaluations = evaluateRankRules({ ladder, damage: { status: 'ok', data: 10 }, currentOrder: null, policy: { mode: 'immediate' }, now });
    const plan = planRoleChanges({ evaluations, managedRoleIds: managed, currentRoleIds: new Set(['SOMEONE_ELSES_ROLE']), assignableRoleIds: allAssignable });
    expect(plan.remove).not.toContain('SOMEONE_ELSES_ROLE');
  });
  it('reports hierarchy-blocked roles instead of attempting them', () => {
    const plan = run({ status: 'ok', data: 10_000_000 }, ['R7'], { assignable: new Set(['R7']) });
    expect(plan.add).toEqual([]); expect(plan.blocked).toEqual([{ roleId: 'R10', why: 'bot_cannot_assign_role' }]); expect(plan.remove).toEqual(['R7']);
  });
});

describe('partially configured ladders', () => {
  it('ranks without a Discord role are ignored; the others still work', () => {
    const l = withRoles((r) => (r.order === 4 ? { discordRoleId: null } : {}));
    const ev = evaluateRankRules({ ladder: l, damage: { status: 'ok', data: 10_000_000 }, currentOrder: null, policy: { mode: 'immediate' }, now });
    expect(ev.some((e) => e.roleId === 'R4')).toBe(false);
    expect(ev.find((e) => e.roleId === 'R10')?.evidence).toBe('qualifies');
  });
  it('earned rank has NO role configured: nothing changes (no neighbouring role is guessed) and the reason is reported', () => {
    const l = withRoles((r) => (r.key === 'major' ? { discordRoleId: null } : {}));
    const plan = run({ status: 'ok', data: 10_000_000 }, ['R7'], { ladder: l });
    expect(plan.add).toEqual([]); expect(plan.remove).toEqual([]);
    expect(plan.skipped.every((s) => s.why === 'rank_role_not_configured')).toBe(true);
  });
  it('a DISABLED rank is never assigned and its role is never removed', () => {
    const l = withRoles((r) => (r.key === 'captain' ? { enabled: false } : {}));
    // 5,000,000 would be captain (order 9), but it is disabled => first_lieutenant (order 8); the captain role is left alone.
    const plan = run({ status: 'ok', data: 5_000_000 }, ['R9'], { ladder: l });
    expect(plan.add).toEqual(['R8']); expect(plan.remove).toEqual([]);
    expect(plan.skipped.concat(plan.blocked).some((x) => x.roleId === 'R9')).toBe(false);
  });
});

describe('overlapping rules', () => {
  it('qualifies beats not_qualifies; unknown beats not_qualifies', () => {
    const base = { managedRoleIds: new Set(['X']), currentRoleIds: new Set(['X']), assignableRoleIds: new Set(['X']) };
    expect(planRoleChanges({ ...base, evaluations: [{ roleId: 'X', evidence: 'not_qualifies', why: 'a' }, { roleId: 'X', evidence: 'qualifies', why: 'b' }] }).remove).toEqual([]);
    expect(planRoleChanges({ ...base, evaluations: [{ roleId: 'X', evidence: 'not_qualifies', why: 'a' }, { roleId: 'X', evidence: 'unknown', why: 'b' }] }).remove).toEqual([]);
    expect(planRoleChanges({ ...base, evaluations: [{ roleId: 'X', evidence: 'not_qualifies', why: 'a' }] }).remove).toEqual(['X']);
  });
});
