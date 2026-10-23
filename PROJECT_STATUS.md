# PROJECT_STATUS  (updated 2026-10-22)

## Test status — every number below comes from a run in this session
| Package | Tests | PGlite (in-process PostgreSQL) | Real PostgreSQL 16.15 |
|---|---|---|---|
| @aon/core | 59 | ✔ | n/a (pure logic) |
| @aon/client | 49 | ✔ | n/a (fake fetch/clock) |
| @aon/db | 67 | ✔ | ✔ |
| @aon/sync | 81 | ✔ | ✔ |
| @aon/bot | 77 | ✔ | ✔ |
| @aon/web (auth 23, API 43, UI via jsdom 36) | 102 | ✔ | ✔ |
| **Total** | **435** | **435** | **327** |
- `tsc --strict`: 0 errors in every package. This is the project's "lint"; there is no bundler/build step (TypeScript runs through `tsx`).
- Smoke: `packages/bot/src/main.ts` on a fresh real PostgreSQL applies migrations 0001–0006 and stops at Discord login (`ENOTFOUND discord.com`: the sandbox has no route to Discord). Invalid configuration fails fast without echoing secrets.
- The per-member lock was **mutation-tested**: with it disabled, the overlap test fails (member ends with two rank roles); with it, one.
- Upgrade path tested: a database at the previous schema (0001–0004) with guilds on odd intervals upgrades through 0005–0006 keeping data.

## Implemented (this stage, on top of the earlier work)
- **Community types** (docs/COMMUNITY_TYPES.md): country (president, VP, defense, economy, congress, citizens, plus foreign minister and other offices via the game's own role value), party (leader, member, any other party role via the game's role value), military unit (member, leader; optional "leader replaces member"). Roles are independent; a player may hold several. Alliance: **not available** (no verified data) and refused by the API/dashboard.
- **Military ranks**: optional per server (off by default); owner's **17** starter ranks; add / rename / re-threshold / reorder / disable / delete from the dashboard; exclusive group; validation in dashboard + backend + database (strictly increasing thresholds, one Discord role per rank, a role cannot be both a rank role and a mapped role, sensitive roles refused); deletion refused during a running sync; deleted ranks' roles cleaned from members by the next complete clean sync; per-member lock so overlapping syncs cannot leave two rank roles; failures never remove a rank.
- **Linking**: `/link username:<name>` (direct by default, staff-approval optional per server), `/unlink`, `/link-status`; Discord user ID as identity, stable player ID stored; conflicts refused with guidance; API failures never delete links; pluggable `OwnershipVerifier` for a future stronger check. **Ownership is not proven** (documented in README, docs/LINKING.md, bot replies and dashboard).
- **`/profile`**: designed Discord embed (avatar, country, level/XP, all-time + recent damage, offices, party, unit, work/trade/companies, rank + progress when the server enabled ranks), Arabic/English, only real data, Discord limits enforced and tested, escaping of game-supplied text.
- **Dashboard**: setup (community-type presets, link mode, unit-leader option, alliance shown as unavailable), mappings grouped by community type with the role values the game reported, rank editor (optional switch, defaults creation, reorder keeping thresholds in place, delete warning), players (link method badge), schedule/sync status, audit, diagnostics. Nothing is offered that has no backend.
- **Earlier work kept intact**: durable 3/6/12/24 h scheduler, bidirectional reconciliation, OAuth2 dashboard, migrations, logo integration.
- Migration `0006_linking_party_roles_unit_options.sql` (forward-only; existing guilds keep their values, only defaults for new guilds change).

## Decisions where the owner's messages differed (please confirm)
- **Default rank list**: the earlier handoff had 18 ranks (including "جندي أول" at 25,000); the latest message lists **17** (without it). The **latest (17)** is implemented. Existing guilds' stored ladders are not rewritten.
- **Default demotion policy** for new servers is **immediate** (was "never"): thresholds are configurable and damage only grows, so reflecting a threshold change at the next sync requires it. "Never" and "grace period" remain selectable. A failed/malformed damage value never triggers a demotion under any policy.
- **Default link mode** for new servers is **direct** (as requested); staff approval stays available per server.

## Deferred (and why)
- Alliance roles (member + the player's country inside the alliance): **no verified API data** (`/alliances` never sampled). Needs one real response of `GET /alliances` and `GET /alliances/{id}` showing member/leader fields, and a player↔alliance relation.
- Stronger ownership verification and verification tickets: explicitly deferred; the extension point exists.
- Unit **owner** role: not needed (a single leader role was requested).
- Cumulative rank mode: not requested (ranks are exclusive).

## Data still missing (exact evidence that would unlock more)
- The game's raw role value for **Foreign Affairs minister** (needed to map it automatically; today the admin enters it, the dashboard lists values seen in syncs).
- The game's party **role values** for treasurer and council members (today: admin maps "Other party role" with the value seen in a sync; only `leader` and `commander` were observed).
- Whether `avatarUrl` (`/media/...`) is served from `https://app.ageofnations.world` (configurable `AON_MEDIA_BASE_URL`; a wrong guess only means no thumbnail).
- Profile of a player with no party/unit: `null` vs absent key (code treats explicit `null` as not-a-member, absent as unknown).
- Country display names for the card (only the country **ID** is shown; `/countries` response not sampled).

## Not verified / known limits
- **Never run against real Discord or the live game API** (sandbox limitation): bot login, slash-command registration, OAuth round-trip, role changes, `/profile` rendering inside Discord and the discord.js adapter are tested only against fakes and Discord's documented limits.
- The dashboard was exercised with jsdom against the real backend, **not in a real browser**; visual layout/responsiveness is unreviewed.
- `/sync all` costs ≈1 game request per member for damage (60 requests/min per IP shared): ≈11 min for 500 members with ranks on.
- Command descriptions are English only (Arabic is not a Discord command-localisation locale); all replies follow the server language.
- Dockerfile exists but is **untested** (no Docker in the sandbox). No hosting/deployment work was done (as requested).

## After you receive the files (not done yet, by design)
Create the Discord application, set `.env` from `.env.example`, run on a machine that can reach Discord, upload `brand/bot-avatar-1024.png`.
