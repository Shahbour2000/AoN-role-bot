import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CountryReservedError, IncompatibleMappingsError, addRoleMapping, getCountryReservation, getGuildConfig, isCountryReservedByOther, listRoleMappings, migrate, releaseCountry, updateGuildSettings } from '../src/index.js';
import { MIGRATIONS_DIR, addGuild, emptyDb, freshDb } from './helpers.js';

const A = '100000000000000001', B = '100000000000000002', C = '100000000000000003';
const role = (n: number) => `9000000000000000${String(n).padStart(2, '0')}`;
const countryGuild = async (db: Awaited<ReturnType<typeof freshDb>>, id: string, country: string | null = null) => {
  await addGuild(db, id); await updateGuildSettings(db, id, { community_type: 'country', ...(country ? { country_id: country } : {}) }, 'u');
};
const count = async (db: Awaited<ReturnType<typeof freshDb>>) => Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM country_reservations')).rows[0]!.n);
const auditActions = async (db: Awaited<ReturnType<typeof freshDb>>, g: string) => (await db.query<{ action: string }>('SELECT action FROM audit_events WHERE guild_id=$1 ORDER BY id', [g])).rows.map((r) => r.action);

describe('country reservation (database-enforced)', () => {
  it('a country server reserves its country; the reservation is readable and audited', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg');
    expect((await getCountryReservation(db, A))?.countryId).toBe('eg'); expect(await count(db)).toBe(1);
    expect(await auditActions(db, A)).toContain('country.reserved');
  });
  it('a second server cannot claim the same country (also case-insensitively), and nothing is saved for it', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg'); await countryGuild(db, B);
    await expect(updateGuildSettings(db, B, { country_id: 'eg' }, 'u')).rejects.toBeInstanceOf(CountryReservedError);
    await expect(updateGuildSettings(db, B, { country_id: 'EG' }, 'u')).rejects.toBeInstanceOf(CountryReservedError);
    expect((await getGuildConfig(db, B))?.countryId).toBeNull(); expect(await count(db)).toBe(1);
    expect(await isCountryReservedByOther(db, B, 'eg')).toBe(true); expect(await isCountryReservedByOther(db, A, 'eg')).toBe(false);
  });
  it('the whole update is atomic: a conflicting claim also rolls back the other fields and writes no audit row', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg'); await countryGuild(db, B); const before = await auditActions(db, B);
    await expect(updateGuildSettings(db, B, { country_id: 'eg', language: 'en', demotion_mode: 'never' }, 'u')).rejects.toBeInstanceOf(CountryReservedError);
    const c = await getGuildConfig(db, B); expect(c?.language).toBe('ar'); expect(c?.demotion.mode).toBe('immediate'); expect(await auditActions(db, B)).toEqual(before);
  });
  it('a server holds ONE country: changing it releases the old one (free again) and reserves the new one', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg'); await countryGuild(db, B);
    await updateGuildSettings(db, A, { country_id: 'pl' }, 'u'); expect((await getCountryReservation(db, A))?.countryId).toBe('pl'); expect(await count(db)).toBe(1);
    await updateGuildSettings(db, B, { country_id: 'eg' }, 'u'); expect((await getCountryReservation(db, B))?.countryId).toBe('eg'); expect(await count(db)).toBe(2);
    await expect(updateGuildSettings(db, B, { country_id: 'pl' }, 'u')).rejects.toBeInstanceOf(CountryReservedError);
    expect((await getCountryReservation(db, B))?.countryId).toBe('eg');                      // the failed claim did not cost B its country
  });
  it('only COUNTRY servers reserve: party/unit/general servers can store the same country id as a lookup filter, and leaving the country type releases it', async () => {
    const db = await freshDb(); await addGuild(db, C); await updateGuildSettings(db, C, { community_type: 'party', country_id: 'eg' }, 'u'); expect(await count(db)).toBe(0);
    await countryGuild(db, A, 'eg'); expect(await count(db)).toBe(1);
    await updateGuildSettings(db, A, { community_type: 'military_unit' }, 'u'); expect(await getCountryReservation(db, A)).toBeNull();     // released, country_id itself preserved
    expect((await getGuildConfig(db, A))?.countryId).toBe('eg');
    await countryGuild(db, B, 'eg');                                                                                                         // now free for a real country server
    await expect(updateGuildSettings(db, A, { community_type: 'country' }, 'u')).rejects.toBeInstanceOf(CountryReservedError);              // and A cannot take it back
    expect((await getGuildConfig(db, A))?.communityType).toBe('military_unit');
  });
  it('the database itself rejects a bypass (raw SQL), so no application path can double-claim', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg'); await countryGuild(db, B);
    await expect(db.query(`UPDATE guilds SET country_id='eg' WHERE guild_id=$1`, [B])).rejects.toThrow(/country_already_reserved/);
    await expect(db.query(`INSERT INTO country_reservations (guild_id, country_id) VALUES ($1,'EG')`, [B])).rejects.toThrow();
    await expect(db.query(`INSERT INTO country_reservations (guild_id, country_id) VALUES ($1,'pl'),($1,'de')`, [A])).rejects.toThrow();     // one country per server
    expect(await count(db)).toBe(1);
  });
  it('concurrent claims of ONE country by many servers: exactly one wins', async () => {
    const db = await freshDb(); const ids = Array.from({ length: 8 }, (_, i) => `1000000000000001${i}0`);
    for (const g of ids) await countryGuild(db, g);
    const res = await Promise.allSettled(ids.map((g) => updateGuildSettings(db, g, { country_id: 'eg' }, 'u')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(CountryReservedError);
    expect(await count(db)).toBe(1);
    const winners = (await db.query<{ guild_id: string }>(`SELECT guild_id FROM guilds WHERE country_id='eg'`)).rows; expect(winners).toHaveLength(1);
  });
  it('concurrent claims of different countries all succeed, and a mixed storm never leaves two holders of one country', async () => {
    const db = await freshDb(); const ids = Array.from({ length: 6 }, (_, i) => `1000000000000002${i}0`); for (const g of ids) await countryGuild(db, g);
    await Promise.all(ids.map((g, i) => updateGuildSettings(db, g, { country_id: `c${i}` }, 'u'))); expect(await count(db)).toBe(6);
    await Promise.allSettled(ids.map((g, i) => updateGuildSettings(db, g, { country_id: `c${(i + 1) % 6}` }, 'u')));   // everyone tries to take their neighbour's country
    const dup = (await db.query(`SELECT lower(country_id) FROM country_reservations GROUP BY 1 HAVING count(*) > 1`)).rows; expect(dup).toHaveLength(0);
    const mism = (await db.query(`SELECT g.guild_id FROM guilds g JOIN country_reservations r USING (guild_id) WHERE lower(g.country_id) <> lower(r.country_id)`)).rows; expect(mism).toHaveLength(0);
  });
  it('release is the explicit, audited unlink: it frees the country for others and never touches another server', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg'); await countryGuild(db, B, 'pl');
    expect(await releaseCountry(db, A, 'admin1')).toBe(true);
    expect((await getGuildConfig(db, A))?.countryId).toBeNull(); expect(await getCountryReservation(db, A)).toBeNull(); expect((await getCountryReservation(db, B))?.countryId).toBe('pl');
    expect(await auditActions(db, A)).toContain('country.released');
    expect(await releaseCountry(db, A, 'admin1')).toBe(false);                                // nothing to release
    await countryGuild(db, C, 'eg'); expect((await getCountryReservation(db, C))?.countryId).toBe('eg');
  });
  it('removing a server frees its country', async () => {
    const db = await freshDb(); await countryGuild(db, A, 'eg'); await db.query('DELETE FROM guilds WHERE guild_id=$1', [A]); expect(await count(db)).toBe(0);
    await countryGuild(db, B, 'eg'); expect(await count(db)).toBe(1);
  });
});

