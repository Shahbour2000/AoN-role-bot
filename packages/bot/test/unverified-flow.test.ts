import { describe, expect, it } from 'vitest';
import { addRoleMapping, setUnverifiedRole } from '@aon/db';
import { handleCommand } from '../src/index.js';
import { ROLE, botSetup, inv, rosterOf, verifyViaTicket } from './bot-harness.js';

/** M2a through the REAL ticket flow: the optional "Unverified" role removal after a successful verification. */
const UV = '700001';
async function world(guilds = ['A'], enableIn: string[] = ['A']) {
  const h = await botSetup({ guilds });
  for (const g of guilds) await addRoleMapping(h.db, { guildId: g, kind: 'president', discordRoleId: ROLE.pres, actor: null });
  h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
  for (const g of enableIn) expect(await setUnverifiedRole(h.db, { guildId: g, enabled: true, roleId: UV, actor: null })).toEqual({ ok: true });
  return h;
}
const audits = async (h: Awaited<ReturnType<typeof world>>, action: string) => (await h.db.query<{ guild_id: string; details: Record<string, unknown> }>(`SELECT guild_id, details FROM audit_events WHERE action=$1 ORDER BY id`, [action])).rows;

describe('Unverified-role removal in the verification flow', () => {
  it('DISABLED (default): the Discord call log and the reply are exactly what they were before the feature existed', async () => {
    const h = await world(['A'], []); h.discord.give('A', 'u1', UV); const { result } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    expect(result.content).toContain('Verified'); expect(h.discord.calls).toEqual([`+u1:${ROLE.pres}`]); expect(h.discord.has('A', 'u1').has(UV)).toBe(true);
    expect(await audits(h, 'verification.unverified_removed')).toEqual([]);
  });
  it('ENABLED: the member gets their roles FIRST, then loses the Unverified role; the reply text is the same as when disabled', async () => {
    const off = await world(['A'], []); off.discord.give('A', 'u1', UV); const offReply = (await verifyViaTicket(off, { playerId: 'p1', username: 'Alpha' })).result.content;
    const h = await world(); h.discord.give('A', 'u1', UV, '700099'); const { result } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    expect(h.discord.calls).toEqual([`+u1:${ROLE.pres}`, `-u1:${UV}`]);                                  // grant before removal
    expect([...h.discord.has('A', 'u1')].sort()).toEqual(['700099', ROLE.pres].sort());                  // unrelated role untouched
    expect(result.content).toBe(offReply); expect(result.content).toContain('Verified');
    expect((await audits(h, 'verification.unverified_removed')).map((a) => a.guild_id)).toEqual(['A']);
  });
  it('a member who never had the role: no removal call, verification unchanged', async () => {
    const h = await world(); h.discord.give('A', 'u1'); const { result } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    expect(result.content).toContain('Verified'); expect(h.discord.calls).toEqual([`+u1:${ROLE.pres}`]);
  });
  it('a failed removal (no permission) never fails the verification; it is audited with the reason', async () => {
    const h = await world(); h.discord.give('A', 'u1', UV); h.discord.errors.set(`-${UV}`, [{ code: 50013 }]);
    const { result } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    expect(result.content).toContain('Verified'); expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true); expect(h.discord.has('A', 'u1').has(UV)).toBe(true);
    expect((await audits(h, 'verification.unverified_removal_failed'))[0]!.details).toMatchObject({ reason: 'missing_permissions' });
    expect((await h.db.query(`SELECT status FROM global_links`)).rows.length).toBe(1);                   // the link exists
  });
  it('if the role grant itself failed, the Unverified role is KEPT (never neither role) and the skip is audited', async () => {
    const h = await world(); h.discord.give('A', 'u1', UV); h.discord.failAdd.add(ROLE.pres);
    const { result } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    expect(result.content).toContain('Verified'); expect(h.discord.has('A', 'u1').has(UV)).toBe(true); expect(h.discord.calls.filter((c) => c.startsWith('-'))).toEqual([]);
    expect((await audits(h, 'verification.unverified_removal_skipped'))[0]!.details).toMatchObject({ reason: 'sync_incomplete' });
  });
  it('an existing global link activated in ANOTHER server uses that server\'s own setting', async () => {
    const h = await world(['A', 'B'], ['B']); h.discord.give('A', 'u1', UV); h.discord.give('B', 'u1', UV);
    await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha', guildId: 'A' });                       // A: feature off -> keeps it
    expect(h.discord.has('A', 'u1').has(UV)).toBe(true);
    const c = inv({ group: 'link', guildId: 'B' }); await handleCommand(h.deps, c.i);                    // B: the member activates the existing link
    expect(c.last().content).toContain('Alpha'); expect(h.discord.has('B', 'u1').has(UV)).toBe(false); expect(h.discord.has('B', 'u1').has(ROLE.pres)).toBe(true);
    expect(h.discord.has('A', 'u1').has(UV)).toBe(true);                                                  // A untouched
    expect((await audits(h, 'verification.unverified_removed')).map((a) => a.guild_id)).toEqual(['B']);
  });
  it('running the activation again is a harmless no-op (already removed)', async () => {
    const h = await world(); h.discord.give('A', 'u1', UV); await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' }); h.discord.calls.length = 0;
    const c = inv({ group: 'link' }); await handleCommand(h.deps, c.i); expect(h.discord.calls).toEqual([]); expect((await audits(h, 'verification.unverified_removed')).length).toBe(1);
  });
});
