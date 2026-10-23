import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKS } from '@aon/core';
import { extractProfileCard, extractStatsCard } from '@aon/client';
import { claimLink, findLinkForUser, forceLink, listLinks, saveLadder, updateGuildSettings } from '@aon/db';
import { profileAbuDujana, statsAbuDujana } from '../../aon-client/test/fixtures.js';
import { handleButton, handleCommand, validateEmbed } from '../src/index.js';
import { ROLE, botSetup, click, inv, player, rosterOf } from './bot-harness.js';
import { addRoleMapping } from '@aon/db';

const confirmId = (r: { buttons?: { id: string }[] }) => r.buttons!.find((b) => b.id.startsWith('lc:') || b.id.startsWith('fl:'))!.id;

describe('/link — direct mode (the default for new servers)', () => {
  it('previews the resolved player; only Confirm links, immediately, and the roles are refreshed at once', async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    await addRoleMapping(h.db, { guildId: 'A', kind: 'president', discordRoleId: ROLE.pres, actor: null });
    h.discord.give('A', 'u1'); h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }, { userId: 'p9', role: 'congress' }]);
    const c = inv({ str: { username: 'Alpha' } });
    await handleCommand(h.deps, c.i);
    expect(c.last().content).toContain('Alpha'); expect(c.last().content).toContain('p1');
    expect(await findLinkForUser(h.db, 'A', 'u1')).toBeNull();                         // nothing stored before confirmation
    const k = click(confirmId(c.last())); await handleButton(h.deps, k.b);
    expect(await findLinkForUser(h.db, 'A', 'u1')).toMatchObject({ playerId: 'p1', status: 'verified' });
    expect(k.last().content).toContain('does not prove');                              // the limitation is stated to the user
    expect(k.last().content).toContain(ROLE.pres);                                      // role granted right after linking
    expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true);
    expect((await listLinks(h.db, 'A', 'verified'))[0]).toMatchObject({ method: 'self_direct', discord_user_id: 'u1' });   // Discord user ID is the identity
  });
  it('someone else cannot press my confirm button; cancel stores nothing', async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = inv({ str: { username: 'Alpha' } }); await handleCommand(h.deps, c.i);
    const k = click(confirmId(c.last()), { userId: 'intruder' }); await handleButton(h.deps, k.b);
    expect(k.last().content).toMatch(/not for you/); expect(await listLinks(h.db, 'A')).toHaveLength(0);
    const x = click(c.last().buttons!.find((b) => b.id.startsWith('lx:'))!.id); await handleButton(h.deps, x.b);
    expect(await listLinks(h.db, 'A')).toHaveLength(0);
  });
  it('unknown player and API trouble give DISTINCT messages and store nothing; trouble never means "player does not exist"', async () => {
    const h = await botSetup();
    const a = inv({ str: { username: 'ghost' } }); await handleCommand(h.deps, a.i);
    expect(a.last().content).toMatch(/No Age of Nations player/);
    for (const st of [{ status: 'rate_limited' as const, retryAfterMs: 5 }, { status: 'error' as const, message: 'HTTP 500' }, { status: 'incomplete' as const, missing: ['id'] }]) {
      h.game.names.set('x', st); const b = inv({ str: { username: 'x' }, userId: `u${st.status}` }); await handleCommand(h.deps, b.i);
      expect(b.last().content).toMatch(/temporarily unavailable/); expect(b.last().content).not.toMatch(/No Age of Nations player/);
    }
    expect(await listLinks(h.db, 'A')).toHaveLength(0);
  });
  it('already linked: must /unlink first; a game account already linked to another member is refused with guidance', async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha')); h.game.names.set('beta', player('p2', 'Beta'));
    const link = async (u: string, name: string) => { const c = inv({ userId: u, str: { username: name } }); await handleCommand(h.deps, c.i); if (!c.last().buttons) return c.last().content; const k = click(confirmId(c.last()), { userId: u }); await handleButton(h.deps, k.b); return k.last().content; };
    expect(await link('u1', 'Alpha')).toContain('Linked to');
    expect(await link('u1', 'Beta')).toMatch(/already linked in this server/);
    expect(await link('u2', 'Alpha')).toMatch(/already linked to another member[\s\S]*moderator/);
    expect(await findLinkForUser(h.db, 'A', 'u2')).toBeNull();
  });
  it('the game username is escaped in replies (no markdown or mention injection)', async () => {
    const h = await botSetup(); h.game.names.set('evil', player('p6', '**@everyone** _x_'));
    const c = inv({ str: { username: 'evil' } }); await handleCommand(h.deps, c.i);
    expect(c.last().content).not.toContain('@everyone'); expect(c.last().content).toContain('\\*\\*');
  });
  it('is guild-only; new servers reply in Arabic by default', async () => {
    const h = await botSetup({ guilds: [] });
    const g = inv({ guildId: null }); await handleCommand(h.deps, g.i); expect(g.last().content).toMatch(/inside a server/);
    const c = inv({ guildId: 'FRESH', group: 'link-status' }); await handleCommand(h.deps, c.i);
    expect(c.last().content).toMatch(/لا يوجد حساب مرتبط/);
    const { getLadder, getGuildConfig } = await import('@aon/db');
    expect(await getGuildConfig(h.db, 'FRESH')).toMatchObject({ language: 'ar', linkMode: 'direct' }); expect((await getGuildConfig(h.db, 'FRESH'))!.modules.ranks).toBe(false);
    expect(await getLadder(h.db, 'FRESH')).toEqual([]);                                  // the optional rank system starts empty/off
  });
  it('Arabic servers get Arabic replies', async () => {
    const h = await botSetup(); await updateGuildSettings(h.db, 'A', { language: 'ar' }, null);
    const c = inv({ str: { username: 'ghost' } }); await handleCommand(h.deps, c.i);
    expect(c.last().content).toMatch(/لم يتم العثور/);
  });
  it('a pluggable ownership verifier can veto a link (future stronger verification) without touching the link tables', async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const seen: string[] = [];
    const deps = { ...h.deps, verifier: { id: 'challenge', async verify(c: { playerId: string }) { seen.push(c.playerId); return { ok: false as const, reason: 'challenge not found on profile' }; } } };
    const c = inv({ str: { username: 'Alpha' } }); await handleCommand(deps, c.i);
    const k = click(confirmId(c.last())); await handleButton(deps, k.b);
    expect(seen).toEqual(['p1']); expect(k.last().content).toContain('challenge not found on profile'); expect(await listLinks(h.db, 'A')).toHaveLength(0);
  });
});

