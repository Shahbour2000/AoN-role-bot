import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { AonClient } from '@aon/client';
import { createPgDb, migrate, recoverStaleJobs } from '@aon/db';
import { syncGuild } from '@aon/sync';
import { buildApp, createDiscordBotRest, createDiscordOAuth, loadWebConfig } from '@aon/web';
import { purgeExpiredSessions } from '@aon/db';
import { buildCommands } from './commands.js';
import { loadConfig } from './config.js';
import { DiscordJsGateway } from './discord-gateway.js';
import { handleButton, handleCommand, onGuildInstalled, type BotDeps } from './handlers.js';
import { toButtonInvocation, toInvocation } from './interactions.js';
import { startScheduler } from './scheduler.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const cfg = loadConfig(process.env);
  const db = createPgDb(cfg.databaseUrl, { ssl: cfg.dbSsl });
  // Forward-only, checksummed migrations. There is deliberately no reset / db-push path at startup.
  const m = await migrate(db, fileURLToPath(new URL('../../db/migrations', import.meta.url)));
  log(`migrations applied: ${m.applied.length ? m.applied.join(', ') : 'none (up to date)'}`);
  log(`recovered ${await recoverStaleJobs(db)} interrupted sync job(s) (their guilds are rescheduled immediately)`);

  const game = new AonClient({ baseUrl: cfg.apiBaseUrl });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });   // no privileged intents required
  const discord = new DiscordJsGateway(client);
  const deps: BotDeps = { db, game, discord, httpStats: () => ({ ...game.http.stats }), log, ...(cfg.mediaBaseUrl ? { mediaBaseUrl: cfg.mediaBaseUrl } : {}) };

  client.on(Events.GuildCreate, (g) => { onGuildInstalled(db, g.id, g.name).catch((e) => log(`guildCreate failed: ${e instanceof Error ? e.message : e}`)); });
  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isChatInputCommand()) await handleCommand(deps, toInvocation(i));
      else if (i.isButton()) await handleButton(deps, toButtonInvocation(i));
    } catch (e) {
      log(`interaction error: ${e instanceof Error ? e.message : 'unknown'}`);                 // details stay in logs, not in chat
      if (i.isRepliable()) await (i.deferred || i.replied ? i.editReply({ content: 'Something went wrong. Nothing was changed.' }) : i.reply({ content: 'Something went wrong. Nothing was changed.', ephemeral: true })).catch(() => undefined);
    }
  });

  const rest = new REST().setToken(cfg.discordToken);
  const body = buildCommands();
  await rest.put(cfg.devGuildId ? Routes.applicationGuildCommands(cfg.clientId, cfg.devGuildId) : Routes.applicationCommands(cfg.clientId), { body });
  log(`registered ${body.length} commands ${cfg.devGuildId ? '(dev guild)' : '(global)'}`);

  await client.login(cfg.discordToken);
  const scheduler = startScheduler(db, (guildId) => syncGuild({ db, game, discord, log }, { guildId, kind: 'scheduled', requestedBy: null }), log);

  const health = async () => ({ database: await db.ping(), discord: client.isReady(), gameApi: { ...game.http.stats } as Record<string, number | null> });
  const webConfigured = ['APP_BASE_URL', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'].every((k) => !!process.env[k]);
  let closeHttp: () => Promise<void>;
  let purge: NodeJS.Timeout | undefined;
  if (webConfigured) {
    const web = loadWebConfig(process.env);                       // throws a precise, secret-free message if misconfigured
    const app = await buildApp({
      db, cfg: web, oauth: createDiscordOAuth({ clientId: web.clientId, clientSecret: web.clientSecret, redirectUri: web.redirectUri }),
      botRest: createDiscordBotRest({ botToken: web.botToken, clientId: web.clientId }), game,
      runSync: (guildId, actorId) => syncGuild({ db, game, discord, log }, { guildId, kind: 'all', requestedBy: actorId }),
      onUnlinked: async (guildId, userId, roleIds) => { const ok = await discord.assignableRoles(guildId); for (const r of roleIds) if (ok.has(r)) await discord.removeRole(guildId, userId, r, 'AoN role bot: account unlinked').catch(() => undefined); },
      health, log, publicDir: fileURLToPath(new URL('../../web/public', import.meta.url)),
    });
    await app.listen({ port: cfg.port, host: '0.0.0.0' });
    log(`dashboard + health on :${cfg.port} (${web.appBaseUrl})`);
    purge = setInterval(() => { purgeExpiredSessions(db, new Date()).catch(() => undefined); }, 3_600_000); purge.unref();
    closeHttp = () => app.close();
  } else {
    log('dashboard disabled (APP_BASE_URL / DISCORD_CLIENT_SECRET / SESSION_SECRET not set); health endpoint only');
    const http = createServer(async (req, res) => {
      if (req.url === '/healthz') { const h = await health(); res.writeHead(h.database && h.discord ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ discord: h.discord, database: h.database })); }
      else { res.writeHead(404).end(); }
    }).listen(cfg.port, () => log(`health endpoint on :${cfg.port}`));
    closeHttp = () => new Promise<void>((r) => { http.close(() => r()); });
  }

  const shutdown = async () => { log('shutting down'); scheduler.stop(); if (purge) clearInterval(purge); await closeHttp(); await client.destroy(); await db.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
