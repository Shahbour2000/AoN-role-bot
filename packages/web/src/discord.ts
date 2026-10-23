/** Ports to Discord's HTTP API. The real implementations use fetch; tests inject fakes. */
export interface DiscordUser { id: string; username: string; avatar: string | null }
export interface DiscordGuildInfo { id: string; name: string; icon: string | null; owner: boolean; permissions: string }
export interface DiscordRole { id: string; name: string; position: number; managed: boolean; color: number; permissions: string }

export class DiscordAuthError extends Error { constructor(readonly status: number) { super(`discord auth error ${status}`); } }

export interface DiscordOAuth {
  authorizeUrl(a: { state: string; challenge: string }): string;
  exchangeCode(code: string, verifier: string): Promise<{ accessToken: string }>;
  fetchUser(accessToken: string): Promise<DiscordUser>;
  fetchGuilds(accessToken: string): Promise<DiscordGuildInfo[]>;
}
export interface DiscordBotRest {
  /** null = could not be read (bot not in guild / missing access / API down). */
  listRoles(guildId: string): Promise<DiscordRole[] | null>;
  botTopRolePosition(guildId: string): Promise<number | null>;
}

const API = 'https://discord.com/api/v10';

export function createDiscordOAuth(o: { clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: typeof fetch }): DiscordOAuth {
  const f = o.fetchImpl ?? fetch;
  const get = async <T>(path: string, token: string): Promise<T> => {
    const r = await f(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) throw new DiscordAuthError(r.status);
    if (!r.ok) throw new Error(`discord http ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    authorizeUrl: ({ state, challenge }) => `https://discord.com/oauth2/authorize?${new URLSearchParams({
      client_id: o.clientId, response_type: 'code', redirect_uri: o.redirectUri, scope: 'identify guilds', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none',
    })}`,
    async exchangeCode(code, verifier) {
      const r = await f(`${API}/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'authorization_code', code, redirect_uri: o.redirectUri, code_verifier: verifier }),
      });
      if (!r.ok) throw new DiscordAuthError(r.status);
      const j = (await r.json()) as { access_token?: unknown };
      if (typeof j.access_token !== 'string') throw new DiscordAuthError(502);
      return { accessToken: j.access_token };
    },
    fetchUser: (t) => get<DiscordUser>('/users/@me', t),
    fetchGuilds: (t) => get<DiscordGuildInfo[]>('/users/@me/guilds', t),
  };
}

export function createDiscordBotRest(o: { botToken: string; clientId: string; fetchImpl?: typeof fetch }): DiscordBotRest {
  const f = o.fetchImpl ?? fetch;
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await f(`${API}${path}`, { headers: { authorization: `Bot ${o.botToken}` }, signal: AbortSignal.timeout(10_000) });
      return r.ok ? ((await r.json()) as T) : null;
    } catch { return null; }
  };
  return {
    listRoles: (g) => get<DiscordRole[]>(`/guilds/${g}/roles`),
    async botTopRolePosition(g) {
      const [roles, me] = await Promise.all([get<DiscordRole[]>(`/guilds/${g}/roles`), get<{ roles: string[] }>(`/guilds/${g}/members/${o.clientId}`)]);
      if (!roles || !me) return null;
      const mine = new Set(me.roles);
      return roles.filter((r) => mine.has(r.id)).reduce((hi, r) => Math.max(hi, r.position), 0);
    },
  };
}
