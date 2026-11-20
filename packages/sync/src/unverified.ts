/**
 * Optional "Unverified" role removal after a successful verification (roadmap M2a).
 *
 * Runs AFTER the existing verification flow has granted the member's roles (citizen etc. through `syncOneUser`). It only ever removes the ONE role the
 * server configured, never anything else, and it can never fail the verification: every outcome is returned (and audited) instead of thrown.
 * Idempotent: a member who no longer holds the role costs no Discord write and is not an error.
 */
import { audit, getGuildConfig, roleIsManagedByBot, type Db } from '@aon/db';
import { classifyDiscordError } from './member-sync.js';
import type { DiscordGateway } from './ports.js';

export type UnverifiedOutcome =
  | { status: 'disabled' }
  | { status: 'absent'; roleId: string }
  | { status: 'removed'; roleId: string; attempts: number }
  | { status: 'skipped'; roleId: string; reason: 'sync_incomplete' | 'role_managed_by_bot' | 'role_not_removable' | 'member_absent' }
  | { status: 'failed'; roleId: string; reason: string; attempts: number };

export interface UnverifiedDeps { db: Db; discord: DiscordGateway; sleep?: (ms: number) => Promise<void> }

/**
 * @param syncOk  true when the verification's role synchronisation finished without an error and wrote every planned role. When false the Unverified role is
 *                KEPT (the member must not end with neither role) and the skip is reported.
 */
export async function removeUnverifiedRole(deps: UnverifiedDeps, a: { guildId: string; userId: string; syncOk: boolean; actor: string }): Promise<UnverifiedOutcome> {
  const cfg = await getGuildConfig(deps.db, a.guildId);
  if (!cfg || !cfg.unverifiedRoleEnabled || !cfg.unverifiedRoleId) return { status: 'disabled' };
  const roleId = cfg.unverifiedRoleId;
  const note = (action: string, details: Record<string, unknown>) => audit(deps.db, { guildId: a.guildId, actor: a.actor, action, target: a.userId, details: { roleId, ...details } }).catch(() => undefined);
  const skip = async (reason: Extract<UnverifiedOutcome, { status: 'skipped' }>['reason']): Promise<UnverifiedOutcome> => { await note('verification.unverified_removal_skipped', { reason }); return { status: 'skipped', roleId, reason }; };
  if (!a.syncOk) return skip('sync_incomplete');
  // last guard (settings are validated when saved, but a role can have been mapped since): never remove a role the bot manages, e.g. the citizen role
  if (await roleIsManagedByBot(deps.db, a.guildId, roleId)) return skip('role_managed_by_bot');
  const fail = async (reason: string, attempts: number): Promise<UnverifiedOutcome> => { await note('verification.unverified_removal_failed', { reason, attempts }); return { status: 'failed', roleId, reason, attempts }; };
  try {
    const member = await deps.discord.getMemberRoles(a.guildId, a.userId);
    if (member.status === 'absent') return skip('member_absent');
    if (member.status === 'error') return fail('member_lookup_failed', 0);
    if (!member.roleIds.has(roleId)) return { status: 'absent', roleId };                                                // nothing to do: not an error, no write
    if (!(await deps.discord.assignableRoles(a.guildId)).has(roleId)) return skip('role_not_removable');                // deleted role, above the bot, managed, or no Manage Roles
  } catch (e) { return fail(classifyDiscordError(e).kind, 0); }
  let attempts = 0;
  for (;;) {
    attempts++;
    try { await deps.discord.removeRole(a.guildId, a.userId, roleId, 'AoN role bot: account verified, unverified role removed'); break; }
    catch (e) {
      const c = classifyDiscordError(e);
      if (c.kind === 'role_deleted') return skip('role_not_removable');                                                   // the role is gone: the goal is moot
      if (c.kind === 'member_left') return skip('member_absent');
      if ((c.kind === 'rate_limited' || c.kind === 'transient') && attempts < 2) { await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(c.retryAfterMs ?? 1500); continue; }   // ONE retry
      return fail(c.kind, attempts);
    }
  }
  await note('verification.unverified_removed', { attempts });
  return { status: 'removed', roleId, attempts };
}
