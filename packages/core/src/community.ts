/**
 * Which role kinds and modules each server type may use. ONE table, used by the web API (validation, type-change checks)
 * and the database layer (atomic removal on a confirmed type change); the dashboard receives the result from the API.
 *
 * Rules (original brief):
 *  - country: government offices + citizen, plus the generic party / unit roles
 *  - party:   party leader, party member and game-defined party roles (treasurer, council, ... as the game reports them)
 *  - military_unit: unit leader and unit member
 *  - general: everything except alliance (no verified alliance data exists)
 * Alliance is NOT a configurable type. Legacy `alliance_*` mappings and a legacy `alliance` type are never offered, never validated against
 * and never removed by a type change: they stay dormant in the database.
 */
export const COMMUNITY_TYPES = ['general', 'country', 'party', 'military_unit'] as const;
export type CommunityType = (typeof COMMUNITY_TYPES)[number];
export const MODULE_KEYS = ['government', 'party', 'unit', 'ranks'] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

const GOVERNMENT = ['president', 'vice_president', 'minister_defense', 'minister_foreign', 'minister_economy', 'congress', 'government_role'] as const;
export const KINDS_BY_TYPE: Readonly<Record<CommunityType, readonly string[]>> = {
  general: [...GOVERNMENT, 'citizen', 'party_member', 'party_leader', 'party_role', 'unit_member', 'unit_leader'],
  country: [...GOVERNMENT, 'citizen', 'party_member', 'party_leader', 'unit_member', 'unit_leader'],
  party: ['party_leader', 'party_member', 'party_role'],
  military_unit: ['unit_leader', 'unit_member'],
};
export const MODULES_BY_TYPE: Readonly<Record<CommunityType, readonly ModuleKey[]>> = {
  general: ['government', 'party', 'unit', 'ranks'],
  country: ['government', 'party', 'unit', 'ranks'],
  party: ['party', 'ranks'],
  military_unit: ['unit', 'ranks'],
};
/** Entity the server is configured for (what the setup page asks for). `general` has none. */
export const ENTITY_BY_TYPE: Readonly<Record<CommunityType, 'country' | 'party' | 'unit' | null>> = { general: null, country: 'country', party: 'party', military_unit: 'unit' };

export const isConfigurableType = (t: string): t is CommunityType => (COMMUNITY_TYPES as readonly string[]).includes(t);
const isLegacyAlliance = (kind: string) => kind.startsWith('alliance_');

/** Kinds a server of this type may map. Unknown/legacy types (e.g. a stored `alliance`) allow nothing new. */
export function allowedKinds(type: string): readonly string[] { return isConfigurableType(type) ? KINDS_BY_TYPE[type] : []; }
export function allowedModules(type: string): readonly ModuleKey[] { return isConfigurableType(type) ? MODULES_BY_TYPE[type] : []; }
export const isKindAllowed = (type: string, kind: string): boolean => allowedKinds(type).includes(kind);

/** Mappings that do not apply to `type`. Legacy alliance mappings are excluded on purpose (preserved, never offered for removal). */
export function incompatibleMappings<T extends { kind: string }>(type: string, mappings: readonly T[]): T[] {
  if (!isConfigurableType(type)) return [];
  return mappings.filter((m) => !isLegacyAlliance(m.kind) && !KINDS_BY_TYPE[type].includes(m.kind));
}

/** Modules switched on that the type does not offer. Returned so the caller can tell the user; they are never dropped silently. */
export function disallowedEnabledModules(type: string, modules: Partial<Record<string, boolean>>): ModuleKey[] {
  if (!isConfigurableType(type)) return [];
  return MODULE_KEYS.filter((k) => modules[k] === true && !MODULES_BY_TYPE[type].includes(k));
}
