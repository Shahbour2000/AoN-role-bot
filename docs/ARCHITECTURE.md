# Architecture — Age of Nations Discord Roles Platform

Status: Stage A (analysis) complete; Stage B started (pure core implemented and tested).

## 1. Reference repository analysis (war-era-discord-roles-bot)

**Important:** the reference targets **WarEra** (`api2.warera.io`, tRPC, API-key auth), not Age of Nations.
Its API client and response types cannot be reused; Age of Nations is a plain public REST API.

| Area | Finding | Decision |
|---|---|---|
| Stack | Node/TS, discord.js 14, Prisma, node-cron, pino | Keep TS + discord.js + pino |
| Tenancy | `GuildConfig` is per-guild, but `corps.config.ts`, `roleSync.service.ts` contain hardcoded Discord role IDs and Egypt/MISR logic | Discard; all config is per-guild data |
| Account linking | `/verify <username>` links a Discord ID to a username with no ownership proof; one global `UserLink` with `@unique` on both IDs | Replace: challenge verification + staff approval + conflict review |
| Role sync | Single 499-line `syncMember` | Replace with pure decision engine (`@aon/core`) |
| Deployment | `prisma db push --accept-data-loss` in Dockerfile CMD and README | **Rejected** (violates brief). Use `prisma migrate deploy` only |
| Dashboard | Next.js MISR HQ analytics (members, market, equipment) | Discard (different product) |
| Extras | Recruitment, operations, optimizer, readiness | Out of scope |
| Secrets | Scanned full git history (34 commits) for token/API-key/DB-URL patterns; only placeholder-looking Postgres URLs found; `.env` never committed | No rotation needed based on this scan. Scan is pattern-based, not proof |
| Reusable ideas | pino logging, repository layer, graceful startup, Dockerfile multi-stage shape | Reuse as patterns, not code |

## 2. Age of Nations API — what the spec confirms

Source: OpenAPI at `/api/docs/json` (read). **All 200 responses are declared as free-form objects
(`additionalProperties: true`), so field names are NOT confirmed by the spec.** Live samples are
required before implementing field mappings (`scripts/probe-api.sh`).

Confirmed by spec (endpoints exist, per their descriptions):
- Limits: 60 req/min **per IP**, 30 s response cache, 429 + `Retry-After`.
- Player lookup: `GET /players/by-name/{username}`, `GET /players?ids=` (max 25), `GET /players/{id}`.
- Player numbers: `GET /players/{id}/stats` — "level, rank, damage, work and trade (all time, today, this week, this month)".
- Government roster: `GET /countries/{id}/government/members` — president, VP, ministers, congress, with role label, level, party.
- Country citizens (paged, max 100): `GET /countries/{id}/citizens`.
- Parties: `GET /countries/{id}/parties`, `GET /parties/{id}`. Units: `GET /countries/{id}/units`, `GET /units/{id}` ("members, damage…"). Alliances: `GET /alliances`, `/alliances/{id}`.

Not confirmed / likely limitations (verify with samples):
1. **Which damage field is "total"** (stats says "all time" exists; exact key unknown). Rank module stays disabled until confirmed.
2. **Ownership verification:** the spec is read-only and lists no endpoint exposing an editable profile field/bio. If profiles have no editable text, automated challenge verification is impossible → default is staff-approved pending links.
3. **Party/unit/alliance leadership and member lists:** units say "members"; parties and alliances may not list members per player. Per-player membership may need to come from the profile.
4. **Ministers by portfolio:** roster gives a "role label"; mapping labels to Defense/Foreign/Economy depends on the actual label values.
5. **Rate limit is per IP**: all guilds share one budget → a single global rate-limited queue with caching is mandatory.

## 3. Chosen architecture

One TypeScript monorepo, **one deployable Node process** (bot + HTTP API + static dashboard) plus PostgreSQL.

