import { describe, expect, it } from 'vitest';
import { beginCheck, completeVerification, createAttempt } from '@aon/db';
import { ADMIN, SEND_ONLY, get, guildInfo, login, makeApp, mut } from './harness.js';

const G1 = '100000001', G2 = '100000002';
async function ctx(perm: string = ADMIN) {
  const c = await makeApp(); const l = await login(c, '42', [guildInfo(G1, perm), guildInfo(G2, SEND_ONLY)]);
  c.bot.channels.set(G1, [{ id: '700001', name: 'verify-here', type: 0, position: 2 }, { id: '700002', name: 'voice', type: 2, position: 1 }, { id: '700003', name: 'news', type: 5, position: 3 }]);
  c.bot.channels.set(G2, [{ id: '800001', name: 'other-server', type: 0, position: 1 }]);
  return { c, l };
}

describe('force link and global links', () => {
  it('an administrator cannot force-replace a company-verified link (operator recovery only)', async () => {
    const { c, l } = await ctx(); const T = new Date(c.clock.now.getTime() + 1000);
    const a = await createAttempt(c.db, { guildId: G1, discordUserId: 'u1', playerId: 'usr_p1', username: 'Alpha', now: T }); if (!a.ok) throw new Error();
    await beginCheck(c.db, { attemptId: a.attemptId, discordUserId: 'u1', now: T });
    await completeVerification(c.db, { attemptId: a.attemptId, discordUserId: 'u1', companyId: 'c', now: T });
    const r = await mut(c, l, 'POST', `/api/guilds/${G1}/links/force`, { discordUserId: '300000000000000009', playerName: 'Alpha', replace: true });
    expect(r.statusCode).toBe(409); expect(r.json().error).toBe('global_conflict');
  });
});

describe('verification channel + statistics API', () => {
  it('lists only text/announcement channels of THIS server', async () => {
    const { c, l } = await ctx();
    const r = await get(c, l, `/api/guilds/${G1}/channels`); expect(r.statusCode).toBe(200);
    expect(r.json().channels).toEqual([{ id: '700001', name: 'verify-here' }, { id: '700003', name: 'news' }]);
    c.bot.down = true; expect((await get(c, l, `/api/guilds/${G1}/channels`)).statusCode).toBe(503);
  });
  it('saves a valid channel, rejects voice channels and channels of other servers, can clear it; changes are audited', async () => {
    const { c, l } = await ctx();
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: '700001' })).statusCode).toBe(200);
    expect((await get(c, l, `/api/guilds/${G1}/verification`)).json().channelId).toBe('700001');
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: '700002' })).json().error).toBe('invalid_channel');   // voice
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: '800001' })).json().error).toBe('invalid_channel');   // belongs to another server
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: 'abc' })).statusCode).toBe(422);
    expect((await get(c, l, `/api/guilds/${G1}/verification`)).json().channelId).toBe('700001');                                               // refusals changed nothing
    expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: null })).statusCode).toBe(200);
    expect((await get(c, l, `/api/guilds/${G1}/verification`)).json().channelId).toBeNull();
    c.bot.down = true; expect((await mut(c, l, 'PUT', `/api/guilds/${G1}/settings`, { verificationChannelId: '700001' })).statusCode).toBe(503);
  });
  it('is administrator-only and isolated per server (no access to another server\'s tickets or channels)', async () => {
    const { c, l } = await ctx();
    expect((await get(c, l, `/api/guilds/${G2}/verification`)).statusCode).toBeGreaterThanOrEqual(403);       // member without Manage Server there
    expect((await get(c, l, `/api/guilds/${G2}/channels`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await mut(c, l, 'PUT', `/api/guilds/${G2}/settings`, { verificationChannelId: '800001' })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await c.app.inject({ method: 'GET', url: `/api/guilds/${G1}/verification` })).statusCode).toBe(401);                                  // no session
    expect((await c.app.inject({ method: 'PUT', url: `/api/guilds/${G1}/settings`, cookies: l.cookies, payload: { verificationChannelId: '700001' } })).statusCode).toBeGreaterThanOrEqual(403);   // no CSRF token
  });
  it('reports only this server\'s attempts and never a code or a code hash', async () => {
    const { c, l } = await ctx(); const T = new Date(c.clock.now.getTime() + 1000);      // the session clock is fake: stay inside its lifetime
    const a = await createAttempt(c.db, { guildId: G1, discordUserId: 'u1', playerId: 'P1', username: 'Alpha', now: T }); if (!a.ok) throw new Error();
    const b = await createAttempt(c.db, { guildId: G2, discordUserId: 'u2', playerId: 'P2', username: 'Beta', now: T }); if (!b.ok) throw new Error();
    await beginCheck(c.db, { attemptId: a.attemptId, discordUserId: 'u1', now: new Date(T.getTime() + 1000) });
    await completeVerification(c.db, { attemptId: a.attemptId, discordUserId: 'u1', companyId: 'c', now: new Date(T.getTime() + 1000) });
    c.clock.now = new Date(T.getTime() + 60_000);
    const raw = await get(c, l, `/api/guilds/${G1}/verification`); const r = raw.json(); if (!r.last30d) throw new Error(raw.statusCode + ' ' + raw.body);
    expect(r.last30d).toMatchObject({ verified: 1, pending: 0 }); expect(r.recent).toHaveLength(1); expect(r.recent[0]).toMatchObject({ playerUsername: 'Alpha', status: 'verified' });
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${a.code.slice(4)}|code_?hash|Beta`, 'i'));
    expect(r.linkedMembers).toEqual({ total: 1, byMethod: { company_verified: 1 } });
  });
});
