/**
 * Player build classification (War / Eco / Hybrid) from the player's skill levels.
 * ONE shared, pure implementation used by the bot (sync + /profile), the dashboard API and the tests.
 *
 * INPUT: the `skills` array of `GET /players/{id}` — items `{ code, level, maxLevel }`.
 *
 * SKILL GROUPS (provisional — the project owner's candidate mapping; it is NOT an official game rule and could not be verified
 * against the game's documentation. Change the two lists below to change the classification everywhere):
 *   war : attack, criticalChance, criticalDamages, armor, precision, dodge, health, lootChance
 *   eco : production, entrepreneurship, companies, management
 *   supporting (never scored): energy, stamina, hunger
 *
 * FORMULA
 *   progress(skill) = level * 100 / maxLevel            (0..100; equal weights)
 *   warScore = mean(progress of the eligible war skills); ecoScore = mean(progress of the eligible eco skills)
 *   A skill is ELIGIBLE when: its code is in a group, level is a finite number 0 ≤ level ≤ maxLevel, maxLevel is a finite number > 0,
 *   and the code appears once in the array (a duplicated code is ambiguous, so it is excluded).
 *   SUFFICIENT DATA: at least half of each group's skills must be eligible (≥ 4 war skills and ≥ 2 eco skills), otherwise the result
 *   is `insufficient` — an uncertain build is never forced.
 *
 * RULES (checked in this order; they are mutually exclusive)
 *   war    : warScore ≥ 60 and warScore − ecoScore ≥ 15
 *   eco    : ecoScore ≥ 60 and ecoScore − warScore ≥ 15
 *   hybrid : warScore ≥ 50, ecoScore ≥ 50 and |warScore − ecoScore| < 15
 *   else   : unclassified (data is sufficient, but no build qualifies)
 * Scores are rounded to 6 decimals before comparing, so boundary values behave exactly (60 is 60).
 * Only skills decide the build: damage, rank, equipment, badges, trade and company count never override it.
 */
export const WAR_SKILLS = ['attack', 'criticalChance', 'criticalDamages', 'armor', 'precision', 'dodge', 'health', 'lootChance'] as const;
export const ECO_SKILLS = ['production', 'entrepreneurship', 'companies', 'management'] as const;
export const SUPPORT_SKILLS = ['energy', 'stamina', 'hunger'] as const;

export const BUILD_THRESHOLDS = { primaryMin: 60, primaryLead: 15, hybridMin: 50, hybridGap: 15 } as const;
export type BuildThresholds = { readonly [K in keyof typeof BUILD_THRESHOLDS]: number };

export type BuildKind = 'war' | 'eco' | 'hybrid';
export type BuildClass = BuildKind | 'unclassified' | 'insufficient';
export const BUILD_KINDS: readonly BuildKind[] = ['war', 'eco', 'hybrid'];

export interface BuildResult {
  kind: BuildClass;
  warScore: number | null;
  ecoScore: number | null;
  /** How many skills of each group were usable (for diagnostics and the dashboard). */
  warSkills: number;
  ecoSkills: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const GROUP = new Map<string, 'war' | 'eco'>([...WAR_SKILLS.map((c) => [c, 'war'] as const), ...ECO_SKILLS.map((c) => [c, 'eco'] as const)]);

export function classifyBuild(skills: unknown, th: BuildThresholds = BUILD_THRESHOLDS): BuildResult {
  const none: BuildResult = { kind: 'insufficient', warScore: null, ecoScore: null, warSkills: 0, ecoSkills: 0 };
  if (!Array.isArray(skills)) return none;

  const seen = new Map<string, number>();
  for (const s of skills) if (s && typeof s === 'object' && typeof (s as { code?: unknown }).code === 'string') seen.set((s as { code: string }).code, (seen.get((s as { code: string }).code) ?? 0) + 1);

  const sums = { war: 0, eco: 0 }; const counts = { war: 0, eco: 0 };
  for (const s of skills) {
    if (!s || typeof s !== 'object') continue;
    const { code, level, maxLevel } = s as { code?: unknown; level?: unknown; maxLevel?: unknown };
    if (typeof code !== 'string') continue;
    const group = GROUP.get(code);
    if (!group || seen.get(code) !== 1) continue;                                   // unknown/supporting skill, or ambiguous duplicate
    if (typeof level !== 'number' || typeof maxLevel !== 'number' || !Number.isFinite(level) || !Number.isFinite(maxLevel)) continue;
    if (maxLevel <= 0 || level < 0 || level > maxLevel) continue;                   // zero maximum, negative or impossible level
    sums[group] += (level * 100) / maxLevel; counts[group]++;
  }

  const need = { war: Math.ceil(WAR_SKILLS.length / 2), eco: Math.ceil(ECO_SKILLS.length / 2) };
  const base = { warSkills: counts.war, ecoSkills: counts.eco };
  if (counts.war < need.war || counts.eco < need.eco) return { ...none, ...base, warScore: counts.war ? round6(sums.war / counts.war) : null, ecoScore: counts.eco ? round6(sums.eco / counts.eco) : null };

  const war = round6(sums.war / counts.war), eco = round6(sums.eco / counts.eco);
  const kind: BuildClass =
    war >= th.primaryMin && war - eco >= th.primaryLead ? 'war'
    : eco >= th.primaryMin && eco - war >= th.primaryLead ? 'eco'
    : war >= th.hybridMin && eco >= th.hybridMin && Math.abs(war - eco) < th.hybridGap ? 'hybrid'
    : 'unclassified';
  return { kind, warScore: war, ecoScore: eco, ...base };
}
