/**
 * Role-sync decision engine. Pure: given what we know about a player and what the member
 * currently has in Discord, decide which MANAGED roles to add/remove.
 *
 * Core safety rule: only a trustworthy "does not qualify" may remove a role.
 * API errors, rate limits, missing fields and not-found are all "unknown" and never revoke.
 */
import { computeRank, decideRankAction, type DemotionPolicy, type RankDefinition } from './ranks.js';

/** Outcome of one game-API lookup. Distinguishes "empty" from "failed". */
export type Fetched<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_found' }
  | { status: 'rate_limited'; retryAfterMs?: number }
  | { status: 'error'; message: string }
  | { status: 'incomplete'; missing: string[] };

export type Evidence = 'qualifies' | 'not_qualifies' | 'unknown';

export interface RuleEvaluation {
  /** Discord role this rule controls. Rules with no configured role are skipped by the caller. */
  roleId: string;
  evidence: Evidence;
  /** Human/audit-friendly explanation key. */
  why: string;
}

export interface RoleChangePlan {
  add: string[];
  remove: string[];
  /** Managed roles we deliberately left alone, with the reason (shown in the dashboard). */
  skipped: { roleId: string; why: string }[];
  /** Roles we wanted to touch but cannot (Discord hierarchy / missing permission). */
  blocked: { roleId: string; why: string }[];
}

export interface PlanInput {
  evaluations: RuleEvaluation[];
  /** Every role id this guild's rules manage. We never touch roles outside this set. */
  managedRoleIds: ReadonlySet<string>;
  /** Roles the member currently has. */
  currentRoleIds: ReadonlySet<string>;
  /** Roles the bot is able to assign/remove (below its top role, bot has Manage Roles). */
  assignableRoleIds: ReadonlySet<string>;
}

export function planRoleChanges(input: PlanInput): RoleChangePlan {
  const plan: RoleChangePlan = { add: [], remove: [], skipped: [], blocked: [] };

  // If two rules point at the same role, "qualifies" wins over "not_qualifies" (union semantics),
  // and "unknown" beats "not_qualifies" (we never remove while any rule is uncertain).
  const merged = new Map<string, { evidence: Evidence; why: string }>();
  const rank: Record<Evidence, number> = { not_qualifies: 0, unknown: 1, qualifies: 2 };
  for (const e of input.evaluations) {
    if (!input.managedRoleIds.has(e.roleId)) continue;
    const prev = merged.get(e.roleId);
    if (prev === undefined || rank[e.evidence] > rank[prev.evidence]) merged.set(e.roleId, { evidence: e.evidence, why: e.why });
  }

  for (const [roleId, { evidence, why }] of merged) {
    const has = input.currentRoleIds.has(roleId);
    if (evidence === 'unknown') {
      plan.skipped.push({ roleId, why });
      continue;
    }
    if (evidence === 'qualifies' && !has) {
      if (input.assignableRoleIds.has(roleId)) plan.add.push(roleId);
      else plan.blocked.push({ roleId, why: 'bot_cannot_assign_role' });
    } else if (evidence === 'not_qualifies' && has) {
      if (input.assignableRoleIds.has(roleId)) plan.remove.push(roleId);
      else plan.blocked.push({ roleId, why: 'bot_cannot_remove_role' });
    }
  }
  return plan;
}

/**
 * Turns a damage lookup into per-rank evaluations. Exactly one rank is "qualifies"
 * (the one the policy lands on); other ranks are "not_qualifies" only when data is trusted.
 */
export function evaluateRankRules(args: {
  /** The guild's rank ladder (any rank may lack a Discord role; disabled ranks are ignored entirely). */
  ladder: readonly RankDefinition[];
  damage: Fetched<unknown>;
  currentOrder: number | null;
  policy: DemotionPolicy;
  belowSince?: Date | null;
  now: Date;
}): RuleEvaluation[] {
  const active = args.ladder.filter((r) => r.enabled);
  const withRole = active.filter((r) => r.discordRoleId !== null);
  const all = (evidence: RuleEvaluation['evidence'], why: string) => withRole.map((r) => ({ roleId: r.discordRoleId!, evidence, why }));

  if (args.damage.status !== 'ok') return all('unknown', `lookup_${args.damage.status}`);

  const computed = computeRank(args.damage.data, active);
  const decision = decideRankAction({ currentOrder: args.currentOrder, computed, policy: args.policy, belowSince: args.belowSince ?? null, now: args.now });
  if (decision.action === 'keep' && decision.reason === 'untrusted_data') return all('unknown', 'damage_unusable');

  // The rank the player has earned has no Discord role yet: do not guess a neighbouring role, change nothing.
  if (computed.status === 'ranked' && computed.rank.discordRoleId === null) return all('unknown', 'rank_role_not_configured');

  if (decision.action === 'keep') {
    if (decision.reason === 'unchanged') {
      // Trusted data and already correct: the group is exclusive, so every other rank role is "not_qualifies".
      const targetOrder = computed.status === 'ranked' ? computed.rank.order : null;
      return withRole.map((r) => ({ roleId: r.discordRoleId!, evidence: r.order === targetOrder ? ('qualifies' as const) : ('not_qualifies' as const), why: 'unchanged' }));
    }
    // Demotion deliberately withheld (policy/grace): keep the current rank, leave the others alone.
    return withRole.map((r) => ({ roleId: r.discordRoleId!, evidence: r.order === args.currentOrder ? ('qualifies' as const) : ('unknown' as const), why: decision.reason }));
  }
  return withRole.map((r) => ({ roleId: r.discordRoleId!, evidence: r.order === decision.targetOrder ? ('qualifies' as const) : ('not_qualifies' as const), why: decision.reason }));
}
