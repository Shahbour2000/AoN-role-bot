import { PGlite } from '@electric-sql/pglite';
import { cpSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/index.js';
import { MIGRATIONS_DIR, freshDb } from './helpers.js';

describe('migrations', () => {
  it('apply cleanly and are idempotent on restart', async () => {
    const pg = new PGlite();
    const db = { query: async (s: string, p?: unknown[]) => ({ rows: (p === undefined ? (await pg.exec(s)).at(-1)?.rows : (await pg.query(s, p)).rows) ?? [] }) as never,
      tx: async <T>(fn: (d: never) => Promise<T>) => pg.transaction(async (t) => fn({ query: async (s: string, p?: unknown[]) => ({ rows: (p === undefined ? (await t.exec(s)).at(-1)?.rows : (await t.query(s, p)).rows) ?? [] }), tx: async (f: (d: never) => Promise<unknown>) => f(undefined as never) } as never)) };
    const first = await migrate(db as never, MIGRATIONS_DIR);
    expect(first.applied).toEqual(['0001_init.sql', '0002_government_role_kind.sql', '0003_rank_enabled_arabic_default.sql', '0004_dashboard_sessions.sql', '0005_durable_schedule.sql', '0006_linking_party_roles_unit_options.sql', '0007_player_build_roles.sql', '0008_country_reservation.sql', '0009_global_links_verification.sql', '0010_verification_panel.sql', '0011_proxy_identity_trusted_admins.sql', '0012_country_entity_roles.sql', '0013_unverified_role.sql']);
    const second = await migrate(db as never, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0001_init.sql', '0002_government_role_kind.sql', '0003_rank_enabled_arabic_default.sql', '0004_dashboard_sessions.sql', '0005_durable_schedule.sql', '0006_linking_party_roles_unit_options.sql', '0007_player_build_roles.sql', '0008_country_reservation.sql', '0009_global_links_verification.sql', '0010_verification_panel.sql', '0011_proxy_identity_trusted_admins.sql', '0012_country_entity_roles.sql', '0013_unverified_role.sql']);
  });
  it('aborts if an applied migration file was edited (no silent drift)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const pg = new PGlite();
    const mk = (x: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => x;
    const run = (c: typeof pg | Parameters<Parameters<typeof pg.transaction>[0]>[0]) => mk({ query: async (s, p) => ({ rows: (p === undefined ? (await c.exec(s)).at(-1)?.rows : (await c.query(s, p)).rows) ?? [] }) });
    const db = { ...run(pg), tx: async <T>(fn: (d: never) => Promise<T>) => pg.transaction(async (t) => fn({ ...run(t), tx: async (f: (d: never) => Promise<unknown>) => f(undefined as never) } as never)) };
    await migrate(db as never, dir);
    writeFileSync(join(dir, '0001_init.sql'), readFileSync(join(dir, '0001_init.sql'), 'utf8') + '\n-- tampered');
    await expect(migrate(db as never, dir)).rejects.toThrow(/modified after being applied/);
  });
  it('fresh helper DB has the expected tables', async () => {
    const db = await freshDb();
    const { rows } = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['guilds', 'account_links', 'role_mappings', 'custom_rules', 'military_ranks', 'sync_jobs', 'audit_events', 'schema_migrations']));
  });
});

