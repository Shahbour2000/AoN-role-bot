import { describe, expect, it } from 'vitest';
import { addRoleMapping, claimLink, findLinkForUser, getGlobalLinkForPlayer, getGlobalLinkForUser, updateGuildSettings } from '@aon/db';
import { AR_KEYS, MESSAGE_KEYS, handleButton, handleCommand, handleModal } from '../src/index.js';
import { ROLE, botSetup, click, inv, player, rosterOf, verifyViaTicket } from './bot-harness.js';

const setupPres = async (guilds = ['A']) => {
  const h = await botSetup({ guilds });
  for (const g of guilds) await addRoleMapping(h.db, { guildId: g, kind: 'president', discordRoleId: ROLE.pres, actor: null });
  h.game.roster = rosterOf('eg', [{ userId: 'p1', role: 'president' }]);
  return h;
};
const send = async (h: Awaited<ReturnType<typeof setupPres>>, o: Parameters<typeof inv>[0]) => { const c = inv(o); await handleCommand(h.deps, c.i); return c; };
const press = async (h: Awaited<ReturnType<typeof setupPres>>, id: string, o: Parameters<typeof click>[1] = {}) => { const k = click(id, o); await handleButton(h.deps, k.b); return k.last(); };

describe('verification ticket: the happy path', () => {
  it('shows a one-time code, verifies against the real company data, links globally and syncs roles at once', async () => {
    const h = await setupPres(); h.discord.give('A', 'u1');
    const { code, result, ticket } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    expect(code).toMatch(/^AON-[2-9A-HJKMNP-Z]{10}$/); expect(ticket.buttons!.map((b) => b.id.slice(0, 2))).toEqual(['vc', 'vn', 'vx']);
    expect(result.content).toContain('Verified'); expect(h.game.companyCalls).toBe(1);
    expect(await getGlobalLinkForPlayer(h.db, 'p1')).toMatchObject({ discordUserId: 'u1', method: 'company_verified' });
    expect((await findLinkForUser(h.db, 'A', 'u1'))?.status).toBe('verified');
    expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(true);
    const stored = JSON.stringify((await h.db.query('SELECT * FROM verification_attempts')).rows); expect(stored).not.toContain(code.slice(4));   // never stored
  });
  it('the ticket is a private (ephemeral) message flow; the code is not logged in the audit trail', async () => {
    const h = await setupPres(); const { code } = await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    const a = JSON.stringify((await h.db.query('SELECT * FROM audit_events')).rows); expect(a).not.toContain(code.slice(4)); expect(a).toContain('verification.verified');
  });
});

