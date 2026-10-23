export interface WebConfig {
  appBaseUrl: string; clientId: string; clientSecret: string; redirectUri: string; sessionSecret: string; botToken: string;
  secureCookies: boolean; sessionTtlMs: number; trustProxy: boolean;
}
/** Fails fast listing every problem; never echoes secret values. */
export function loadWebConfig(env: Record<string, string | undefined>): WebConfig {
  const problems: string[] = [];
  for (const k of ['APP_BASE_URL', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET', 'DISCORD_BOT_TOKEN']) if (!env[k]) problems.push(`${k} is required`);
  let secure = true, base = env['APP_BASE_URL'] ?? '';
  try {
    const u = new URL(base); base = u.origin;
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !local) problems.push('APP_BASE_URL must be https (http is allowed only for localhost)');
    secure = u.protocol === 'https:';
  } catch { if (env['APP_BASE_URL']) problems.push('APP_BASE_URL is not a valid URL'); }
  if (env['SESSION_SECRET'] && env['SESSION_SECRET'].length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (problems.length) throw new Error(`Invalid web configuration:\n - ${problems.join('\n - ')}`);
  return {
    appBaseUrl: base, clientId: env['DISCORD_CLIENT_ID']!, clientSecret: env['DISCORD_CLIENT_SECRET']!, sessionSecret: env['SESSION_SECRET']!, botToken: env['DISCORD_BOT_TOKEN']!,
    redirectUri: env['DISCORD_OAUTH_REDIRECT_URI'] ?? `${base}/auth/callback`, secureCookies: secure,
    sessionTtlMs: Number(env['SESSION_TTL_HOURS'] ?? 6) * 3_600_000, trustProxy: env['TRUST_PROXY'] === 'true',
  };
}
