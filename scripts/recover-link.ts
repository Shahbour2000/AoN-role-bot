/**
 * OPERATOR-ONLY recovery of a global Discord <-> Age of Nations link (lost Discord account, hijacked claim, wrong person verified).
 * It ends the link in EVERY server, so it is deliberately not a Discord command and not part of the dashboard: only someone with the
 * database URL can run it. A reason is mandatory and the action is audited (action `link.recovered`, guild `*`).
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/recover-link.ts <gamePlayerId> "<reason>" [operatorName]
 *
 * It prints, per server, the roles the bot had granted; they are removed at the next synchronisation of the member's NEW link, or by hand.
 */
import { createPgDb, recoverGlobalLink } from '@aon/db';

const [playerId, reason, operator = 'cli'] = process.argv.slice(2);
const url = process.env['DATABASE_URL'];
if (!url || !playerId || !reason) { console.error('usage: DATABASE_URL=... npx tsx scripts/recover-link.ts <gamePlayerId> "<reason>" [operator]'); process.exit(2); }
const db = createPgDb(url, { max: 1, ssl: process.env['DATABASE_SSL'] === 'true' });
try {
  const r = await recoverGlobalLink(db, { playerId, operator, reason });
  console.log(r ? `Unlinked game account ${r.playerId} from Discord user ${r.discordUserId} (${r.method}) in ${r.guilds.length} server(s):\n${r.guilds.map((g) => `  ${g.guildId}: roles granted by the bot: ${g.managedRoleIds.join(', ') || 'none'}`).join('\n')}` : `No active global link for ${playerId}.`);
} finally { await db.close(); }
