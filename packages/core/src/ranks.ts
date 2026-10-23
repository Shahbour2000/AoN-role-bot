/**
 * Military rank engine. Pure functions only: no Discord, no database, no network.
 * Thresholds are per-guild configuration; DEFAULT_RANKS is only a seed.
 */

export interface RankDefinition {
  /** Stable identifier (never shown to users, never changes when renamed). */
  key: string;
  /** Explicit position in the ladder; 1 = lowest. Must be unique. */
  order: number;
  nameEn: string;
  nameAr: string;
  /** Minimum total damage (inclusive). */
  minDamage: number;
  /** Configured Discord role, or null if the admin has not mapped one yet. */
  discordRoleId: string | null;
  /** Disabled ranks are ignored completely: never matched, never assigned, never removed. */
  enabled: boolean;
}

/**
 * STARTER configuration (17 ranks, lifetime damage), exactly as specified by the project owner. Seeded for new guilds when they
 * enable the optional military-rank system, then fully editable per guild: add / remove / rename / re-order / re-threshold / disable /
 * map to any Discord role. Nothing depends on the count 17. Arabic names and thresholds are the owner's; English names are working
 * translations (editable in the dashboard).
 */
const r = (order: number, key: string, nameAr: string, nameEn: string, minDamage: number): RankDefinition =>
  ({ key, order, nameAr, nameEn, minDamage, discordRoleId: null, enabled: true });
export const DEFAULT_RANKS: readonly RankDefinition[] = [
  r(1, 'soldier', 'عسكري', 'Soldier', 10_000),
  r(2, 'corporal', 'عريف', 'Corporal', 50_000),
  r(3, 'sergeant', 'رقيب', 'Sergeant', 100_000),
  r(4, 'sergeant_first_class', 'رقيب أول', 'Staff Sergeant', 200_000),
  r(5, 'warrant_officer', 'مساعد', 'Warrant Officer', 400_000),
  r(6, 'warrant_officer_first_class', 'مساعد أول', 'Chief Warrant Officer', 700_000),
  r(7, 'lieutenant', 'ملازم', 'Lieutenant', 1_000_000),
  r(8, 'first_lieutenant', 'ملازم أول', 'First Lieutenant', 2_500_000),
  r(9, 'captain', 'نقيب', 'Captain', 5_000_000),
  r(10, 'major', 'رائد', 'Major', 10_000_000),
  r(11, 'lieutenant_colonel', 'مقدم', 'Lieutenant Colonel', 20_000_000),
  r(12, 'colonel', 'عقيد', 'Colonel', 35_000_000),
  r(13, 'brigadier', 'عميد', 'Brigadier General', 60_000_000),
  r(14, 'major_general', 'لواء', 'Major General', 90_000_000),
  r(15, 'lieutenant_general', 'فريق', 'Lieutenant General', 130_000_000),
  r(16, 'general', 'فريق أول', 'General', 180_000_000),
  r(17, 'field_marshal', 'مشير', 'Field Marshal', 250_000_000),
];

export type LadderIssueCode =
  | 'EMPTY_LADDER'
  | 'DUPLICATE_ORDER'
  | 'DUPLICATE_KEY'
  | 'INVALID_KEY'
  | 'DUPLICATE_ROLE'
  | 'NAME_MISSING'
  | 'THRESHOLD_NOT_INTEGER'
  | 'THRESHOLD_NEGATIVE'
  | 'THRESHOLD_ZERO'
  | 'THRESHOLD_NOT_INCREASING';

export interface LadderIssue {
  code: LadderIssueCode;
  rankKey?: string;
  /** Machine-readable context so the UI can localise the message. */
  params?: Record<string, string | number>;
  message: string;
}

export interface ValidateOptions {
  /** Allow a higher rank to have the SAME threshold as the previous one. Default false. */
  allowEqualThresholds?: boolean;
}

export type LadderValidation = { ok: true } | { ok: false; issues: LadderIssue[] };

/**
 * Enforces the invariant: a higher rank can never require less damage than a lower rank.
 * This is the single source of truth; both the API and the dashboard call it.
 */
