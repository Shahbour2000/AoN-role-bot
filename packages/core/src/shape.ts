/**
 * Describes the SHAPE of an API response (key paths and value types) so the project can find out which fields the game really exposes.
 * Used by the read-only "API data probe" (dashboard Diagnostics). It never copies values, with one narrow exception: numbers / booleans (and
 * short strings inside a `skill…` subtree) under keys that look skill-related, because skill levels are exactly the evidence being looked for.
 * Every other string (names, bio, ids, urls, dates) is reported as the type `string` only. Pure and deterministic.
 */
export interface ShapeEntry { path: string; type: string }
export interface SkillHint { path: string; value: number | boolean | string }
export interface ShapeReport { entries: ShapeEntry[]; skillHints: SkillHint[]; /** true when some key path contains "skill" (case-insensitive). */ skillKeysPresent: boolean; truncated: boolean }

/** Exact key names that can carry skill / build evidence (compared case-insensitively, whole key). */
const HINT_KEY = /^(skills?|skillpoints?|points?|availablepoints?|spentpoints?|usedpoints?|energy|stamina|hunger|attack|criticalchance|criticaldamages?|armor|precision|dodge|health|lootchance|production|entrepreneurship|management|companies|level|maxlevel|code)$/i;
const SKILL_SEGMENT = /skill/i;

export function describeShape(root: unknown, opts: { maxDepth?: number; maxEntries?: number; maxHints?: number } = {}): ShapeReport {
  const maxDepth = opts.maxDepth ?? 6, maxEntries = opts.maxEntries ?? 400, maxHints = opts.maxHints ?? 120;
  const report: ShapeReport = { entries: [], skillHints: [], skillKeysPresent: false, truncated: false };
  const typeOf = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? 'object' : typeof v;
  const walk = (v: unknown, path: string, depth: number, inSkill: boolean, hintKey: boolean): void => {
    if (report.entries.length >= maxEntries) { report.truncated = true; return; }
    if (path) report.entries.push({ path, type: typeOf(v) });
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') { if (hintKey && report.skillHints.length < maxHints) report.skillHints.push({ path, value: v }); return; }
    if (typeof v === 'string') { if (inSkill && hintKey && v.length <= 40 && report.skillHints.length < maxHints) report.skillHints.push({ path, value: v }); return; }
    if (v === null || typeof v !== 'object') return;
    if (depth >= maxDepth) { report.truncated = true; return; }
    if (Array.isArray(v)) {
      // the first element defines the shape; skill-looking arrays are listed element by element (bounded) so the levels become visible
      const limit = inSkill || SKILL_SEGMENT.test(path) ? Math.min(v.length, 30) : Math.min(v.length, 1);
      for (let i = 0; i < limit; i++) walk(v[i], `${path}[${inSkill || SKILL_SEGMENT.test(path) ? i : ''}]`, depth + 1, inSkill || SKILL_SEGMENT.test(path), true);
      return;
    }
    for (const key of Object.keys(v as object).sort()) {
      if (SKILL_SEGMENT.test(key)) report.skillKeysPresent = true;
      const child = (v as Record<string, unknown>)[key];
      walk(child, path ? `${path}.${key}` : key, depth + 1, inSkill || SKILL_SEGMENT.test(key), HINT_KEY.test(key) || inSkill);
    }
  };
  walk(root, '', 0, false, false);
  return report;
}
