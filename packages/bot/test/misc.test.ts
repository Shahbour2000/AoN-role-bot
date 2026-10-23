import { describe, expect, it } from 'vitest';

import { AR_KEYS, MESSAGE_KEYS, buildCommands, loadConfig, t } from '../src/index.js';

describe('messages', () => {
  it('Arabic has every English key (no untranslated strings) and placeholders match', () => {
    expect(AR_KEYS.sort()).toEqual([...MESSAGE_KEYS].sort());
    for (const k of MESSAGE_KEYS) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(t('ar', k))).toBe(ph(t('en', k)));
    }
  });
});

describe('command definitions', () => {
  const cmds = buildCommands();
  it('exposes /link, /unlink, /link-status, /profile, /sync me|all, /force link and the admin tools', () => {
    const flat = cmds.flatMap((c) => { const subs = (c.options ?? []).filter((o) => o.type === 1); return subs.length ? subs.map((o) => `${c.name} ${o.name}`) : [c.name]; });
    expect(flat).toEqual(expect.arrayContaining(['link', 'unlink', 'link-status', 'profile', 'sync me', 'sync all', 'force link', 'admin pending', 'admin approve', 'admin reject', 'admin unlink', 'admin diagnostics', 'help']));
    expect(flat).not.toContain('link me');
  });
  it('/link takes the game username (required); /profile takes an optional member and a private flag', () => {
    const link = cmds.find((c) => c.name === 'link')!; expect(link.options).toHaveLength(1); expect(link.options![0]).toMatchObject({ name: 'username', required: true, max_length: 40 });
    const profile = cmds.find((c) => c.name === 'profile')!; expect(profile.options!.map((o) => [o.name, o.required ?? false])).toEqual([['user', false], ['private', false]]);
  });
  it('every definition respects Discord\'s rules (names, lengths, counts, uniqueness) so registration cannot be rejected', () => {
    const names = new Set<string>();
    for (const c of cmds) {
      expect(c.name, c.name).toMatch(/^[\w-]{1,32}$/); expect(c.name).toBe(c.name.toLowerCase()); expect(names.has(c.name)).toBe(false); names.add(c.name);
      expect(c.description.length, c.name).toBeGreaterThan(0); expect(c.description.length).toBeLessThanOrEqual(100);
      const walk = (opts: { name: string; description: string; options?: unknown[] }[] | undefined, depth: number) => {
        expect((opts ?? []).length).toBeLessThanOrEqual(25); expect(depth).toBeLessThanOrEqual(3);
        const seen = new Set<string>();
        for (const o of opts ?? []) { expect(o.name).toMatch(/^[\w-]{1,32}$/); expect(o.description.length).toBeGreaterThan(0); expect(o.description.length).toBeLessThanOrEqual(100); expect(seen.has(o.name)).toBe(false); seen.add(o.name); walk(o.options as never, depth + 1); }
      };
      walk(c.options as never, 1);
    }
    expect(cmds.length).toBeLessThanOrEqual(100);
  });
  it('the bot asks for no extra Discord permissions through its command defaults (moderator commands need Manage Server)', () => {
    for (const n of ['force', 'admin']) expect(cmds.find((c) => c.name === n)!.default_member_permissions).toBeTruthy();
    for (const n of ['link', 'unlink', 'link-status', 'profile', 'help']) expect(cmds.find((c) => c.name === n)!.default_member_permissions ?? null).toBeNull();
  });
  it('moderator commands are hidden from regular members and disabled in DMs', () => {
    for (const n of ['force', 'admin']) { const c = cmds.find((x) => x.name === n)!; expect(c.default_member_permissions).toBeTruthy(); expect(c.dm_permission).toBe(false); }
  });
});

describe('config', () => {
  it('lists every problem without echoing values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required[\s\S]*DISCORD_BOT_TOKEN is required[\s\S]*DISCORD_CLIENT_ID is required/);
    let msg = ''; try { loadConfig({ DATABASE_URL: 'postgres://u:SECRETPW@h/db', DISCORD_BOT_TOKEN: 'TOKENVALUE', DISCORD_CLIENT_ID: '1', AON_API_BASE_URL: 'http://insecure' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/must be https/); expect(msg).not.toMatch(/SECRETPW|TOKENVALUE/);
  });
  it('accepts a valid config with the production API default', () => {
    expect(loadConfig({ DATABASE_URL: 'x', DISCORD_BOT_TOKEN: 'y', DISCORD_CLIENT_ID: '1' }).apiBaseUrl).toBe('https://app.ageofnations.world/api/v1');
  });
});
