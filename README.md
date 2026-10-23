# AoN Role Bot — Age of Nations Discord role management

A multi-server Discord bot and web dashboard that keeps Discord roles in step with the **current** data of linked Age of Nations players.
It is general-purpose: country, party, military-unit and alliance communities each configure their own server independently
(nothing about any country, party, unit or Discord role ID is hard-coded).

> **Status:** feature-complete for the current scope and tested against fakes (Discord, game API) and a real PostgreSQL server.
> It has **not** been run against real Discord or the live game API, and nothing is deployed. See [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## What it does
- **Links** a Discord account (by immutable user ID) to a game player (by stable player ID) with `/link username:<name>`.
  This proves **nothing about ownership** (the game API is read-only) — see [`docs/LINKING.md`](docs/LINKING.md).
- **Reconciles roles in both directions**: adds missing managed roles *and* removes obsolete ones; never touches unrelated roles;
  never removes anything because an API call failed or returned incomplete data — see [`docs/SYNC_AND_SCHEDULING.md`](docs/SYNC_AND_SCHEDULING.md).
- **Per-server schedule** (every 3 / 6 / 12 / 24 hours, durable in the database) plus a **Sync now** button.
- **Optional military ranks** from total damage: 17 editable starter ranks, any number of custom ranks, exclusive (one rank role at a time).
- **`/profile`** player card (Discord embed) built only from data the game API actually returns.
- **Dashboard** (Discord OAuth2, Arabic RTL + English): setup, role mappings, military ranks, players, synchronization, audit log, diagnostics.

What each server type can do (and what is not possible with the current API) is in [`docs/COMMUNITY_TYPES.md`](docs/COMMUNITY_TYPES.md).

## Commands
| Command | Who | What |
|---|---|---|
| `/link username:<name>` | members | link your game account (confirm button; direct or staff-approved, per server) |
| `/unlink` | members | remove your link; roles the bot granted you are taken off |
| `/link-status` | members | show your link |
| `/profile [user] [private]` | members | player card (public by default, `private` to hide) |
| `/sync me` | linked members | refresh your own roles |
| `/sync all` | Manage Server | synchronize every linked member (batched, cancellable) |
| `/force link` | Manage Server | link a member to a player (confirm; explicit `replace` to displace a link) |
| `/admin pending\|approve\|reject\|unlink\|diagnostics` | Manage Server | staff-approval queue, unlink, diagnostics |
| `/help` | everyone | usage |

Permissions are enforced on the server for every call (hiding a command in Discord is only cosmetic). The bot needs **Manage Roles** only —
never Administrator — and refuses to manage roles that carry Administrator / Manage Server / Manage Roles, `@everyone`, integration roles,
or roles above its own.

## Repository layout
```
packages/core        pure rules: rank ladder + validation, rank calculation, role-plan engine
packages/aon-client  Age of Nations API client (rate limit, cache, retries) + the ONLY file that knows response shapes (mappers.ts)
packages/db          SQL migrations (forward-only), repositories, scheduler claims, pg adapter
packages/sync        member + guild synchronization engine
packages/bot         Discord bot (commands, /profile card, scheduler, entry point `main.ts`)
packages/web         dashboard backend (Fastify, OAuth2, sessions, API) + static frontend in public/ (no build step)
docs/                architecture, community types, linking, sync + scheduling
scripts/             probe-api.sh (capture real API samples), make-brand-assets.py (regenerate logo variants)
```

## Development
Requires Node 22 and (for the optional real-database test run) PostgreSQL 16.
```bash
npm ci
npm run typecheck                  # tsc --strict in every package (this is the project's "lint"; there is no bundler step)
npm test -w @aon/core              # run packages one at a time: core, client, db, sync, bot, web
# DB-backed suites use an in-process PostgreSQL (PGlite) by default; to run them on a real server:
TEST_DATABASE_URL=postgresql://user:pw@localhost:5432/postgres npm test -w @aon/db
```
Run the bot + dashboard (needs the environment variables below and a machine that can reach Discord):
```bash
cp .env.example .env   # fill in your own values; never commit .env
npm start
```
Migrations in `packages/db/migrations` are applied automatically and forward-only at startup (checksummed; there is no reset path).
**Back up the database before upgrading.**

### Configuration (`.env.example` lists everything)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` | the bot |
| `APP_BASE_URL`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` | dashboard (all three enable it); redirect = `APP_BASE_URL/auth/callback` |
| `AON_API_BASE_URL` | game API (default `https://app.ageofnations.world/api/v1`) |
| `AON_MEDIA_BASE_URL` | where relative avatar paths live (**unverified assumption**, default `https://app.ageofnations.world`) |

## Branding
The logo in `packages/web/public/brand/source/` is the **preliminary** logo. Replace that one file and run
`python3 scripts/make-brand-assets.py` to regenerate every variant (see `packages/web/public/brand/README.md`).
The Discord bot avatar is **not** set automatically: upload `brand/bot-avatar-1024.png` in the Developer Portal.

## Known limits (details in `PROJECT_STATUS.md`)
No alliance features (the API exposes no verified alliance data); no stronger ownership verification and no verification tickets yet
(designed for, not built); foreign-minister / party-treasurer / party-council roles need the game's own role value (the dashboard shows
the values it has seen); no unit-owner role (not needed by the data).