describe('/link — staff-approval mode (optional per server)', () => {
  it('Confirm creates a PENDING claim that grants nothing until a moderator approves', async () => {
    const h = await botSetup({ staff: true }); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = inv({ str: { username: 'Alpha' } }); await handleCommand(h.deps, c.i);
    const k = click(confirmId(c.last())); await handleButton(h.deps, k.b);
    expect(k.last().content).toMatch(/moderator must approve/); expect((await findLinkForUser(h.db, 'A', 'u1'))?.status).toBe('pending');
  });
  it('a second claimant on the same account is told it is flagged for review', async () => {
    const h = await botSetup({ staff: true }); h.game.names.set('alpha', player('p1', 'Alpha'));
    for (const u of ['u1', 'u2']) {
      const c = inv({ userId: u, str: { username: 'Alpha' } }); await handleCommand(h.deps, c.i);
      const k = click(confirmId(c.last()), { userId: u }); await handleButton(h.deps, k.b);
      if (u === 'u2') expect(k.last().content).toMatch(/another member also claimed/);
    }
  });
});

describe('/unlink', () => {
  const linked = async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    await addRoleMapping(h.db, { guildId: 'A', kind: 'president', discordRoleId: ROLE.pres, actor: null });
    h.discord.give('A', 'u1', 'UNRELATED'); h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }, { userId: 'p9', role: 'congress' }]);
    const c = inv({ str: { username: 'Alpha' } }); await handleCommand(h.deps, c.i); await handleButton(h.deps, click(confirmId(c.last())).b);
    return h;
  };
  it('asks for confirmation, removes the link and ONLY the roles the bot granted, keeps unrelated roles, allows re-linking', async () => {
    const h = await linked(); expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true);
    const c = inv({ group: 'unlink' }); await handleCommand(h.deps, c.i); expect(c.last().content).toContain('Unlink');
    expect(await findLinkForUser(h.db, 'A', 'u1')).not.toBeNull();                     // nothing happens before confirmation
    const k = click(c.last().buttons![0]!.id); await handleButton(h.deps, k.b);
    expect(k.last().content).toMatch(/Roles removed: 1/);
    expect(await findLinkForUser(h.db, 'A', 'u1')).toBeNull(); expect([...h.discord.has('A', 'u1')]).toEqual(['UNRELATED']);
    const again = inv({ str: { username: 'Alpha' } }); await handleCommand(h.deps, again.i);
    await handleButton(h.deps, click(confirmId(again.last())).b); expect(await findLinkForUser(h.db, 'A', 'u1')).not.toBeNull();
  });
  it('someone else cannot confirm; nothing to unlink is reported; cancel keeps the link', async () => {
    const h = await linked(); const c = inv({ group: 'unlink' }); await handleCommand(h.deps, c.i);
    const intruder = click(c.last().buttons![0]!.id, { userId: 'intruder' }); await handleButton(h.deps, intruder.b);
    expect(intruder.last().content).toMatch(/not for you/); expect(await findLinkForUser(h.db, 'A', 'u1')).not.toBeNull();
    await handleButton(h.deps, click(c.last().buttons![1]!.id).b); expect(await findLinkForUser(h.db, 'A', 'u1')).not.toBeNull();
    const none = inv({ group: 'unlink', userId: 'nobody' }); await handleCommand(h.deps, none.i); expect(none.last().content).toMatch(/no linked account/);
  });
  it('a role the bot is not allowed to manage is never touched during unlink cleanup', async () => {
    const h = await linked(); h.discord.assignable = new Set();                        // hierarchy changed: bot can manage nothing now
    const c = inv({ group: 'unlink' }); await handleCommand(h.deps, c.i); await handleButton(h.deps, click(c.last().buttons![0]!.id).b);
    expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true); expect(await findLinkForUser(h.db, 'A', 'u1')).toBeNull();
  });
});

