export interface BotConfig { mediaBaseUrl: string | undefined; databaseUrl: string; discordToken: string; clientId: string; devGuildId: string | undefined; apiBaseUrl: string; port: number; dbSsl: boolean }

/** Fails fast with a precise list of problems; never echoes secret values. */
export function loadConfig(env: Record<string, string | undefined>): BotConfig {
  const missing = ['DATABASE_URL', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'].filter((k) => !env[k]);
  const problems = missing.map((k) => `${k} is required`);
  const api = env['AON_API_BASE_URL'] ?? 'https://app.ageofnations.world/api/v1';
  try { if (new URL(api).protocol !== 'https:') problems.push('AON_API_BASE_URL must be https'); } catch { problems.push('AON_API_BASE_URL is not a valid URL'); }
  const media = env['AON_MEDIA_BASE_URL']; if (media) { try { if (new URL(media).protocol !== 'https:') problems.push('AON_MEDIA_BASE_URL must be https'); } catch { problems.push('AON_MEDIA_BASE_URL is not a valid URL'); } }
  const port = Number(env['PORT'] ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be 1-65535');
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  return { mediaBaseUrl: env['AON_MEDIA_BASE_URL'], databaseUrl: env['DATABASE_URL']!, discordToken: env['DISCORD_BOT_TOKEN']!, clientId: env['DISCORD_CLIENT_ID']!, devGuildId: env['DISCORD_DEV_GUILD_ID'], apiBaseUrl: api, port, dbSsl: env['DATABASE_SSL'] === 'true' };
}
