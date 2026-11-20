import { describe, expect, it } from 'vitest';
import { ensureGuild, setUnverifiedRole, updateGuildSettings } from '@aon/db';
import { removeUnverifiedRole, type UnverifiedOutcome } from '../src/index.js';
import { ROLE, setup } from './harness.js';

/** M2a — optional removal of the server's "Unverified" role after a successful verification. */
const UV = '500001', OTHER = '500002';
async function world(enable = true) {
  const h = await setup({ guilds: ['A', 'B'] });
  if (enable) expect(await setUnverifiedRole(h.db, { guildId: 'A', enabled: true, roleId: UV, actor: null })).toEqual({ ok: true });
  h.discord.give('A', 'd1', UV, ROLE.citizen, OTHER);
  const sleeps: number[] = [];
  const run = (over: Partial<{ syncOk: boolean; guildId: string }> = {}) => removeUnverifiedRole({ db: h.db, discord: h.discord, sleep: async (ms) => { sleeps.push(ms); } }, { guildId: over.guildId ?? 'A', userId: 'd1', syncOk: over.syncOk ?? true, actor: 'd1' });
  const held = () => [...h.discord.has('A', 'd1')].sort();
  const audits = async (action: string) => (await h.db.query<{ details: Record<string, unknown> }>(`SELECT details FROM audit_events WHERE guild_id='A' AND action=$1 ORDER BY id`, [action])).rows.map((r) => r.details);
  return { ...h, run, held, sleeps, audits };
}
const status = (o: UnverifiedOutcome) => o.status;

describe('removeUnverifiedRole', () => {
  it('DISABLED (the default for every server): no Discord call at all, no audit entry, nothing changes', async () => {
    const w = await world(false); const o = await w.run(); expect(o).toEqual({ status: 'disabled' }); expect(w.discord.calls).toEqual([]); expect(w.held()).toEqual([OTHER, ROLE.citizen, UV].sort());
    expect(await w.audits('verification.unverified_removed')).toEqual([]);
  });
  it('ENABLED: removes exactly the configured role (one write), leaves the citizen role and every other role alone, audits it', async () => {
    const w = await world(); const o = await w.run(); expect(o).toEqual({ status: 'removed', roleId: UV, attempts: 1 });
    expect(w.discord.calls).toEqual([`-d1:${UV}`]); expect(w.held()).toEqual([OTHER, ROLE.citizen].sort());
    expect(await w.audits('verification.unverified_removed')).toEqual([{ roleId: UV, attempts: 1 }]);
  });
  it('idempotent: a member who no longer holds the role is not an error and costs no write; running twice is a no-op the second time', async () => {
    const w = await world(); await w.run(); w.discord.calls.length = 0;
    expect(await w.run()).toEqual({ status: 'absent', roleId: UV }); expect(w.discord.calls).toEqual([]); expect(await w.audits('verification.unverified_removed')).toHaveLength(1);
  });
  it('the role is KEPT (and the skip reported) when the role synchronisation did not complete, so nobody ends with neither role', async () => {
    const w = await world(); const o = await w.run({ syncOk: false }); expect(o).toEqual({ status: 'skipped', roleId: UV, reason: 'sync_incomplete' });
    expect(w.discord.calls).toEqual([]); expect(w.held()).toContain(UV); expect((await w.audits('verification.unverified_removal_skipped'))[0]).toMatchObject({ reason: 'sync_incomplete' });
  });
  it('NEVER removes a role the bot manages, even if the settings were bypassed (e.g. the citizen role)', async () => {
    const w = await world(); await w.db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('A','citizen','',$1)`, [UV]);      // bypasses the writer that refuses it
    const o = await w.run(); expect(o).toEqual({ status: 'skipped', roleId: UV, reason: 'role_managed_by_bot' }); expect(w.discord.calls).toEqual([]); expect(w.held()).toContain(UV);
  });
  it('a role the bot cannot remove (deleted / above the bot / managed / no permission) is skipped without an attempt', async () => {
    const w = await world(); w.discord.assignable = new Set([OTHER]); const o = await w.run(); expect(o).toEqual({ status: 'skipped', roleId: UV, reason: 'role_not_removable' });
    expect(w.discord.attempts.get(`-${UV}`)).toBeUndefined(); expect(w.held()).toContain(UV);
  });
  it('transient Discord errors (rate limit, 5xx) are retried ONCE; permanent ones are not retried; none of them throws', async () => {
    let w = await world(); w.discord.errors.set(`-${UV}`, [{ status: 429, retryAfter: 1 }]);
    expect(await w.run()).toEqual({ status: 'removed', roleId: UV, attempts: 2 }); expect(w.sleeps).toEqual([1000]); expect(w.held()).not.toContain(UV);
    w = await world(); w.discord.errors.set(`-${UV}`, [{ status: 503 }, { status: 503 }]);
    expect(await w.run()).toMatchObject({ status: 'failed', reason: 'transient', attempts: 2 }); expect(w.discord.attempts.get(`-${UV}`)).toBe(2); expect(w.held()).toContain(UV);
    w = await world(); w.discord.errors.set(`-${UV}`, [{ code: 50013, message: 'Missing Permissions' }, { code: 50013 }]);
    expect(await w.run()).toMatchObject({ status: 'failed', reason: 'missing_permissions', attempts: 1 }); expect(w.discord.attempts.get(`-${UV}`)).toBe(1);
    expect((await w.audits('verification.unverified_removal_failed'))[0]).toMatchObject({ reason: 'missing_permissions', attempts: 1 });
  });
  it('a role deleted or a member gone while removing is moot, not a failure', async () => {
    let w = await world(); w.discord.errors.set(`-${UV}`, [{ code: 10011 }]); expect(await w.run()).toMatchObject({ status: 'skipped', reason: 'role_not_removable' });
    w = await world(); w.discord.errors.set(`-${UV}`, [{ code: 10007 }]); expect(await w.run()).toMatchObject({ status: 'skipped', reason: 'member_absent' });
    w = await world(); w.discord.memberStatus.set('A:d1', 'absent'); expect(await w.run()).toMatchObject({ status: 'skipped', reason: 'member_absent' });
    w = await world(); w.discord.memberStatus.set('A:d1', 'error'); expect(await w.run()).toMatchObject({ status: 'failed', reason: 'member_lookup_failed' });
  });
  it('a gateway that throws unexpectedly is reported as a failure, never thrown', async () => {
    const w = await world(); w.discord.getMemberRoles = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
    const o = await w.run(); expect(status(o)).toBe('failed');
  });
  it('per-server isolation: another server\'s setting (or none) is untouched; a server without the feature never loses a role', async () => {
    const w = await world(); w.discord.give('B', 'd1', UV, ROLE.citizen);
    expect(await w.run({ guildId: 'B' })).toEqual({ status: 'disabled' }); expect([...w.discord.has('B', 'd1')].sort()).toEqual([ROLE.citizen, UV].sort());
    await ensureGuild(w.db, 'C', 'C'); await updateGuildSettings(w.db, 'C', { country_id: 'eg' }, null); expect(await w.run({ guildId: 'C' })).toEqual({ status: 'disabled' });
    expect(await w.run({ guildId: 'ZZ' })).toEqual({ status: 'disabled' });                                                       // unknown server: nothing
  });
});
