import { describe, expect, it } from 'vitest';
import { addAdminRole, removeAdminRole, updateGuildSettings } from '@aon/db';
import { handleCommand } from '../src/handlers.js';
import { botSetup as setup, inv } from './bot-harness.js';

const send = async (h: Awaited<ReturnType<typeof setup>>, o: Parameters<typeof inv>[0]) => { const c = inv(o); await handleCommand(h.deps, c.i); return c; };
const TRUSTED = '555000111'; const OTHER = '555000999';
const allowed = (c: { last(): { content: string } }) => !c.last().content.includes('Manage Server');          // reached the command body (this harness has no Discord publisher, so the body ends in "could not post")

describe('trusted bot-administrator roles in slash commands', () => {
  it('a member holding a trusted role may use admin commands WITHOUT Manage Server; others still may not', async () => {
    const h = await setup(); await updateGuildSettings(h.db, 'A', { verification_channel_id: null }, null);
    await addAdminRole(h.db, { guildId: 'A', roleId: TRUSTED, actor: 'owner' });
    expect(allowed(await send(h, { group: 'admin', sub: 'verify-panel', roles: [TRUSTED] }))).toBe(true);
    expect((await send(h, { group: 'admin', sub: 'verify-panel', roles: [OTHER] })).last().content).toContain('Manage Server');                           // refused
    expect((await send(h, { group: 'admin', sub: 'verify-panel', roles: [] })).last().content).toContain('Manage Server');
    expect(allowed(await send(h, { group: 'admin', sub: 'verify-panel', admin: true }))).toBe(true);
  });
  it('removing the role takes effect immediately; a role trusted in ANOTHER server grants nothing here; DMs are never trusted', async () => {
    const h = await setup(); await addAdminRole(h.db, { guildId: 'A', roleId: TRUSTED, actor: null });
    expect(allowed(await send(h, { group: 'admin', sub: 'verify-panel', roles: [TRUSTED] }))).toBe(true);
    await removeAdminRole(h.db, { guildId: 'A', roleId: TRUSTED, actor: null });
    expect((await send(h, { group: 'admin', sub: 'verify-panel', roles: [TRUSTED] })).last().content).toContain('Manage Server');
    const h2 = await setup({ guilds: ['A', 'B'] }); await addAdminRole(h2.db, { guildId: 'B', roleId: TRUSTED, actor: null });
    expect((await send(h2, { group: 'admin', sub: 'verify-panel', roles: [TRUSTED] })).last().content).toContain('Manage Server');
  });
  it('a trusted role grants bot commands only: the message names what is needed, and the Discord permission itself is never implied', async () => {
    const h = await setup(); await addAdminRole(h.db, { guildId: 'A', roleId: TRUSTED, actor: null });
    const c = await send(h, { group: 'admin', sub: 'verify-panel', roles: [OTHER] }); expect(c.last().content).toMatch(/trusted bot-administrator role/);
  });
});