describe('verification ticket: failures and attacks', () => {
  it('code not in any company -> clear retry message; typed names/codes are not proof; API trouble costs no check', async () => {
    const h = await setupPres(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = await send(h, { group: 'verify', str: { username: 'Alpha' } });
    const id = c.last().buttons![0]!.id;
    expect(await press(h, id)).toMatchObject({ content: expect.stringContaining('could not find the code') });
    expect(await getGlobalLinkForUser(h.db, 'u1')).toBeNull();
    h.game.companies.set('p1', { status: 'error', message: 'down' } as never);
    h.deps.now = () => new Date(Date.now() + 60_000);
    expect((await press(h, id)).content).toContain('temporarily unavailable');
    h.game.companies.set('p1', { status: 'incomplete', missing: ['companies[0].name'] });
    h.deps.now = () => new Date(Date.now() + 120_000);
    expect((await press(h, id)).content).toContain('could not read safely');
    expect(JSON.stringify((await h.db.query(`SELECT details FROM audit_events WHERE action='verification.api_incomplete'`)).rows)).toContain('companies[0].name');
    const row = (await h.db.query<{ check_count: number }>('SELECT check_count FROM verification_attempts')).rows[0]!; expect(row.check_count).toBe(1);
    const typed = await send(h, { group: 'verify', str: { username: 'AON-AAAAAAAAAA' }, userId: 'u9' }); expect(typed.last().content).toMatch(/No Age of Nations player/);
  });
  it('a code that belongs to someone else\'s ticket never verifies, even if it is on the right company', async () => {
    const h = await setupPres();
    await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha', userId: 'u1', guildId: 'A' });            // legit owner verified; the code may stay visible in the game for a while
    const owner = h.game.companies.get('p1')!;
    h.game.names.set('alpha', player('p1', 'Alpha'));
    const thief = await send(h, { group: 'verify', userId: 'u2', str: { username: 'Alpha' } });
    expect(thief.last().content).toContain('already linked to another Discord account');                   // a proven link is not displaceable
    expect(owner.status).toBe('ok');
  });
  it('another member cannot use / close / refresh somebody else\'s ticket buttons', async () => {
    const h = await setupPres(); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = await send(h, { group: 'verify', str: { username: 'Alpha' } });
    for (const b of c.last().buttons!) expect((await press(h, b.id, { userId: 'intruder' })).content).toContain('no longer active');
    expect(await getGlobalLinkForUser(h.db, 'u1')).toBeNull();
    expect(h.game.companyCalls).toBe(0);
  });
  it('expires after 30 minutes; checks are spaced; closing works; "New code" invalidates the old code', async () => {
    const h = await setupPres(); let t = Date.now() + 3_600_000; h.deps.now = () => new Date(t);
    h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = await send(h, { group: 'verify', str: { username: 'Alpha' } });
    const oldCode = /`(AON-[A-Z0-9]{10})`/.exec(c.last().content)![1]!;
    const [check, again, close] = c.last().buttons!.map((b) => b.id);
    t += 1000; await press(h, check!); t += 2000; expect((await press(h, check!)).content).toMatch(/wait \d+ more seconds/);
    t += 60_000; const fresh = await press(h, again!);
    const newCodeText = /`(AON-[A-Z0-9]{10})`/.exec(fresh.content)![1]!; expect(newCodeText).not.toBe(oldCode);
    h.game.companies.set('p1', { status: 'ok', data: { companies: [{ id: 'c1', name: `X ${oldCode}` }] } });
    t += 60_000; expect((await press(h, check!)).content).toContain('no longer active');                // old ticket buttons are dead
    const newId = fresh.buttons![0]!.id;
    t += 60_000; expect((await press(h, newId)).content).toContain('could not find the code');          // the OLD code does not satisfy the NEW attempt
    t += 31 * 60_000; expect((await press(h, newId)).content).toContain('expired');
    const c2 = await send(h, { group: 'verify', str: { username: 'Alpha' } }); expect((await press(h, c2.last().buttons![2]!.id)).content).toContain('Ticket closed');
    void close;
  });
  it('a game account proven by another member, or a member linked elsewhere, is refused with guidance', async () => {
    const h = await setupPres(); await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    h.game.names.set('beta', player('p2', 'Beta'));
    const c = await send(h, { group: 'verify', userId: 'u1', str: { username: 'Beta' } });
    expect(c.last().content).toContain('already verified');                                                  // u1 is already linked: no second identity
    const link = await send(h, { group: 'link', userId: 'u3', str: { username: 'Alpha' } }); expect(link.last().content).toContain('already linked to another Discord account');   // /link is an alias
  });
});

describe('one global link works in every server', () => {
  it('verified in server A, the same member gets server B roles without verifying again; /unlink removes both', async () => {
    const h = await setupPres(['A', 'B']); h.discord.give('A', 'u1'); h.discord.give('B', 'u1');
    await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha', guildId: 'A' });
    expect(await findLinkForUser(h.db, 'B', 'u1')).toBeNull(); expect(h.discord.has('B', 'u1').has(ROLE.pres)).toBe(false);
    const calls = h.game.companyCalls;
    const s = await send(h, { group: 'sync', sub: 'me', guildId: 'B' });                                       // first explicit use in B
    expect(s.last().content).toContain(ROLE.pres); expect(h.discord.has('B', 'u1').has(ROLE.pres)).toBe(true);
    expect(h.game.companyCalls).toBe(calls);                                                                   // no new ownership check
    expect((await h.db.query('SELECT 1 FROM global_links')).rows.length).toBe(1);
    const v = await send(h, { group: 'verify', guildId: 'B', str: { username: 'Alpha' } }); expect(v.last().content).toContain('already verified');
    const u = await send(h, { group: 'unlink' }); expect(u.last().content).toContain('every');
    const k = await press(h, u.last().buttons![0]!.id); expect(k.content).toMatch(/Roles removed: 2/);
    expect(h.discord.has('A', 'u1').has(ROLE.pres)).toBe(false); expect(h.discord.has('B', 'u1').has(ROLE.pres)).toBe(false);
    expect(await getGlobalLinkForUser(h.db, 'u1')).toBeNull();
  });
  it('a real proof replaces an unproven legacy claim and strips the claimant\'s roles', async () => {
    const h = await setupPres(['A', 'B']); h.discord.give('B', 'victim');
    await claimLink(h.db, { guildId: 'B', discordUserId: 'victim', playerId: 'p1', username: 'Alpha', direct: true });
    await send(h, { group: 'sync', sub: 'me', guildId: 'B', userId: 'victim' }); expect(h.discord.has('B', 'victim').has(ROLE.pres)).toBe(true);
    await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha', userId: 'owner', guildId: 'A' });
    expect(h.discord.has('B', 'victim').has(ROLE.pres)).toBe(false);
    expect(await getGlobalLinkForPlayer(h.db, 'p1')).toMatchObject({ discordUserId: 'owner', method: 'company_verified' });
  });
});

describe('panel, channel and modal', () => {
  it('/admin verify-panel: admin only, needs the configured channel, posts the panel with the open button', async () => {
    const h = await setupPres(); const posted: { g: string; ch: string; r: unknown }[] = []; h.deps.postPanel = async (g, ch, r) => { posted.push({ g, ch, r }); };
    expect((await send(h, { group: 'admin', sub: 'verify-panel', userId: 'm' })).last().content).toContain('Manage Server');
    expect((await send(h, { group: 'admin', sub: 'verify-panel', admin: true })).last().content).toContain('Choose the verification channel');
    await updateGuildSettings(h.db, 'A', { verification_channel_id: '555' }, 'u');
    expect((await send(h, { group: 'admin', sub: 'verify-panel', admin: true })).last().content).toContain('<#555>');
    expect(posted).toHaveLength(1); expect(JSON.stringify(posted[0]!.r)).toContain('vt:open');
    h.deps.postPanel = async () => { throw new Error('missing access'); };
    expect((await send(h, { group: 'admin', sub: 'verify-panel', admin: true })).last().content).toContain('could not post');
  });
  it('the panel button opens a modal for a new member; the modal submit creates the ticket; a verified member is answered privately', async () => {
    const h = await setupPres(); h.game.names.set('alpha', player('p1', 'Alpha'));
    let modal: unknown = null; const k = click('vt:open'); k.b.showModal = async (m) => { modal = m; }; await handleButton(h.deps, k.b);
    expect(modal).toMatchObject({ id: 'vm:open', fieldId: 'username', maxLength: 40 });
    const replies: { content: string }[] = [];
    await handleModal(h.deps, { guildId: 'A', userId: 'u1', customId: 'vm:open', field: () => 'Alpha', reply: async (r) => { replies.push(r); } });
    expect(replies[0]!.content).toMatch(/AON-/);
    await verifyViaTicket(h, { playerId: 'p1', username: 'Alpha' });
    const priv: { content: string }[] = []; const k2 = click('vt:open'); k2.b.reply = async (r) => { priv.push(r); }; k2.b.showModal = async () => { throw new Error('must not open a modal'); };
    await handleButton(h.deps, k2.b); expect(priv[0]!.content).toContain('already verified');
  });
});

describe('localisation', () => {
  it('Arabic has every verification message, and a server set to Arabic gets Arabic tickets', async () => {
    expect(MESSAGE_KEYS.filter((k) => !AR_KEYS.includes(k))).toEqual([]);
    const h = await setupPres(); await updateGuildSettings(h.db, 'A', { language: 'ar' }, 'u'); h.game.names.set('alpha', player('p1', 'Alpha'));
    const c = await send(h, { group: 'verify', str: { username: 'Alpha' } });
    expect(c.last().content).toContain('تذكرة التوثيق'); expect(c.last().buttons![0]!.label).toBe('تحقق من التوثيق');
  });
});
