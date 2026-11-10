import { describe, expect, it } from 'vitest';
import { ENTITY_BY_TYPE, KINDS_BY_TYPE, allowedKinds, allowedModules, disallowedEnabledModules, incompatibleMappings, isKindAllowed } from '../src/community.js';

describe('server-type rules', () => {
  it('country: government + citizen + generic party/unit roles; no game-defined party roles', () => {
    for (const k of ['president', 'vice_president', 'minister_economy', 'minister_defense', 'minister_foreign', 'congress', 'citizen', 'party_member', 'party_leader', 'unit_member', 'unit_leader']) expect(isKindAllowed('country', k), k).toBe(true);
    expect(isKindAllowed('country', 'party_role')).toBe(false);
  });
  it('party servers expose only party roles; unit servers only unit roles (no country government in either)', () => {
    expect([...allowedKinds('party')].sort()).toEqual(['party_leader', 'party_member', 'party_role']);
    expect([...allowedKinds('military_unit')].sort()).toEqual(['unit_leader', 'unit_member']);
    for (const k of ['president', 'citizen', 'congress', 'unit_member']) expect(isKindAllowed('party', k)).toBe(false);
    for (const k of ['president', 'citizen', 'party_member']) expect(isKindAllowed('military_unit', k)).toBe(false);
  });
  it('alliance kinds are never allowed for any type, and an unknown / legacy type allows nothing new', () => {
    for (const t of Object.keys(KINDS_BY_TYPE)) { expect(isKindAllowed(t, 'alliance_member')).toBe(false); expect(isKindAllowed(t, 'alliance_leader')).toBe(false); }
    expect(allowedKinds('alliance')).toEqual([]); expect(allowedModules('alliance')).toEqual([]);
  });
  it('incompatibleMappings lists exactly what the new type does not support and never lists legacy alliance mappings', () => {
    const ms = [{ id: 1, kind: 'president' }, { id: 2, kind: 'citizen' }, { id: 3, kind: 'party_member' }, { id: 4, kind: 'unit_leader' }, { id: 5, kind: 'alliance_member' }, { id: 6, kind: 'party_role' }];
    expect(incompatibleMappings('party', ms).map((m) => m.id)).toEqual([1, 2, 4]);
    expect(incompatibleMappings('military_unit', ms).map((m) => m.id)).toEqual([1, 2, 3, 6]);
    expect(incompatibleMappings('country', ms).map((m) => m.id)).toEqual([6]);
    expect(incompatibleMappings('general', ms)).toEqual([]);
    expect(incompatibleMappings('alliance', ms)).toEqual([]);                          // legacy type: nothing is ever proposed for removal
  });
  it('modules: party offers party+ranks, unit offers unit+ranks; enabled-but-unavailable modules are reported', () => {
    expect([...allowedModules('party')]).toEqual(['party', 'ranks']); expect([...allowedModules('military_unit')]).toEqual(['unit', 'ranks']);
    expect(disallowedEnabledModules('party', { government: true, party: true, unit: true, ranks: true })).toEqual(['government', 'unit']);
    expect(disallowedEnabledModules('country', { government: true, party: true, unit: true, ranks: true })).toEqual([]);
  });
  it('each type maps to the entity the setup page must ask for', () => { expect(ENTITY_BY_TYPE).toEqual({ general: null, country: 'country', party: 'party', military_unit: 'unit' }); });
});
