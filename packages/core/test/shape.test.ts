import { describe, expect, it } from 'vitest';
import { describeShape } from '../src/shape.js';

describe('describeShape (API data probe)', () => {
  const profile = { id: 'usr_secret1', username: 'RealName', bio: 'private bio text', joinedAt: '2026-10-09T12:35:02.095Z', level: 17, xp: 8284, premium: false,
    party: { id: 'p1', name: 'My Party', role: 'leader' }, militaryUnit: null, offices: ['congress'], damage: { total: '649601' } };
  it('reports key paths and types, and NEVER copies strings (names, bio, ids, dates)', () => {
    const r = describeShape(profile); const text = JSON.stringify(r);
    for (const secret of ['usr_secret1', 'RealName', 'private bio text', '2026-10-09', 'My Party', '649601']) expect(text).not.toContain(secret);
    expect(r.entries).toContainEqual({ path: 'level', type: 'number' }); expect(r.entries).toContainEqual({ path: 'party.role', type: 'string' }); expect(r.entries).toContainEqual({ path: 'militaryUnit', type: 'null' });
    expect(r.entries).toContainEqual({ path: 'offices', type: 'array(1)' }); expect(r.skillKeysPresent).toBe(false); expect(r.truncated).toBe(false);
  });
  it('shows skill evidence: numbers under skill-looking keys, and per-element code/level inside a skills array', () => {
    const r = describeShape({ ...profile, skillPoints: 112, skills: [{ code: 'attack', level: 5, maxLevel: 10, label: 'Attack power' }, { code: 'production', level: 3, maxLevel: 10 }] });
    expect(r.skillKeysPresent).toBe(true);
    expect(r.skillHints).toContainEqual({ path: 'skillPoints', value: 112 });
    expect(r.skillHints).toContainEqual({ path: 'skills[0].code', value: 'attack' }); expect(r.skillHints).toContainEqual({ path: 'skills[0].level', value: 5 }); expect(r.skillHints).toContainEqual({ path: 'skills[1].maxLevel', value: 10 });
    expect(r.entries.some((e) => e.path === 'skills[1].code')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('private bio text');
  });
  it('level and level-like numbers elsewhere are only shown as hints when the key name matches; strings outside skills never are', () => {
    const r = describeShape({ level: 29, rank: { code: 'lieutenant', minDamage: 400000 } });
    expect(r.skillHints).toContainEqual({ path: 'level', value: 29 }); expect(JSON.stringify(r)).not.toContain('lieutenant'); expect(r.skillHints.some((h) => h.path === 'rank.minDamage')).toBe(false);
  });
  it('is bounded and total: depth / entry caps set `truncated`; null, primitives, empty and weird input never throw; deterministic', () => {
    let deep: unknown = 1; for (let i = 0; i < 20; i++) deep = { a: deep }; expect(describeShape(deep).truncated).toBe(true);
    const wide: Record<string, number> = {}; for (let i = 0; i < 600; i++) wide[`k${i}`] = i; const w = describeShape(wide, { maxEntries: 50 }); expect(w.entries.length).toBe(50); expect(w.truncated).toBe(true);
    for (const v of [null, undefined, 5, 'x', true, [], {}, [[]], [null]]) expect(() => describeShape(v)).not.toThrow();
    expect(JSON.stringify(describeShape(profile))).toBe(JSON.stringify(describeShape({ ...profile })));
  });
});
