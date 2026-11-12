import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERIFICATION, findCodeInCompanies } from '@aon/core';
import {
  beginCheck, cancelAttempt, claimLink, completeVerification, createAttempt, endCheck, ensureGuildLink, forceLink, getGlobalLinkForPlayer, getGlobalLinkForUser,
  getPendingAttemptForUser, migrate, recoverGlobalLink, unlinkGlobalSelf, verificationStats, type Db,
} from '../src/index.js';
import { MIGRATIONS_DIR, addGuild, emptyDb, freshDb } from './helpers.js';

const G1 = '100000000000000001', G2 = '100000000000000002';
const U1 = '200000000000000001', U2 = '200000000000000002', U3 = '200000000000000003';
const T0 = new Date('2026-11-11T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const actions = async (db: Db, g: string) => (await db.query<{ action: string }>('SELECT action FROM audit_events WHERE guild_id=$1 ORDER BY id', [g])).rows.map((r) => r.action);
async function open(db: Db, user: string, player: string, guild = G1, now = T0) {
  const r = await createAttempt(db, { guildId: guild, discordUserId: user, playerId: player, username: `n-${player}`, now });
  if (!r.ok) throw new Error(`open failed: ${r.code}`);
  return r;
}
async function ready(db: Db, attemptId: string, user: string, now: Date) { const g = await beginCheck(db, { attemptId, discordUserId: user, now }); if (!g.ok) throw new Error(g.code); return g; }

describe('migration 0009 keeps existing links and resolves conflicts without deleting anything', () => {
  it('collapses duplicates, keeps the strongest conflicting link, audits the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aon-mig-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x < '0009')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const db = await emptyDb(); await migrate(db, dir);
    await addGuild(db, G1); await addGuild(db, G2);
    const ins = (g: string, u: string, p: string, method: string, when: string) => db.query(`INSERT INTO account_links (guild_id, discord_user_id, player_id, player_username, status, method, requested_at) VALUES ($1,$2,$3,'x','verified',$4,$5)`, [g, u, p, method, when]);
    await ins(G1, U1, 'P1', 'self_direct', '2026-01-01'); await ins(G2, U1, 'P1', 'self_direct', '2026-01-02');      // same pair in two servers
    await ins(G1, U2, 'P2', 'admin_forced', '2026-02-01'); await ins(G2, U3, 'P2', 'self_direct', '2026-01-01');      // same player, two users: admin wins although older loser
    await ins(G1, U3, 'P9', 'self_direct', '2026-03-01');                                                              // U3 also keeps this one
    await migrate(db, MIGRATIONS_DIR);
    const g = (await db.query<{ discord_user_id: string; player_id: string; method: string }>(`SELECT discord_user_id, player_id, method FROM global_links WHERE status='active' ORDER BY player_id`)).rows;
    expect(g).toEqual([{ discord_user_id: U1, player_id: 'P1', method: 'legacy_unverified' }, { discord_user_id: U2, player_id: 'P2', method: 'admin_forced' }, { discord_user_id: U3, player_id: 'P9', method: 'legacy_unverified' }]);
    const lost = (await db.query<{ guild_id: string; discord_user_id: string; status: string }>(`SELECT guild_id, discord_user_id, status FROM account_links WHERE status='unlinked'`)).rows;
    expect(lost).toEqual([{ guild_id: G2, discord_user_id: U3, status: 'unlinked' }]);           // nothing deleted: 5 rows still exist
    expect(Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM account_links')).rows[0]!.n)).toBe(5);
    expect(await actions(db, G2)).toContain('link.migration_conflict_unlinked');
  });
});

describe('global uniqueness is enforced by the database', () => {
  it('a per-server link creates / must match the global link; a clash is refused', async () => {
    const db = await freshDb(); await addGuild(db, G1); await addGuild(db, G2);
    expect((await claimLink(db, { guildId: G1, discordUserId: U1, playerId: 'P1', username: 'a', direct: true })).ok).toBe(true);
    expect((await getGlobalLinkForUser(db, U1))?.method).toBe('legacy_unverified');
    expect(await claimLink(db, { guildId: G2, discordUserId: U2, playerId: 'P1', username: 'a', direct: true })).toEqual({ ok: false, code: 'PLAYER_ALREADY_LINKED' });   // other server, same game account
    expect(await claimLink(db, { guildId: G2, discordUserId: U1, playerId: 'P2', username: 'b', direct: true })).toMatchObject({ ok: false });                           // same Discord user, other account
    await expect(db.query(`INSERT INTO global_links (discord_user_id, player_id, method) VALUES ($1,'P7','admin_forced')`, [U1])).rejects.toThrow(/unique|duplicate/i);
    await expect(db.query(`INSERT INTO global_links (discord_user_id, player_id, method) VALUES ('x','P1','admin_forced')`)).rejects.toThrow(/unique|duplicate/i);
    await expect(db.query(`INSERT INTO account_links (guild_id, discord_user_id, player_id, status, method) VALUES ($1,$2,'P1','verified','global_link')`, [G2, U2])).rejects.toThrow(/unique|conflict/i);
    await expect(db.query(`INSERT INTO account_links (guild_id, discord_user_id, player_id, status, method) VALUES ($1,'zz','PX','verified','global_link')`, [G2])).rejects.toThrow(/global link required/);
  });
  it('syncing (updating non-identity columns) is not blocked', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    await claimLink(db, { guildId: G1, discordUserId: U1, playerId: 'P1', username: 'a', direct: true });
    await db.query(`UPDATE account_links SET last_synced_at=now(), managed_role_ids='{r1}' WHERE guild_id=$1`, [G1]);
  });
});