describe('/link-status', () => {
  it('shows none / linked with the player id', async () => {
    const h = await botSetup();
    const a = inv({ group: 'link-status' }); await handleCommand(h.deps, a.i); expect(a.last().content).toMatch(/no linked account/);
    await forceLink(h.db, { guildId: 'A', adminId: 'm', discordUserId: 'u1', playerId: 'p1', username: 'Alpha' });
    const b = inv({ group: 'link-status' }); await handleCommand(h.deps, b.i); expect(b.last().content).toContain('p1');
  });
});

describe('temporary failures never delete a link', () => {
  it('/sync me, /profile and /sync all with a failing game API leave the stored link (and roles) untouched', async () => {
    const h = await botSetup(); await forceLink(h.db, { guildId: 'A', adminId: 'm', discordUserId: 'u1', playerId: 'p1', username: 'Alpha' });
    await addRoleMapping(h.db, { guildId: 'A', kind: 'president', discordRoleId: ROLE.pres, actor: null }); h.discord.give('A', 'u1', ROLE.pres);
    h.game.roster = { status: 'error', message: 'HTTP 503' };
    h.game.cards.set('p1', { profile: { status: 'error', message: 'HTTP 503' }, stats: { status: 'error', message: 'x' } });
    await handleCommand(h.deps, inv({ group: 'sync', sub: 'me' }).i);
    const p = inv({ group: 'profile' }); await handleCommand(h.deps, p.i); expect(p.last().content).toMatch(/temporarily unavailable/);
    await handleCommand(h.deps, inv({ group: 'sync', sub: 'all', admin: true, userId: 'mod' }).i);
    expect(await findLinkForUser(h.db, 'A', 'u1')).toMatchObject({ playerId: 'p1', status: 'admin_linked' }); expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true);
  });
});