export function validateLadder(ranks: readonly RankDefinition[], opts: ValidateOptions = {}): LadderValidation {
  const issues: LadderIssue[] = [];
  if (ranks.length === 0) {
    return { ok: false, issues: [{ code: 'EMPTY_LADDER', message: 'The rank ladder must contain at least one rank.' }] };
  }

  const orders = new Set<number>();
  const keys = new Set<string>();
  const roles = new Set<string>();
  for (const r of ranks) {
    if (orders.has(r.order)) {
      issues.push({ code: 'DUPLICATE_ORDER', rankKey: r.key, params: { order: r.order }, message: `Two ranks share order ${r.order}.` });
    }
    orders.add(r.order);
    if (keys.has(r.key)) {
      issues.push({ code: 'DUPLICATE_KEY', rankKey: r.key, message: `Duplicate rank key "${r.key}".` });
    }
    keys.add(r.key);

    if (!/^[a-z][a-z0-9_]{0,39}$/.test(r.key)) {
      issues.push({ code: 'INVALID_KEY', rankKey: r.key, message: `Rank key "${r.key}" must be lowercase letters/digits/underscore (max 40).` });
    }
    if (!r.nameEn?.trim() || !r.nameAr?.trim()) {
      issues.push({ code: 'NAME_MISSING', rankKey: r.key, message: `Rank "${r.key}" needs both an Arabic and an English display name.` });
    }
    if (r.discordRoleId) {
      if (roles.has(r.discordRoleId)) issues.push({ code: 'DUPLICATE_ROLE', rankKey: r.key, message: `The same Discord role is mapped to more than one rank (${r.key}).` });
      roles.add(r.discordRoleId);
    }
    if (typeof r.minDamage !== 'number' || !Number.isSafeInteger(r.minDamage)) {
      issues.push({ code: 'THRESHOLD_NOT_INTEGER', rankKey: r.key, message: `${r.nameEn}: threshold must be a whole number.` });
    } else if (r.minDamage < 0) {
      issues.push({ code: 'THRESHOLD_NEGATIVE', rankKey: r.key, message: `${r.nameEn}: threshold cannot be negative.` });
    } else if (r.minDamage === 0) {
      // A zero threshold would make every player (including those with no damage) hold this rank.
      issues.push({ code: 'THRESHOLD_ZERO', rankKey: r.key, message: `${r.nameEn}: threshold must be greater than zero.` });
    }
  }

  // Ordering only matters among ENABLED ranks (disabled ones take no part in matching).
  const sorted = ranks.filter((x) => x.enabled).sort((a, b) => a.order - b.order);
  for (let i = 1; i < sorted.length; i++) {
    const lower = sorted[i - 1]!;
    const higher = sorted[i]!;
    if (!Number.isSafeInteger(lower.minDamage) || !Number.isSafeInteger(higher.minDamage)) continue;
    const bad = opts.allowEqualThresholds ? higher.minDamage < lower.minDamage : higher.minDamage <= lower.minDamage;
    if (bad) {
      issues.push({
        code: 'THRESHOLD_NOT_INCREASING',
        rankKey: higher.key,
        params: { rank: higher.nameEn, lowerRank: lower.nameEn, threshold: higher.minDamage, lowerThreshold: lower.minDamage },
        message: `${higher.nameEn} (${higher.minDamage.toLocaleString('en-US')}) must require ${
          opts.allowEqualThresholds ? 'at least' : 'more than'
        } ${lower.nameEn} (${lower.minDamage.toLocaleString('en-US')}).`,
      });
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export type DamageParse = { ok: true; value: number } | { ok: false; reason: 'missing' | 'not_numeric' | 'negative' | 'unsafe' };

/** Strict parse: anything unusual is reported as unusable, never coerced to 0. */
export function parseDamage(raw: unknown): DamageParse {
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'missing' };
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'bigint') n = Number(raw);
  else if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim())) n = Number(raw.trim());
  else return { ok: false, reason: 'not_numeric' };
  if (!Number.isFinite(n)) return { ok: false, reason: 'not_numeric' };
  if (n < 0) return { ok: false, reason: 'negative' };
  if (n > Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'unsafe' };
  return { ok: true, value: Math.floor(n) };
}

export type RankResult =
  | { status: 'ranked'; rank: RankDefinition }
  /** Valid damage, but below the first threshold. A real, trustworthy "no rank". */
  | { status: 'unranked' }
  /** Damage could not be trusted. Callers must NOT change roles on this result. */
  | { status: 'unknown'; reason: 'missing' | 'not_numeric' | 'negative' | 'unsafe' };

/** Highest rank whose minimum is <= damage. Assumes a validated ladder. */
export function computeRank(rawDamage: unknown, ranks: readonly RankDefinition[]): RankResult {
  const parsed = parseDamage(rawDamage);
  if (!parsed.ok) return { status: 'unknown', reason: parsed.reason };
  let best: RankDefinition | null = null;
  for (const r of ranks) {
    if (r.enabled && parsed.value >= r.minDamage && (best === null || r.order > best.order)) best = r;
  }
  return best ? { status: 'ranked', rank: best } : { status: 'unranked' };
}

export type DemotionPolicy =
  /** Never remove a rank because damage looks lower. (Safest default.) */
  | { mode: 'never' }
  /** Follow the computed rank exactly, in both directions. */
  | { mode: 'immediate' }
  /** Demote only after the computed rank has stayed lower for N consecutive days. */
  | { mode: 'grace'; graceDays: number };

export type RankAction =
  | { action: 'set'; targetOrder: number | null; reason: 'promotion' | 'demotion' | 'initial' }
  | { action: 'keep'; reason: 'unchanged' | 'demotion_disabled' | 'in_grace_period' | 'untrusted_data' };

export interface RankDecisionInput {
  currentOrder: number | null;
  computed: RankResult;
  policy: DemotionPolicy;
  /** When the computed rank first dropped below the current rank (grace policy only). */
  belowSince?: Date | null;
  now: Date;
}

export function decideRankAction(input: RankDecisionInput): RankAction {
  const { currentOrder, computed, policy, belowSince, now } = input;
  if (computed.status === 'unknown') return { action: 'keep', reason: 'untrusted_data' };

  const targetOrder = computed.status === 'ranked' ? computed.rank.order : null;
  if (targetOrder === currentOrder) return { action: 'keep', reason: 'unchanged' };

  const cur = currentOrder ?? 0;
  const tgt = targetOrder ?? 0;
  if (tgt > cur) return { action: 'set', targetOrder, reason: currentOrder === null ? 'initial' : 'promotion' };

  // tgt < cur: a demotion candidate.
  switch (policy.mode) {
    case 'never':
      return { action: 'keep', reason: 'demotion_disabled' };
    case 'immediate':
      return { action: 'set', targetOrder, reason: 'demotion' };
    case 'grace': {
      if (!belowSince) return { action: 'keep', reason: 'in_grace_period' };
      const elapsedDays = (now.getTime() - belowSince.getTime()) / 86_400_000;
      return elapsedDays >= policy.graceDays
        ? { action: 'set', targetOrder, reason: 'demotion' }
        : { action: 'keep', reason: 'in_grace_period' };
    }
  }
}