describe('migration 0008 on existing data', () => {
  it('keeps every existing server unchanged; the OLDEST of several servers sharing a country holds it; others are not cut off but cannot re-claim', async () => {
    const db = await emptyDb(); const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x < '0008')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    await migrate(db, dir);                                                                           // the schema as deployed before this release
    const ins = (id: string, type: string, country: string | null, at: string) => db.query(`INSERT INTO guilds (guild_id, name, community_type, country_id, created_at) VALUES ($1,$1,$2,$3,$4)`, [id, type, country, at]);
    await ins(B, 'country', 'eg', '2026-02-01T00:00:00Z'); await ins(A, 'country', 'eg', '2026-01-01T00:00:00Z'); await ins(C, 'party', 'eg', '2026-03-01T00:00:00Z');
    await ins('100000000000000004', 'country', null, '2026-04-01T00:00:00Z'); await ins('100000000000000005', 'country', 'PL', '2026-04-02T00:00:00Z');
    expect((await migrate(db, MIGRATIONS_DIR)).applied).toEqual(expect.arrayContaining(['0008_country_reservation.sql']));
    expect((await getCountryReservation(db, A))?.countryId).toBe('eg'); expect(await getCountryReservation(db, B)).toBeNull(); expect(await getCountryReservation(db, C)).toBeNull();
    expect((await getCountryReservation(db, '100000000000000005'))?.countryId).toBe('PL'); expect(await count(db)).toBe(2);
    for (const g of [A, B, C]) expect((await getGuildConfig(db, g))?.countryId).toBe('eg');          // nothing deleted or rewritten
    expect(await isCountryReservedByOther(db, B, 'eg')).toBe(true);                                   // so the dashboard can warn B
    await updateGuildSettings(db, B, { country_id: 'eg', language: 'ar' }, 'u');                      // an unchanged country in a normal save keeps working
    await expect(updateGuildSettings(db, B, { country_id: 'PL' }, 'u')).rejects.toBeInstanceOf(CountryReservedError);
    await updateGuildSettings(db, B, { country_id: 'de' }, 'u'); expect((await getCountryReservation(db, B))?.countryId).toBe('de');
  });
  it('re-running migrations is a no-op', async () => { const db = await freshDb(); expect((await migrate(db, MIGRATIONS_DIR)).applied).toEqual([]); });
});

