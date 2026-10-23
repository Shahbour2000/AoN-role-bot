-- 0004: server-side dashboard sessions. The browser only holds a random token; we store its SHA-256.
CREATE TABLE dashboard_sessions (
  token_hash       text PRIMARY KEY,
  discord_user_id  text NOT NULL,
  username         text NOT NULL,
  avatar           text,
  access_token_enc text NOT NULL,          -- AES-256-GCM sealed Discord OAuth token (used to re-check guild permissions live)
  csrf_token       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX dashboard_sessions_user ON dashboard_sessions (discord_user_id);
CREATE INDEX dashboard_sessions_expiry ON dashboard_sessions (expires_at);