describe('upgrading an existing database to the durable schedule (migration 0005)', () => {
  it('maps old free-form intervals to 3/6/12/24 h, schedules enabled guilds, keeps data, and is not re-applied', async () => {
    const { emptyDb } = await import('./helpers.js');
    const { readdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'mig-old-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^000[1-4]_/.test(x))) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const db = await emptyDb();
    expect((await migrate(db, dir)).applied).toHaveLength(4);                       // the schema as it was before this feature
    const ins = (id: string, enabled: boolean, minutes: number) => db.query(`INSERT INTO guilds (guild_id, auto_sync_enabled, sync_interval_minutes) VALUES ($1,$2,$3)`, [id, enabled, minutes]);
    await ins('g90', true, 90); await ins('g360', true, 360); await ins('g1000', true, 1000); await ins('g45off', false, 45); await ins('g30', true, 30); await ins('g10080', true, 10080);
    await db.query(`INSERT INTO sync_jobs (guild_id, kind, status) VALUES ('g90','all','succeeded')`);
    const res = await migrate(db, MIGRATIONS_DIR);
    expect(res.applied).toEqual(['0005_durable_schedule.sql', '0006_linking_party_roles_unit_options.sql', '0007_player_build_roles.sql', '0008_country_reservation.sql', '0009_global_links_verification.sql', '0010_verification_panel.sql', '0011_proxy_identity_trusted_admins.sql', '0012_country_entity_roles.sql', '0013_unverified_role.sql']);
    const rows = (await db.query<{ guild_id: string; sync_interval_minutes: number; auto_sync_enabled: boolean; next_sync_at: Date | null }>('SELECT guild_id, sync_interval_minutes, auto_sync_enabled, next_sync_at FROM guilds ORDER BY guild_id')).rows;
    const by = Object.fromEntries(rows.map((r) => [r.guild_id, r]));
    expect(rows.map((r) => [r.guild_id, r.sync_interval_minutes])).toEqual([['g1000', 1440], ['g10080', 1440], ['g30', 180], ['g360', 360], ['g45off', 180], ['g90', 180]]);
    for (const g of ['g90', 'g360', 'g1000', 'g30', 'g10080']) { expect(by[g]!.next_sync_at, g).not.toBeNull(); expect(new Date(by[g]!.next_sync_at!).getTime()).toBeGreaterThan(Date.now()); }
    expect(by['g45off']!.next_sync_at).toBeNull();                                  // disabled guilds stay unscheduled
    expect((await db.query<{ details: object }>(`SELECT details FROM sync_jobs WHERE guild_id='g90'`)).rows[0]!.details).toEqual({});   // old jobs gain an empty details column
    expect((await migrate(db, MIGRATIONS_DIR)).applied).toEqual([]);                // idempotent on the next start
  });
});

describe('upgrading to migration 0012 (country entity roles) keeps every existing row', () => {
  it('legacy general party/unit member rows, shared kinds and proxy rows survive unchanged; the old indexes are replaced by the narrower ones', async () => {
    const { emptyDb } = await import('./helpers.js');
    const { readdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'mig-0012-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^(000[1-9]|001[01])_/.test(x))) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const db = await emptyDb();
    expect((await migrate(db, dir)).applied).toHaveLength(11);                       // the schema exactly as Delivery B shipped it
    await db.query(`INSERT INTO guilds (guild_id, community_type, country_id) VALUES ('g1','country','eg')`);
    const ins = (kind: string, ref: string, role: string) => db.query(`INSERT INTO role_mappings (guild_id, kind, game_ref, discord_role_id) VALUES ('g1',$1,$2,$3)`, [kind, ref, role]);
    await ins('country_party_member', '', '100001'); await ins('country_unit_member', '', '100002'); await ins('country_party_president', '', '100003');
    await ins('country_unit_leader', '', '100004'); await ins('country_unit_owner', '', '100005'); await ins('proxy_citizen', 'sd', '100006'); await ins('citizen', '', '100007');
    const before = (await db.query<{ kind: string; game_ref: string; discord_role_id: string }>('SELECT kind, game_ref, discord_role_id FROM role_mappings ORDER BY kind')).rows;
    expect((await migrate(db, MIGRATIONS_DIR)).applied).toEqual(['0012_country_entity_roles.sql', '0013_unverified_role.sql']);
    expect((await db.query<{ kind: string; game_ref: string; discord_role_id: string }>('SELECT kind, game_ref, discord_role_id FROM role_mappings ORDER BY kind')).rows).toEqual(before);   // nothing changed or deleted
    // new rules: proxy roles may share the citizen role and each other; entity membership rows need an entity id; one row per entity; shared kinds stay single
    await ins('proxy_citizen', 'ly', '100007'); await ins('proxy_citizen', 'ye', '100007');
    await expect(ins('country_party_member', '', '100099')).rejects.toThrow(/unique|check|violat/i);     // a second legacy-style row / empty reference is refused
    await ins('country_party_member', 'p1', '100010'); await ins('country_party_member', 'p2', '100011');
    await expect(ins('country_party_member', 'p1', '100012')).rejects.toThrow(/unique|duplicate/i);
    await expect(ins('country_unit_leader', '', '100013')).rejects.toThrow(/unique|duplicate/i);
    await expect(ins('country_unit_member', 'u1', '100010')).rejects.toThrow(/unique|duplicate/i);       // an identity role is never reused by another identity role
  });
});

describe('upgrading to migration 0013 (optional Unverified role) changes nothing for existing servers', () => {
  it('every existing guild gets the feature DISABLED with no role; the checks refuse an enabled setting without a role and a malformed role id', async () => {
    const { emptyDb } = await import('./helpers.js'); const { readdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'mig-0013-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^(000[1-9]|001[0-2])_/.test(x))) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const db = await emptyDb(); expect((await migrate(db, dir)).applied).toHaveLength(12);
    await db.query(`INSERT INTO guilds (guild_id, community_type) VALUES ('g1','country'), ('g2','general')`);
    expect((await migrate(db, MIGRATIONS_DIR)).applied).toEqual(['0013_unverified_role.sql']);
    expect((await db.query('SELECT guild_id, unverified_role_enabled AS e, unverified_role_id AS r FROM guilds ORDER BY guild_id')).rows).toEqual([{ guild_id: 'g1', e: false, r: null }, { guild_id: 'g2', e: false, r: null }]);
    await expect(db.query(`UPDATE guilds SET unverified_role_enabled=true WHERE guild_id='g1'`)).rejects.toThrow(/check|violat/i);
    await expect(db.query(`UPDATE guilds SET unverified_role_id='abc' WHERE guild_id='g1'`)).rejects.toThrow(/check|violat/i);
    await db.query(`UPDATE guilds SET unverified_role_enabled=true, unverified_role_id='123456' WHERE guild_id='g1'`);
  });
});