```
packages/core        pure logic: ranks, validation, role decision (DONE, 43 tests)
packages/aon-client  (workspace @aon/client) API client: timeouts, Retry-After, backoff, shared rate limiter, cache, in-flight dedup (DONE, 25 tests)
packages/db          SQL migrations, runner, ladder + link repositories, audit (DONE, 24 tests)
apps/server          discord.js bot, Fastify API, OAuth2 sessions, job queue, scheduler (next)
apps/web             Vite + React SPA: dashboard + landing, react-i18next, logical CSS for RTL (next)
```

Key decisions:
- **Sync pipeline:** global token-bucket (≤ ~45 req/min, headroom under 60) → per-key request dedup → TTL cache (≥30 s, matches server cache). Country-level fetches (one roster call serves every guild/user of that country) instead of per-user calls where possible.
- **Never revoke on failure:** enforced in `@aon/core` (`Fetched<T>` distinguishes ok / not_found / rate_limited / error / incomplete; only trusted `not_qualifies` removes a role).
- **Multi-tenancy:** every row carries `guildId`; every dashboard/API route resolves the guild from the session and re-checks the user's live Discord permissions (`MANAGE_GUILD`) server-side. Repositories take `guildId` as a mandatory argument.
- **Linking:** immutable Discord ID ↔ stable AoN player ID. States: `pending`, `verified`, `admin_linked`, `rejected`, `conflict`. Unique on (player id) among active links; conflicts flagged for review.
- **Database:** PostgreSQL with plain, versioned, forward-only SQL migrations (`packages/db/migrations`) applied by a small runner at startup: checksummed (editing an applied file aborts startup), one transaction per migration, no reset/drop/"accept data loss" path. (Changed from the earlier Prisma plan: Prisma's engine download is not reachable from the build sandbox, and SQL migrations let integrity rules — partial unique indexes, a deferred constraint trigger enforcing the rank ladder, append-only audit — be tested against real PostgreSQL via PGlite.)
- **Security:** Discord OAuth2 with state, HttpOnly/Secure/SameSite session cookie, CSRF token on mutations, rate limiting, zod validation, secrets in env only. Bot never grants Administrator.

## 4. Hosting ($0) — NOT YET VERIFIED
A persistent gateway connection rules out serverless. Candidates to verify against current provider
terms before any recommendation: an always-free VM tier, a free Postgres tier, and a free app host
as fallback. No claims are made here until checked. No keep-alive pinging.

## 5. Implementation checklist
- [x] A: reference analysis, spec analysis, architecture
- [x] B1: rank engine + ladder validation + demotion policy + role-plan engine + tests
- [x] B2: API client + isolated mappers (field paths UNVERIFIED, fail-safe to `incomplete`)
- [x] B3: schema + migration 0001; ladder and link repositories (role-mapping/custom-rule/job repos still to write)
- [x] B4/B5: Discord commands, permission + hierarchy checks, staff-approval flow, audit (bot package; untested against live Discord)
- [x] B6: sync engine (member + guild), scheduler, pg adapter, healthcheck
- [ ] C: OAuth2, dashboard pages, i18n/RTL, logo
- [ ] D: landing page
- [ ] E: integration tests (cross-guild isolation, authz), security review
- [ ] F: Docker, deployment docs, verified hosting comparison

## Update 2026-10-18
- Added `packages/sync` (sync engine), `packages/bot` (discord.js + commands + scheduler + main) and `packages/web` (Fastify dashboard API + static SPA) — one process, one database.
- Migrations: 0001 schema, 0002 raw government roles, 0003 rank `enabled` + role uniqueness + Arabic default, 0004 dashboard sessions.
- Authorization model: dashboard access = Discord owner / Administrator / Manage Server, re-read from Discord (30 s cache) on every guild-scoped request, plus the bot being installed in that guild.
- Remaining checklist: hosting research ($0 options), Docker verification, deployment/rollback docs, custom rules, real-Discord verification.