describe('/profile', () => {
  const goodCard = () => ({ profile: extractProfileCard({ status: 'ok', data: profileAbuDujana }), stats: extractStatsCard({ status: 'ok', data: statsAbuDujana }) });
  const withLink = async (opts: { ranks?: boolean } = {}) => {
    const h = await botSetup(); await forceLink(h.db, { guildId: 'A', adminId: 'm', discordUserId: 'u1', playerId: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana' });
    h.game.cards.set('usr_r9s8exrd8arivqrq', goodCard());
    if (opts.ranks) { await updateGuildSettings(h.db, 'A', { modules: { government: true, party: true, unit: true, alliance: false, ranks: true } }, null); await saveLadder(h.db, 'A', DEFAULT_RANKS.map((r) => ({ ...r })), null); }
    return h;
  };
  const embedOf = (c: ReturnType<typeof inv>) => c.last().embed!;
  it('shows a designed card for the caller: name, avatar, country, level/XP, damage, periods, offices, party, unit, activity', async () => {
    const h = await withLink(); const c = inv({ group: 'profile' }); await handleCommand(h.deps, c.i);
    const e = embedOf(c);
    expect(e.title).toContain('AbuDujana'); expect(e.thumbnail!.url).toBe('https://app.ageofnations.world/media/8d126155650a12155d333ec5.gif'); expect(validateEmbed(e)).toEqual([]);
    const f = Object.fromEntries(e.fields!.map((x) => [x.name, x.value]));
    expect(f['🌍 Country']).toContain('eg'); expect(f['⭐ Level']).toContain('17'); expect(f['⚔️ Total damage']).toBe('649,601');
    expect(f['📅 Recent damage']).toContain('625,446'); expect(f['🏛️ Government']).toContain('Vice President'); expect(f['🎖️ Party']).toContain('Leader'); expect(f['🛡️ Military unit']).toContain('Commander');
    expect(f['📊 Activity']).toContain('7,354'); expect(Object.keys(f).some((k) => k.includes('Military rank'))).toBe(false);   // rank system off => no rank
  });
  it('works with the military system disabled, and shows the rank + progress when it is enabled (per server)', async () => {
    const on = await withLink({ ranks: true }); const c = inv({ group: 'profile' }); await handleCommand(on.deps, c.i);
    const rank = embedOf(c).fields!.find((x) => x.name.includes('Military rank'))!;
    expect(rank.value).toContain('**Warrant Officer**'); expect(rank.value).toMatch(/▰+▱+/); expect(rank.value).toContain('Chief Warrant Officer');   // 649,601 is between 400,000 and 700,000
    await updateGuildSettings(on.db, 'A', { modules: { government: true, party: true, unit: true, alliance: false, ranks: false } }, null);
    const d = inv({ group: 'profile', userId: 'u1' }); await handleCommand(on.deps, d.i);
    expect(embedOf(d).fields!.some((x) => x.name.includes('Military rank'))).toBe(false);
  });
  it('uses the server language (Arabic labels) and respects the private option for visibility', async () => {
    const h = await withLink(); await updateGuildSettings(h.db, 'A', { language: 'ar' }, null);
    const c = inv({ group: 'profile' }); await handleCommand(h.deps, c.i);
    expect(embedOf(c).fields!.map((x) => x.name).join(' ')).toContain('الدولة'); expect(c.deferred).toEqual([{ public: true }]);
    const p = inv({ group: 'profile', bool: { private: true } }); await handleCommand(h.deps, p.i); expect(p.deferred).toEqual([{ public: false }]);
  });
  it('can show another linked member; reports a member without a link; asks the caller to link when not linked', async () => {
    const h = await withLink();
    const other = inv({ group: 'profile', userId: 'u2', user: { user: 'u1' } }); await handleCommand(h.deps, other.i); expect(embedOf(other).title).toContain('AbuDujana');
    const none = inv({ group: 'profile', userId: 'u2', user: { user: 'u9' } }); await handleCommand(h.deps, none.i); expect(none.last().content).toMatch(/<@u9> has no linked account/); expect(none.last().embed).toBeUndefined();
    const me = inv({ group: 'profile', userId: 'u2' }); await handleCommand(h.deps, me.i); expect(me.last().content).toMatch(/`\/link username:/);
    expect(none.deferred).toEqual([]);                                              // errors are private replies (no public defer)
  });
  it('a pending link (staff mode) cannot show a card yet', async () => {
    const h = await botSetup({ staff: true }); await claimLink(h.db, { guildId: 'A', discordUserId: 'u1', playerId: 'p1', username: 'x' });
    const c = inv({ group: 'profile' }); await handleCommand(h.deps, c.i); expect(c.last().content).toMatch(/waiting for moderator approval/); expect(h.game.cardRequests).toBe(0);
  });
  it('optional data missing: the card still renders and simply leaves those fields out', async () => {
    const h = await withLink();
    h.game.cards.set('usr_r9s8exrd8arivqrq', { profile: extractProfileCard({ status: 'ok', data: { id: 'usr_r9s8exrd8arivqrq', username: 'Minimal', damage: { total: 'x' } } }), stats: { status: 'error', message: 'HTTP 500' } });
    const c = inv({ group: 'profile' }); await handleCommand(h.deps, c.i);
    const e = embedOf(c); expect(e.title).toContain('Minimal'); expect(validateEmbed(e)).toEqual([]); expect(e.fields ?? []).toEqual([]); expect(e.description).toMatch(/No further data/);
  });
  it('stats failing but profile ok: partial card, not an error', async () => {
    const h = await withLink(); h.game.cards.set('usr_r9s8exrd8arivqrq', { profile: extractProfileCard({ status: 'ok', data: profileAbuDujana }), stats: { status: 'rate_limited', retryAfterMs: 5 } });
    const c = inv({ group: 'profile' }); await handleCommand(h.deps, c.i);
    const names = embedOf(c).fields!.map((x) => x.name); expect(names).toContain('⚔️ Total damage'); expect(names.some((n) => n.includes('Activity'))).toBe(false);
  });
  it('API failure => clear message; deleted/unknown player => message that says the link was kept (never deletes the link)', async () => {
    const h = await withLink();
    h.game.cards.set('usr_r9s8exrd8arivqrq', { profile: { status: 'rate_limited', retryAfterMs: 5 }, stats: { status: 'rate_limited', retryAfterMs: 5 } });
    const a = inv({ group: 'profile' }); await handleCommand(h.deps, a.i); expect(a.last().content).toMatch(/temporarily unavailable/);
    h.game.cards.set('usr_r9s8exrd8arivqrq', { profile: { status: 'not_found' }, stats: { status: 'not_found' } });
    const b = inv({ group: 'profile', userId: 'u1' }); await handleCommand(h.deps, b.i); expect(b.last().content).toMatch(/link was kept/);
    expect(await findLinkForUser(h.db, 'A', 'u1')).not.toBeNull();
  });
  it('is rate-limited per user (the game API budget is shared)', async () => {
    const h = await withLink(); const deps = { ...h.deps, cooldownMs: 60_000 };
    await forceLink(h.db, { guildId: 'A', adminId: 'm', discordUserId: 'ucool', playerId: 'usr_r9s8exrd8arivqrq2', username: 'C' }); h.game.cards.set('usr_r9s8exrd8arivqrq2', goodCard());
    const a = inv({ group: 'profile', userId: 'ucool' }); await handleCommand(deps, a.i); expect(a.last().embed).toBeDefined();
    const b = inv({ group: 'profile', userId: 'ucool' }); await handleCommand(deps, b.i); expect(b.last().content).toMatch(/wait a few seconds/); expect(h.game.cardRequests).toBe(1);
  });
});

describe('server-side permission enforcement', () => {
  const adminCmds: [string, string][] = [['sync', 'all'], ['force', 'link'], ['admin', 'pending'], ['admin', 'approve'], ['admin', 'reject'], ['admin', 'unlink'], ['admin', 'diagnostics']];
  it.each(adminCmds)('/%s %s refuses a non-admin and changes nothing', async (group, sub) => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = inv({ group, sub, admin: false, user: { user: 'u2' }, str: { player: 'Alpha' } });
    await handleCommand(h.deps, c.i);
    expect(c.last().content).toMatch(/Manage Server/);
    expect(await listLinks(h.db, 'A')).toHaveLength(0);
    expect(h.discord.calls).toEqual([]);
  });
  it('a force-link confirm button re-checks permission at click time', async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = inv({ group: 'force', sub: 'link', admin: true, userId: 'adm', user: { user: 'u2' }, str: { player: 'Alpha' } });
    await handleCommand(h.deps, c.i);
    const k = click(confirmId(c.last()), { userId: 'adm', admin: false }); // admin lost the permission meanwhile
    await handleButton(h.deps, k.b);
    expect(k.last().content).toMatch(/Manage Server/);
    expect(await listLinks(h.db, 'A')).toHaveLength(0);
  });
});

describe('moderation workflow', () => {
  it('approve -> /sync me grants the office role; unapproved claims cannot sync (staff-approval mode)', async () => {
    const h = await botSetup({ staff: true }); h.game.names.set('alpha', player('p1', 'Alpha'));
    await addRoleMapping(h.db, { guildId: 'A', kind: 'president', discordRoleId: ROLE.pres, actor: null });
    h.discord.give('A', 'u1'); h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    const c = inv({ str: { username: 'Alpha' } }); await handleCommand(h.deps, c.i);
    await handleButton(h.deps, click(confirmId(c.last())).b);

    const early = inv({ group: 'sync', sub: 'me' }); await handleCommand(h.deps, early.i);
    expect(early.last().content).toMatch(/waiting for moderator approval/);
    expect(h.discord.has('A', 'u1').size).toBe(0);

    const list = inv({ group: 'admin', sub: 'pending', admin: true, userId: 'mod' }); await handleCommand(h.deps, list.i);
    expect(list.last().content).toContain('Alpha');
    const ap = inv({ group: 'admin', sub: 'approve', admin: true, userId: 'mod', user: { user: 'u1' } }); await handleCommand(h.deps, ap.i);
    expect(ap.last().content).toBe('Approved.');

    const s = inv({ group: 'sync', sub: 'me' }); await handleCommand(h.deps, s.i);
    expect(s.last().content).toContain(ROLE.pres);
    expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true);
  });
  it('/sync me explains API trouble without touching roles', async () => {
    const h = await botSetup();
    await addRoleMapping(h.db, { guildId: 'A', kind: 'president', discordRoleId: ROLE.pres, actor: null });
    h.discord.give('A', 'u1', ROLE.pres); h.game.roster = { status: 'rate_limited', retryAfterMs: 9 };
    await (await import('@aon/db')).forceLink(h.db, { guildId: 'A', adminId: 'm', discordUserId: 'u1', playerId: 'p1', username: 'p1' });
    const s = inv({ group: 'sync', sub: 'me' }); await handleCommand(h.deps, s.i);
    expect(s.last().content).toMatch(/No roles were changed/);
    expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true);
  });
  it('/force link needs confirmation, then links as admin_linked; conflicts require replace', async () => {
    const h = await botSetup(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const run = async (replace?: boolean) => {
      const c = inv({ group: 'force', sub: 'link', admin: true, userId: 'adm', user: { user: 'u2' }, str: { player: 'Alpha', reason: 'vc check' }, ...(replace ? { bool: { replace: true } } : {}) });
      await handleCommand(h.deps, c.i);
      const k = click(confirmId(c.last()), { userId: 'adm', admin: true }); await handleButton(h.deps, k.b); return k.last().content;
    };
    expect(await run()).toMatch(/admin-linked/);
    expect((await findLinkForUser(h.db, 'A', 'u2'))?.status).toBe('admin_linked');
    h.game.names.set('beta', player('p2', 'Beta'));
    const c2 = inv({ group: 'force', sub: 'link', admin: true, userId: 'adm', user: { user: 'u2' }, str: { player: 'Beta' } });
    await handleCommand(h.deps, c2.i);
    const k2 = click(confirmId(c2.last()), { userId: 'adm', admin: true }); await handleButton(h.deps, k2.b);
    expect(k2.last().content).toMatch(/replace: true/);
  });
  it('/sync all reports the summary and refuses a concurrent run', async () => {
    const h = await botSetup();
    await addRoleMapping(h.db, { guildId: 'A', kind: 'president', discordRoleId: ROLE.pres, actor: null });
    const { forceLink } = await import('@aon/db');
    await forceLink(h.db, { guildId: 'A', adminId: 'm', discordUserId: 'u1', playerId: 'p1', username: null }); h.discord.give('A', 'u1');
    h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
    const c = inv({ group: 'sync', sub: 'all', admin: true, userId: 'mod' }); await handleCommand(h.deps, c.i);
    expect(c.last().content).toMatch(/Server sync succeeded\. Total 1 · updated 1/);
    const { startSyncJob } = await import('@aon/db');
    await startSyncJob(h.db, { guildId: 'A', kind: 'all', requestedBy: null });
    const d = inv({ group: 'sync', sub: 'all', admin: true, userId: 'mod' }); await handleCommand(h.deps, d.i);
    expect(d.last().content).toMatch(/already running/);
  });
  it('expired / unknown confirmation tokens are rejected', async () => {
    const h = await botSetup(); const k = click('lc:deadbeef'); await handleButton(h.deps, k.b);
    expect(k.last().content).toMatch(/expired/);
  });
  it('installing in a guild does NOT create military ranks (the system is optional and off until an admin enables it)', async () => {
    const h = await botSetup({ guilds: [] });
    await handleCommand(h.deps, inv({ group: 'link-status', guildId: 'NEW' }).i);
    const { getLadder } = await import('@aon/db');
    expect(await getLadder(h.db, 'NEW')).toEqual([]);
  });
});