describe('verification attempts', () => {
  it('stores only a hash of the code, which the real company data can satisfy', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    const a = await open(db, U1, 'P1');
    expect(a.code).toMatch(/^AON-[2-9A-HJKMNP-Z]{10}$/);
    const row = (await db.query<Record<string, unknown>>('SELECT * FROM verification_attempts WHERE id=$1', [a.attemptId])).rows[0]!;
    expect(JSON.stringify(row)).not.toContain(a.code.slice(4)); expect(row['code_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(findCodeInCompanies(a.attemptId, row['code_hash'] as string, [{ id: 'c1', name: `Steel ${a.code}` }]).found).toBe(true);
    expect(a.expiresAt.getTime() - T0.getTime()).toBe(30 * 60_000);
    expect(await actions(db, G1)).toContain('verification.opened');
  });
  it('one pending attempt per member (a new one supersedes the old); codes differ', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    const a = await open(db, U1, 'P1'); const b = await open(db, U1, 'P1', G1, at(1000));
    expect(b.code).not.toBe(a.code);
    expect((await db.query<{ status: string }>(`SELECT status FROM verification_attempts WHERE id=$1`, [a.attemptId])).rows[0]!.status).toBe('superseded');
    expect((await getPendingAttemptForUser(db, U1, at(2000)))?.id).toBe(b.attemptId);
    expect((await beginCheck(db, { attemptId: a.attemptId, discordUserId: U1, now: at(2000) }))).toEqual({ ok: false, code: 'NOT_PENDING' });
  });
  it('is rate limited per member per day and refuses already-linked identities', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    for (let i = 0; i < VERIFICATION.maxAttemptsPerDay; i++) await open(db, U1, 'P1', G1, at(i * 1000));
    expect(await createAttempt(db, { guildId: G1, discordUserId: U1, playerId: 'P1', username: 'x', now: at(60_000) })).toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect((await createAttempt(db, { guildId: G1, discordUserId: U1, playerId: 'P1', username: 'x', now: at(25 * 3_600_000) })).ok).toBe(true);     // a day later
    const db2 = await freshDb(); await addGuild(db2, G1);
    const a = await open(db2, U2, 'P2'); await ready(db2, a.attemptId, U2, at(1000)); await completeVerification(db2, { attemptId: a.attemptId, discordUserId: U2, companyId: 'c', now: at(1000) });
    expect(await createAttempt(db2, { guildId: G1, discordUserId: U2, playerId: 'P2', username: 'x', now: at(5000) })).toMatchObject({ ok: false, code: 'ALREADY_LINKED_SELF' });
    expect(await createAttempt(db2, { guildId: G1, discordUserId: U2, playerId: 'P3', username: 'x', now: at(5000) })).toMatchObject({ ok: false, code: 'USER_LINKED_OTHER' });
    expect(await createAttempt(db2, { guildId: G1, discordUserId: U3, playerId: 'P2', username: 'x', now: at(5000) })).toMatchObject({ ok: false, code: 'PLAYER_LINKED_OTHER' });
  });
  it('checks: owner only, minimum interval, limit, expiry; API outages do not use a check', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    const a = await open(db, U1, 'P1');
    expect(await beginCheck(db, { attemptId: a.attemptId, discordUserId: U2, now: at(1000) })).toEqual({ ok: false, code: 'NOT_FOUND' });       // someone else's attempt is invisible
    expect(await beginCheck(db, { attemptId: 'not-a-uuid', discordUserId: U1, now: at(1000) })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await beginCheck(db, { attemptId: a.attemptId, discordUserId: U1, now: at(1000) })).ok).toBe(true);
    const soon = await beginCheck(db, { attemptId: a.attemptId, discordUserId: U1, now: at(5000) });
    expect(soon).toMatchObject({ ok: false, code: 'TOO_SOON' });
    await endCheck(db, a.attemptId, 'api_down');
    expect((await db.query<{ check_count: number }>('SELECT check_count FROM verification_attempts WHERE id=$1', [a.attemptId])).rows[0]!.check_count).toBe(0);
    for (let i = 0; i < VERIFICATION.maxChecks; i++) { await ready(db, a.attemptId, U1, at(30_000 * (i + 1))); await endCheck(db, a.attemptId, 'code_not_found'); }
    expect(await beginCheck(db, { attemptId: a.attemptId, discordUserId: U1, now: at(30_000 * 20) })).toEqual({ ok: false, code: 'LOCKED' });
    const b = await open(db, U2, 'P2', G1, at(0));
    expect(await beginCheck(db, { attemptId: b.attemptId, discordUserId: U2, now: at(VERIFICATION.ttlMs + 1) })).toEqual({ ok: false, code: 'EXPIRED' });
    expect(await completeVerification(db, { attemptId: b.attemptId, discordUserId: U2, companyId: null, now: at(VERIFICATION.ttlMs + 1) })).toMatchObject({ ok: false });
    expect(await getGlobalLinkForUser(db, U2)).toBeNull();
  });
  it('closing a ticket cancels it, only for its owner', async () => {
    const db = await freshDb(); await addGuild(db, G1); const a = await open(db, U1, 'P1');
    expect(await cancelAttempt(db, { attemptId: a.attemptId, discordUserId: U2 })).toBe(false);
    expect(await cancelAttempt(db, { attemptId: a.attemptId, discordUserId: U1 })).toBe(true);
    expect(await actions(db, G1)).toContain('verification.cancelled');
  });
});