describe('server type change protects role mappings', () => {
  const setup = async () => {
    const db = await freshDb(); await addGuild(db, A); await updateGuildSettings(db, A, { community_type: 'country', country_id: 'eg' }, 'u');
    for (const [i, k] of (['president', 'citizen', 'party_member', 'unit_leader'] as const).entries()) expect((await addRoleMapping(db, { guildId: A, kind: k, discordRoleId: role(i + 1), actor: 'u' })).ok).toBe(true);
    await db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ($1,'build_war','',$2),($1,'alliance_member','',$3)`, [A, role(20), role(21)]);
    return db;
  };
  const kinds = async (db: Awaited<ReturnType<typeof freshDb>>) => (await listRoleMappings(db, A)).map((m) => m.kind).sort();
  it('an unconfirmed change that would orphan mappings is refused with the exact list, and NOTHING changes', async () => {
    const db = await setup(); const before = await kinds(db);
    const err = await updateGuildSettings(db, A, { community_type: 'party', language: 'en' }, 'u').catch((e) => e);
    expect(err).toBeInstanceOf(IncompatibleMappingsError); expect((err as IncompatibleMappingsError).mappings.map((m) => m.kind).sort()).toEqual(['citizen', 'president', 'unit_leader']);
    expect(await kinds(db)).toEqual(before); const c = await getGuildConfig(db, A); expect(c?.communityType).toBe('country'); expect(c?.language).toBe('ar');
  });
  it('a confirmed change removes exactly the incompatible mappings in the same transaction and audits it; compatible, build-role and legacy alliance mappings stay', async () => {
    const db = await setup();
    const r = await updateGuildSettings(db, A, { community_type: 'party' }, 'u', new Date(), { confirmRemoveIncompatible: true });
    expect(r.removedMappings.map((m) => m.kind).sort()).toEqual(['citizen', 'president', 'unit_leader']);
    expect(await kinds(db)).toEqual(['alliance_member', 'build_war', 'party_member']); expect((await getGuildConfig(db, A))?.communityType).toBe('party');
    expect(await auditActions(db, A)).toContain('mapping.removed_by_type_change');
  });
  it('a change that orphans nothing needs no confirmation (and general accepts every kind); same-type saves never touch mappings', async () => {
    const db = await setup(); const before = await kinds(db);
    await updateGuildSettings(db, A, { community_type: 'general' }, 'u'); expect(await kinds(db)).toEqual(before);
    await updateGuildSettings(db, A, { community_type: 'general', language: 'ar' }, 'u'); expect(await kinds(db)).toEqual(before);
  });
  it('leaving the country type with a confirmed change also releases the reservation atomically; a refused change keeps it', async () => {
    const db = await setup();
    await expect(updateGuildSettings(db, A, { community_type: 'military_unit' }, 'u')).rejects.toBeInstanceOf(IncompatibleMappingsError); expect((await getCountryReservation(db, A))?.countryId).toBe('eg');
    await updateGuildSettings(db, A, { community_type: 'military_unit' }, 'u', new Date(), { confirmRemoveIncompatible: true }); expect(await getCountryReservation(db, A)).toBeNull();
  });
});
