# CHANGELOG — Phase 1: Player Build Roles (War / Eco / Hybrid) + new logo

Base: the project as last delivered (commit `1213f3f`). Extract this ZIP over it; **no files are deleted**.
If you changed `packages/bot/src/config.ts` or `packages/bot/src/main.ts` locally (e.g. for `SERVER_PORT`), merge by hand: this ZIP adds
`SERVER_PORT`-first port handling and `0.0.0.0` binding there.

## Complete (implemented and tested)
- **Shared classifier** `packages/core/src/builds.ts`: one pure function used by the bot, the sync engine, `/profile` and the tests. Formula, groups,
  thresholds and boundary rules are documented in the file header. War ≥ 60 and 15 ahead of Eco; Eco mirrors it; Hybrid both ≥ 50 and gap < 15; else
  `unclassified`; missing/invalid skills, zero `maxLevel`, duplicate codes or too few usable skills → `insufficient` (never forced).
- **Three permanent build roles per server** (War / Eco / Hybrid), independent of server type and modules. Stored per server; one Discord role per build;
  a role cannot serve two builds, nor also be a military-rank role or a mapped office role (checked in code **and** by the database).
- **Automatic assignment in the existing sync** (scheduled, manual, `/sync me`): only a definite War/Eco/Hybrid changes roles; the other two build roles are
  removed; unrelated roles are never touched; `unclassified` / `insufficient` data / failed profile requests change **nothing** (documented non-destructive policy);
  a build with no configured Discord role grants nothing and reports why; no change → no Discord call; build roles need only the profile request.
  Replacing a build role in the dashboard queues the old one for cleanup by the next complete sync.
- **Dashboard**: new **Player builds** page (three permanent entries, role picker, "not set" explanation, duplicate validation, hierarchy hint, rules in a collapsible),
  Arabic + English; overview payload reports configured builds. Alliance is no longer selectable as a server type; build rows are hidden from the ordinary mapping list.
- **API** `GET/PUT /api/guilds/:id/builds` (server-side validation against the real Discord roles of that server, sensitive roles refused, CSRF, per-guild authorization).
- **`/profile`** card shows the build (War / Economy / Hybrid + scores) only for a definite result.
- **Hosting**: `SERVER_PORT` is read first, `PORT` is the fallback; the fallback health server binds `0.0.0.0` (the dashboard server already did).
- **Logo**: the new neon-crown logo replaces the preliminary one; every variant (hero, header mark without lettering, favicons, apple-touch, bot avatar) regenerated with
  `python3 scripts/make-brand-assets.py` (source in `packages/web/public/brand/source/`). Upload `brand/bot-avatar-1024.png` to the Discord Developer Portal yourself.

## NOT done yet (later phases — nothing below is claimed as finished)
- The **Nova-inspired redesign** (new landing page, app shell, design system, responsive/RTL polish) and the **concise-copy pass**: started but not completed or tested
  in this phase, so **no redesign files are in this ZIP**; the dashboard keeps its current look. The new Player builds page uses the current styles.
- Everything from the earlier large brief that is still open: type-driven setup with searchable country/party/unit selectors, proxy countries, country reservation,
  ticket-based ownership verification, Discord nickname sync, role-mapping/ranks/players/audit/diagnostics redesign, profile-card designer and per-player messages.
- **No real browser is available here**, so mobile/RTL/overlap behaviour could only be checked with jsdom and static CSS rules, never visually.

## Unverified assumptions (please confirm)
- The `skills` array shape `{ code, level, maxLevel }` on `GET /players/{id}` is **as you described**; I could not call the live API. The War/Eco skill groups are your
  **provisional** candidate mapping (not verified against any game documentation); change `WAR_SKILLS` / `ECO_SKILLS` in `builds.ts` to change them everywhere.
- "Sufficient data" = at least 4 of 8 war skills and 2 of 4 eco skills usable (my rule; documented in the file header).

## Migration
`packages/db/migrations/0007_player_build_roles.sql` — runs automatically at startup (forward-only, checksummed). It only widens the allowed mapping kinds and adds two
partial unique indexes over the new kinds, so existing data cannot violate it. Back up the database before upgrading as usual. No environment variable added.

## Changed / new files
- `packages/core/src/builds.ts` (new), `src/index.ts`, `test/builds.test.ts` (new) — classifier + tests
- `packages/db/migrations/0007_player_build_roles.sql` (new), `src/guild-repo.ts` (build-role functions), `test/builds.test.ts` (new), `test/migrate.test.ts`
- `packages/aon-client/src/mappers.ts`, `test/mappers.test.ts` — `skills` passed through from the profile
- `packages/sync/src/member-sync.ts`, `src/guild-sync.ts`, `test/builds.test.ts` (new) — build evaluation, job details (counts only)
- `packages/web/src/app.ts`, `public/app.js`, `public/i18n.js`, `test/api.test.ts`, `test/ui.test.ts` — API, Player builds page, translations
- `packages/bot/src/profile-card.ts`, `src/config.ts`, `src/main.ts`, `test/profile-card.test.ts`, `test/misc.test.ts` — card field, `SERVER_PORT`
- `packages/web/public/brand/*` (regenerated variants + new source), `scripts/make-brand-assets.py`

## Tests actually run (this session, after a sandbox reset I rebuilt the base from the delivered ZIP and re-ran everything)
`tsc --strict`: 0 errors (the project has no bundler/build step and no separate linter).
In-process PostgreSQL (PGlite): core 79 · client 51 · db 75 · sync 102 · bot 80 · web auth 23 · web API 51 · web UI (jsdom) 39 — all passing (500 tests).
Real PostgreSQL 16.15: db 75 · sync build tests 21 · web API 51 — all passing.
Not run: real Discord, the live game API, a real browser, Docker.