describe('completing a verification', () => {
  it('creates the global link and this server link once; a code cannot be reused', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    const a = await open(db, U1, 'P1'); await ready(db, a.attemptId, U1, at(1000));
    const r = await completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c9', now: at(1000) });
    expect(r).toMatchObject({ ok: true, alreadyLinked: false, displaced: null });
    expect(await getGlobalLinkForPlayer(db, 'P1')).toMatchObject({ discordUserId: U1, method: 'company_verified' });
    expect((await db.query<{ method: string; status: string }>('SELECT method, status FROM account_links WHERE guild_id=$1', [G1])).rows).toEqual([{ method: 'global_link', status: 'verified' }]);
    expect(await completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c9', now: at(2000) })).toEqual({ ok: false, code: 'NOT_PENDING' });
    expect(await completeVerification(db, { attemptId: a.attemptId, discordUserId: U2, companyId: 'c9', now: at(2000) })).toEqual({ ok: false, code: 'NOT_FOUND' });   // someone else's attempt
    expect(await actions(db, G1)).toEqual(expect.arrayContaining(['verification.opened', 'verification.verified', 'link.global_materialized']));
  });
  it('a proof replaces an UNPROVEN link, never a proven one', async () => {
    const db = await freshDb(); await addGuild(db, G1); await addGuild(db, G2);
    await claimLink(db, { guildId: G2, discordUserId: U2, playerId: 'P1', username: 'a', direct: true });                    // legacy, unproven
    await db.query(`UPDATE account_links SET managed_role_ids='{r1,r2}' WHERE guild_id=$1`, [G2]);
    const a = await open(db, U1, 'P1'); await ready(db, a.attemptId, U1, at(1000));
    const r = await completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c', now: at(1000) });
    expect(r).toMatchObject({ ok: true, displaced: { discordUserId: U2, guilds: [{ guildId: G2, managedRoleIds: ['r1', 'r2'] }] } });
    expect(await getGlobalLinkForUser(db, U2)).toBeNull();
    expect(await actions(db, G1)).toContain('link.displaced_by_verification');
  });
  it('two members racing for the same game account: exactly one wins', async () => {
    const db = await freshDb(); await addGuild(db, G1); await addGuild(db, G2);
    const a = await open(db, U1, 'P1', G1); const b = await open(db, U2, 'P1', G2);
    await Promise.all([ready(db, a.attemptId, U1, at(1000)), ready(db, b.attemptId, U2, at(1000))]);
    const res = await Promise.all([completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c', now: at(1000) }), completeVerification(db, { attemptId: b.attemptId, discordUserId: U2, companyId: 'c', now: at(1000) })]);
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect(res.find((r) => !r.ok)).toMatchObject({ ok: false, code: 'PLAYER_LINKED_OTHER' });
    expect(Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM global_links WHERE player_id='P1' AND status='active'`)).rows[0]!.n)).toBe(1);
  });
  it('double-clicking "check" cannot create two links', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    const a = await open(db, U1, 'P1'); await ready(db, a.attemptId, U1, at(1000));
    const res = await Promise.all([1, 2, 3].map(() => completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c', now: at(1000) })));
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect(Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM account_links')).rows[0]!.n)).toBe(1);
  });
});

describe('using one global link in another server, unlinking and recovery', () => {
  it('materialises the link in a second server without verifying again', async () => {
    const db = await freshDb(); await addGuild(db, G1); await addGuild(db, G2);
    const a = await open(db, U1, 'P1'); await ready(db, a.attemptId, U1, at(1000)); await completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c', now: at(1000) });
    expect(await ensureGuildLink(db, { guildId: G2, discordUserId: U1 })).toMatchObject({ status: 'created' });
    expect(await ensureGuildLink(db, { guildId: G2, discordUserId: U1 })).toMatchObject({ status: 'exists' });
    expect(await ensureGuildLink(db, { guildId: G2, discordUserId: U2 })).toEqual({ status: 'no_global_link' });
    expect(Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM global_links')).rows[0]!.n)).toBe(1);
  });
  it('self unlink ends the link everywhere and reports each server\'s granted roles; operator recovery needs a reason and is audited', async () => {
    const db = await freshDb(); await addGuild(db, G1); await addGuild(db, G2);
    const a = await open(db, U1, 'P1'); await ready(db, a.attemptId, U1, at(1000)); await completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c', now: at(1000) });
    await ensureGuildLink(db, { guildId: G2, discordUserId: U1 });
    await db.query(`UPDATE account_links SET managed_role_ids='{rx}' WHERE guild_id=$1`, [G2]);
    const r = await unlinkGlobalSelf(db, { discordUserId: U1, guildId: G1 });
    expect(r?.guilds.map((g) => g.guildId).sort()).toEqual([G1, G2]); expect(r?.guilds.find((g) => g.guildId === G2)?.managedRoleIds).toEqual(['rx']);
    expect(await getGlobalLinkForUser(db, U1)).toBeNull();
    const b = await open(db, U2, 'P1', G1, at(5000)); await ready(db, b.attemptId, U2, at(6000)); await completeVerification(db, { attemptId: b.attemptId, discordUserId: U2, companyId: 'c', now: at(6000) });
    await expect(recoverGlobalLink(db, { playerId: 'P1', operator: 'ops', reason: '  ' })).rejects.toThrow(/reason/);
    expect(await recoverGlobalLink(db, { playerId: 'P1', operator: 'ops', reason: 'owner lost the Discord account' })).toMatchObject({ discordUserId: U2 });
    expect(await actions(db, '*')).toContain('link.recovered');
    expect(await recoverGlobalLink(db, { playerId: 'P1', operator: 'ops', reason: 'again' })).toBeNull();
  });
  it('forced links: refuse to break a proven link; replace an unproven one', async () => {
    const db = await freshDb(); await addGuild(db, G1); await addGuild(db, G2);
    await claimLink(db, { guildId: G2, discordUserId: U2, playerId: 'P5', username: 'a', direct: true });
    expect(await forceLink(db, { guildId: G1, adminId: 'adm', discordUserId: U1, playerId: 'P5', username: 'a' })).toEqual({ ok: false, code: 'CONFLICT_REQUIRES_REPLACE' });
    const ok = await forceLink(db, { guildId: G1, adminId: 'adm', discordUserId: U1, playerId: 'P5', username: 'a', replace: true });
    expect(ok).toMatchObject({ ok: true, displaced: [{ discordUserId: U2 }] });
    expect(await getGlobalLinkForPlayer(db, 'P5')).toMatchObject({ discordUserId: U1, method: 'admin_forced' });
    const a = await open(db, U3, 'P6', G1, at(0)); await ready(db, a.attemptId, U3, at(1000)); await completeVerification(db, { attemptId: a.attemptId, discordUserId: U3, companyId: 'c', now: at(1000) });
    expect(await forceLink(db, { guildId: G2, adminId: 'adm', discordUserId: U1, playerId: 'P6', username: 'a', replace: true })).toEqual({ ok: false, code: 'GLOBAL_CONFLICT' });
  });
});

describe('verification statistics', () => {
  it('counts attempts and linked members by method, and lists recent attempts without codes', async () => {
    const db = await freshDb(); await addGuild(db, G1);
    const a = await open(db, U1, 'P1'); await ready(db, a.attemptId, U1, at(1000)); await completeVerification(db, { attemptId: a.attemptId, discordUserId: U1, companyId: 'c', now: at(1000) });
    await open(db, U2, 'P2', G1, at(2000));
    const s = await verificationStats(db, G1, at(3000));
    expect(s.last30d).toMatchObject({ verified: 1, pending: 1 }); expect(s.linkedMembers).toEqual({ total: 1, byMethod: { company_verified: 1 } });
    expect(s.recent.length).toBe(2); expect(JSON.stringify(s)).not.toMatch(/code_hash|codeHash/);
  });
});
