# Changelog

## Delivery A — customizable verification ticket panel, publishable from the dashboard
**Added**
- Panel settings (title, description, colour, footer, thumbnail link, button text/emoji/colour, default-text language), stored per server in `verification_panels` (migration `0010`, additive).
- Dashboard: panel editor with live preview, save, reset, publish / update / post-as-new, status ("published in #channel", "up to date" or "changed since publishing", link to the message). Arabic + English, RTL.
- API: `GET/PUT /api/guilds/:g/verification/panel`, `POST .../panel/publish`.
- `@aon/core` `panel.ts` (validation, defaults, fingerprint), `@aon/db` `panel-repo.ts`, `@aon/sync` `panel.ts` (one publish service), `@aon/bot` `panel-publisher.ts` (discord.js adapter).
**Changed**
- `/admin verify-panel` now runs the same service as the dashboard (edits the existing message instead of posting a duplicate). The bot's `postPanel` hook is replaced by `panelPublisher`; messages `vt_panel`/`vt_open_btn` removed (defaults live in core); new `vt_panel_updated/busy/perms`.
- Verification page: the channel hint no longer tells admins to run a slash command.
**Fixed (found by the new tests)**
- Removing an old panel from a channel that no longer exists is silent instead of an error.
- A failed/malformed panel response can no longer break the rest of the Verification page.
**Unchanged:** global linking, company-name verification, ticket flow and its security checks, every other dashboard page.

# CHANGELOG — Phase 1: global account linking + company-name verification tickets

**Base:** the repository as uploaded after the dashboard hotfix (`AoN-role-bot-main (2).zip`; it has no `.git`, so no commit hash can be stated — please note your current commit when you apply this). **Migration:** `0009_global_links_verification.sql` runs automatically at bot start (forward-only, additive, preserves every existing link; conflicts are unlinked with an audit event, never deleted). No new environment variables. After deploying, re-register slash commands (the bot does this at start) so `/verify` and `/admin verify-panel` appear.

## What it does
* **Global links.** `global_links` (unique per Discord user and per game account, enforced by partial unique indexes) is the identity. Per-server `account_links` rows stay for sync state; a DB trigger forbids an active one that disagrees with the global link. Verify once; in another server the link is created on the member's first explicit use (`/sync me`, `/profile`, `/link-status`, `/verify`, panel button) with no second ownership check.
* **Company-name verification.** Ticket shows a one-time code `AON-XXXXXXXXXX`; the member puts it in the name of one of their own companies; **Check verification** reads `GET /players/{id}/companies?limit=50&offset=N` (paginated) and looks for the code. Only a hash of the code is stored; 30-minute expiry; 10 checks / 20 s apart / 8 tickets per day; owner-only buttons; double-click and cross-member races produce exactly one link (tested). `/link` is now an alias of `/verify`; the name-only claim is removed.
* **Ticket UX (AR/EN):** panel with *Open verification ticket*, name modal, instructions + code, *Check verification*, *New code*, *Close ticket*, clear messages for success / wrong code / expired / locked / API down / unreadable data / already linked.
* **Dashboard:** new **Verification** tab: channel selector (validated against Discord: text channels of this server only), 30-day statistics, linked members by method, recent attempts. `/admin verify-panel` posts the panel into that channel.
* **Admin/operator controls:** server `/admin unlink` is server-level; `/unlink` by the member ends the link everywhere; a proven link cannot be broken by `/force link` (409 `global_conflict`); a real proof replaces an unproven (legacy/staff/forced) link and strips the old claimant's roles; operator recovery `scripts/recover-link.ts` (reason mandatory, audited).
* Design, decisions and limits: `docs/VERIFICATION.md`. Checklist: `PROJECT_STATUS.md`.

## Existing behaviour changed (on purpose)
* A game account can no longer be linked to different Discord users in different servers, and one Discord user can no longer hold different accounts in different servers. Existing conflicting links are resolved by migration 0009 (strongest/oldest kept; the others set to `unlinked` + audit `link.migration_conflict_unlinked`; roles they granted stay until removed by hand).
* Old name-only links stay valid, marked `legacy_unverified`, until the real owner verifies (then they are replaced) .
* `forceLink` returns `displaced` and may refuse with `GLOBAL_CONFLICT`; the member's own `/unlink` is global.
* Five existing tests were rewritten for these rules (db: direct-link independence per guild, relink after unlink, force-link result, migration lists; sync: cross-guild test now uses one member in two servers; bot: the removed name-only `/link` tests replaced by ticket-flow tests; web: nav count 9→10).
* Also fixed: a cooldown map treated a clock moving backwards as "on cooldown".
* Includes the one-file typing fix for `dashboard-resilience.test.ts` from the previous message (already in this file; do not apply that ZIP separately).

## Tests actually run (sandbox)
| Suite | Backend | Result |
|---|---|---|
| `tsc --noEmit` core, client, db, sync, bot, web | – | all exit 0 |
| core (91) · client (66) | pure | all passed |
| db (107) | PGlite | 107 passed |
| db (107) | **real PostgreSQL 16** | 107 passed (incl. concurrency/race tests, migration with conflicting legacy data) |
| sync (81) | PGlite and PostgreSQL 16 | 81 passed on both |
| bot (90, mocked Discord and game API) | PGlite and PostgreSQL 16 | 90 passed on both |
| web API/auth/setup/verification/resilience (115) + UI (72, jsdom) | PGlite | 187 passed |
| web API/auth/setup/verification (102) | PostgreSQL 16 | 102 passed |

**Not run:** real Discord (the discord.js adapters `interactions.ts`/`main.ts` and the panel/modal were never exercised against Discord), the live game API, a real browser, the production host, Docker, your production database.

## Known limitations and unverified assumptions
* **The `/players/{id}/companies` response shape is unverified** (free-form in the OpenAPI file, no sample). Parsing is strict and fails closed; see `docs/VERIFICATION.md`. Run `scripts/probe-api.sh` and send `api-samples/player_companies.json` to confirm.
* Whether companies can be renamed freely in the game (length/characters) is assumed; the code is 14 characters.
* Per-server link on first explicit use, not on join (no privileged intent).
* No interactive admin review queue yet (history + force/unlink + operator script).

## Changed / new files
New: `docs/VERIFICATION.md`, `scripts/recover-link.ts`, `packages/db/migrations/0009_global_links_verification.sql`, `packages/db/src/{global-links-repo,verification-repo}.ts`, `packages/core/src/verification.ts`, `packages/bot/src/{verification,shared}.ts`, tests: `core/test/verification.test.ts`, `aon-client/test/companies.test.ts`, `db/test/verification.test.ts`, `bot/test/verification.test.ts`, `web/test/verification-api.test.ts`.
Modified: `PROJECT_STATUS.md`, `docs/LINKING.md`, `scripts/probe-api.sh`, `core/src/index.ts`, `aon-client/src/{client,mappers}.ts`, `db/src/{guild-repo,index,links-repo}.ts`, `bot/src/{commands,handlers,interactions,main,messages}.ts`, `web/src/{app,discord}.ts`, `web/public/{app,common,i18n}.js`, tests `bot/test/{bot-harness,handlers.test}.ts`, `db/test/{features,migrate,repos}.test.ts`, `sync/test/guild-sync.test.ts`, `web/test/{dashboard-resilience,harness,ui}.test.ts`.

---

# CHANGELOG — Incident fix: `/app` stuck on the loading skeleton (hotfix, front-end only)

**Base:** the uploaded `AoN-role-bot-main.zip` (it contains no `.git` metadata, so the exact commit could not be read from it; the files match Delivery 2 + Delivery 4 with Delivery 3's three front-end files missing). Extract over the project. **No migration, no new environment variable, no backend change, no files deleted.** Restart is not required (static files), but browsers may keep the old scripts for up to 5 minutes (`cache-control: max-age=300`) — hard-refresh once.

## Root cause (confirmed in the repository, not yet confirmed on the live host)
`packages/web/public/common.js`, `landing.html` and `landing.js` were still the **Delivery 2** versions, while `app.js`, `app.css`, `app.html` and `i18n.js` were the **Delivery 4** versions. Delivery 4 requires Delivery 3 ("Prerequisite" in its changelog), and Delivery 3's `common.js` is the file that defines `window.AON.icon` / `paintIcons` and the `aon:lang-before` event. Without it `app.js` runs `icon('server')` → `TypeError: icon is not a function` inside `route()`, which had no error handling, so the three-bar loading skeleton painted by `route()` was never replaced. The landing page keeps working because the Delivery 2 landing files are self-consistent. `/api/session` succeeds first, which is why the user is "logged in" yet sees nothing. The Discord bot is unaffected (separate code path).
Evidence: `Object.keys(window.AON)` after loading the repo's `i18n.js` + `common.js` was `t,el,applyLang,setLang,getLang,toggleTheme,fmtNum,fmtDate` (no `icon`, no `paintIcons`); with the old `common.js` the repo's own tests "renders grouped sidebar navigation with icons…" and "landing page > has the two primary actions…" fail.

## What changed
- `common.js` restored/rewritten to the Delivery 3 contract: inline SVG icons (`createElementNS`, no markup strings; unknown names fall back to a dot), `paintIcons()`, `data-i18n-aria`, `aon:lang-before` / `aon:lang` events around a language switch, **no theme toggle** (single dark theme). `landing.html` / `landing.js` rebuilt for the Delivery 3/4 design using the dictionary keys and CSS that already ship (hero, features, three server types, steps, safety, FAQ, closing call to action; credit "Developed by AbuDujana" static English text). No alliance / ticket / proxy / nickname claims.
- `app.js` hardening (so no future failure can look like "loading forever"): every API call has a 20 s timeout (`timeout` vs `network` distinguished); the session check is time-boxed; `route()` and page rendering catch exceptions; failures show a localized message with a **Retry** button; a malformed guild-list response is treated as an error. 401 still redirects to `/auth/login` — authentication, CSRF and guild isolation are untouched.
- `i18n.js`: `e_network`, `e_timeout`, `e_server`, `retry` in Arabic and English (key parity kept).
- New `packages/web/test/dashboard-resilience.test.ts` (11 tests).

## Tests actually run (sandbox; fake Discord/game, in-memory PGlite database; **no real Postgres, no real browser, no production access**)
- `@aon/web` `tsc --noEmit`: 0 errors.
- `@aon/web` `ui.test.ts`: 72/72. `api.test.ts` + `auth.test.ts` + `setup.test.ts`: 97/97. New `dashboard-resilience.test.ts`: 11/11 (empty account, one server, 503 + Retry recovery, hanging API timeout, hanging session, network error, malformed body, AR/EN error text, script-contract regression).
- Negative check: with the old `common.js` the two tests named above fail.
- The default multi-file `vitest run` crashed the worker in this sandbox ("Worker exited unexpectedly" after 20 tests); the same files pass with `--pool=forks --poolOptions.forks.singleFork=true`. Treated as a sandbox limitation, not investigated.
- **Not run:** other packages (untouched), real PostgreSQL, real Chromium, real Discord OAuth, the live site, Docker.

## Not done / still to verify on the live host
- Production commit, startup command, logs, OAuth redirect URI and environment variables could not be inspected (no access). See the report for the manual checks.
- Phase 2 (regression audit, role-mapping lock, picker stale requests) and Phase 3 have **not** been started; they wait for confirmation that `/app` works in production.

## Changed / new files
Modified: `packages/web/public/common.js`, `landing.html`, `landing.js`, `app.js`, `i18n.js`, `CHANGELOG.md`
New: `packages/web/test/dashboard-resilience.test.ts`

---

# CHANGELOG — Delivery 4: Phase 3 — type-driven setup, searchable selectors, country reservation

**Prerequisite:** Delivery 3 (Phase 2) must already be applied: this ZIP contains full replacements of `app.css`, `app.html`, `app.js`, `i18n.js` and `ui.test.ts`, which build on Delivery 3.
Base used for this delivery: repository `4b5f4da736ba4479de29e61afbe697fcd8059d4b` **plus the complete Delivery 3 ZIP** (GitHub `main` was still `4b5f4da` when this was prepared). Delivery 3 itself was not modified; no Phase 2 and Phase 3 changes are mixed in the changed-files list below.
Extract over the project. **No files are deleted.** One new forward-only migration (`0008`) runs automatically at startup.

## Migration 0008_country_reservation.sql
Creates `country_reservations` (PK `guild_id`, unique `lower(country_id)`), a trigger on `guilds` that maintains it atomically, and back-fills it from existing **country**-type servers (oldest wins; duplicates are left untouched and flagged in the dashboard, nothing is deleted). Idempotent on restart. See `docs/SETUP_AND_RESERVATION.md` for the model, the duplicate-finding query and the unverified API assumptions.

## Complete and verified
- **Server types**: General / Country / Party / Military unit; Alliance not offered, legacy alliance data preserved. One rules table (`@aon/core` `community.ts`) decides role kinds and modules; the API rejects mappings the type does not offer (`kind_not_allowed_for_type`) and the roles page only lists allowed kinds.
- **Type change safety**: refused with the exact list of affected mappings until explicitly confirmed (dialog with acknowledgement tick, focus trap, Escape/Cancel change nothing); on confirmation the mappings are removed in the same DB transaction (locked, audited). Build-role and legacy alliance mappings are never removed. Switched-off modules are reported.
- **Searchable selectors** (`picker.js`, new): accessible combobox (label, listbox, `aria-activedescendant`, live status, arrow/Home/End/Enter/Escape), server-side search and pagination ("Show more"), loading / empty / error+retry / rate-limit / "unrecognised response" states, manual-ID fallback, selected item shown by **name**, raw IDs never listed, stale searches ignored. Country, party (needs a country filter) and unit (country list, or the game's search with 2+ characters).
- **Country reservation**: database-enforced (see migration), atomic with the settings update (a failed claim rolls back the whole save), case-insensitive, country-type only, audited (`country.reserved` / `country.released`), explicit authorized release (`DELETE /api/guilds/:id/country`), saving an empty country is refused, the other server is never identified in any response. The dashboard states that a reservation is not proof of in-game authority and shows the support contact (`abudujana15`) on conflict.
- Quality: design system, RTL/LTR and the language-switch state restore keep working (the restore now follows a restored type change that rebuilds the form); dialogs now trap focus (closes a Phase 2 limitation); `[hidden]` always wins in CSS; Arabic and English strings are in parity (418 keys each).

## Tests actually run
- `tsc --noEmit`: core, db, aon-client, sync, bot, web: 0 errors.
- **Real PostgreSQL 16 (installed in the sandbox)**: `@aon/db` 91/91 (75 existing + 16 new: uniqueness, case-insensitivity, atomic rollback, true concurrent claims, legacy-duplicate migration, authorized release, cascade, type-change protection); `@aon/web` 169/169; `@aon/core` 85/85; `@aon/client` 60/60; `@aon/bot` 84/84; `@aon/sync` 81/81 (one earlier run showed a single failure in "two simultaneous /sync all"; it passed 3 of 3 re-runs and on the unmodified baseline; not reproduced, treated as a flake, not investigated further).
- **PGlite (the default `npm test` backend)**: `@aon/db` 91/91 and `@aon/web` 169/169.
- **Real Chromium against the real app** (real routes and database; fake Discord/game): keyboard selection of a country, save, reservation shown; a second server gets the 409 conflict message and nothing is saved; type change shows the dialog, Escape keeps everything, confirmation removes only the incompatible mapping and releases the reservation; mobile (390 px, Arabic) has no horizontal overflow. Screenshots reviewed; they found the "ID" label, the stray empty bar and the premature "no results" text, all fixed.
- Test infrastructure fix: DB test helpers now close each real-PostgreSQL pool and drop its database after every test (a long run used to exhaust the server's connection limit).

## Unverified API assumptions (isolated, never presented as confirmed)
`GET /countries` shape; `GET /units?search=` response shape; `GET /parties/{id}` and `/units/{id}` name field. Each degrades to "name unavailable" or the manual-ID fallback. No flag/image is shown (no verified field; unit `logoUrl` is null in the only sample and its host would be blocked by the CSP).

## Manual deployment steps
None required: migration 0008 runs at startup. After deploying, run the duplicate query from `docs/SETUP_AND_RESERVATION.md` to see servers that already shared a country; the oldest keeps the reservation, the others see a notice.

## Not done / limitations
- The `unit_owner` kind, a dedicated treasurer/council kind, proxy citizens, ticket verification, nickname sync, rank/player/audit/diagnostics redesign and the profile designer are later phases.
- A *general*-type server may store a country (needed for government roles) without reserving it; only country-type servers reserve. Say if general servers should be blocked from using a reserved country's government roles.
- No owner-only override and no automatic DM/dispute workflow exists (only the documented contact).
- Names shown by the selectors for the unverified sources depend on the real response shape; if it differs the dashboard falls back to manual ID entry.
- Not run: live Discord, the live game API, Docker, Firefox/Safari, screen readers.

## Changed / new files
New: `docs/SETUP_AND_RESERVATION.md`, `packages/core/src/community.ts`, `packages/core/test/community.test.ts`, `packages/db/migrations/0008_country_reservation.sql`, `packages/db/test/reservation.test.ts`, `packages/aon-client/test/entities.test.ts`, `packages/web/public/picker.js`, `packages/web/test/setup.test.ts`
Modified: `packages/core/src/index.ts`, `packages/db/src/guild-repo.ts`, `packages/db/test/helpers.ts`, `packages/db/test/migrate.test.ts`, `packages/aon-client/src/mappers.ts`, `packages/aon-client/src/client.ts`, `packages/web/src/app.ts`, `packages/web/public/app.css`, `app.html`, `app.js`, `i18n.js`, `packages/web/test/harness.ts`, `packages/web/test/ui.test.ts`, `CHANGELOG.md`

---

# CHANGELOG — Delivery 3: Phase 2 — design system, landing page, dashboard shell

Base: repository `Shahbour2000/AoN-role-bot` at commit `4b5f4da` (Delivery 2 applied). Extract over it. **No files deleted, no migration, no new environment variable, no backend change** (front-end only: `packages/web/public/*` + its tests).
Verified before starting: Delivery 2 changes present; Phase 1 (build roles, migration 0007, `/builds` routes, branding) intact; `SERVER_PORT` handling untouched.

## Complete and verified
- **Design system** (`app.css`, rewritten): dark premium theme (navy/near-black, electric blue, violet, cyan accents), tokens, buttons, cards, stat cards, badges, callouts, forms, tables (always scroll inside their container), dialogs, toasts, skeletons. Logical CSS properties only; no inline styles, no remote assets. The light theme and its toggle were **removed** (single dark theme, per the brief). Every existing page inherits the new look through the same class names.
- **Landing page** (`landing.html/js`): hero with logo and glow, "Open dashboard" / "Add to Discord" actions (invite URL from `/api/public` applied to both buttons), features, server types, getting started, safety/permissions, FAQ, closing CTA. It only describes what exists today (no tickets, proxy citizens, nicknames, alliances).
- **App shell** (`app.html`, `app.js`): sidebar with grouped, icon navigation (General / Roles / Community / Operations), server switcher (current server + other installed servers + "all servers"), page header with title and one-line description, top bar, footer. Mobile/tablet (<1024 px): off-canvas drawer with scrim, Escape and navigation close it, `aria-expanded` maintained. Routes (`#/g/<id>/<tab>`), OAuth, API calls and page logic are unchanged.
- **Language switching keeps state** (previously a switch re-rendered the page and discarded unsaved input): the app captures form controls, open `<details>`, focus and scroll before the switch and restores them afterwards; server and tab stay in the URL. A switch never saves anything.
- **Localization**: new `i18n.js` sections (shell, landing, per-page descriptions, job statuses); Arabic and English have identical keys/placeholders (357 each); icons are built with `createElementNS`, so no markup strings. Overview shows translated job statuses (it showed raw `succeeded` before).
- **Credit**: `Developed by AbuDujana` is static English text in both HTML files (survives without JS) and the dictionary value is the same English string in Arabic and English (the Arabic dictionary used to translate it).
- Accessibility: skip link, focus rings, labelled controls, reduced-motion support.
- Concise copy: alliance wording removed from the landing page; hero/feature/page descriptions rewritten short.

## Tests actually run
- `@aon/web` (vitest, jsdom, real backend with in-memory Postgres): **128 passed** (114 before + 14 new: shell nav/switcher/drawer, language-state preservation, landing behaviour, credit, design-system static checks). `tsc --noEmit` on `@aon/web`: 0 errors.
- **Real browser (headless Chromium) screenshots** of landing (AR/EN, 1366 and 390 px), dashboard overview (AR/EN, desktop and mobile), setup (820 px), server list, and the open mobile drawer, against the real `public/` files with a mocked API. They found and I fixed: RTL drawer would not open (CSS specificity), hard-cut hero arc, orphan headline word, orphan feature row, off-centre hero logo, three-row mobile header, English server names truncated at the wrong end in RTL. Document width equalled viewport width in every capture (no horizontal overflow).
- Not run: other packages (not touched), real Discord OAuth, real API, Docker, real PostgreSQL, Safari/Firefox, a screen reader.

## Known limitations / not done in this delivery
- Individual pages (setup, roles, ranks, players, sync, audit, diagnostics) were **restyled through the shared components but not redesigned or reorganised**; only overview got stat cards. Setup still uses raw ID text boxes (next phase: searchable selectors).
- Language-switch restore matches controls by position and only when the page structure is unchanged; transient state not held in form controls (e.g. an in-progress drag) is not restored. An open modal stays in its old language until closed.
- Dialogs have `role="dialog"` but no focus trap yet.
- Screenshots used system fonts of the sandbox; Arabic glyph shaping in your browsers may differ slightly.
- The unused dictionary keys for the old alliance wording and theme toggle remain (harmless).

## Changed files
`packages/web/public/app.css`, `app.html`, `app.js`, `common.js`, `i18n.js`, `landing.html`, `landing.js`, `packages/web/test/ui.test.ts`, `CHANGELOG.md`

---

# CHANGELOG — Delivery 2: audit + alliance/country-name corrections

Base: repository `Shahbour2000/AoN-role-bot` at commit `5d36246`. Extract over it; **no files are deleted**. No migration, no new environment variable, no manual step.
This is a small, verified correction delivery. **The large redesign / verification / proxy / reservation / designer work is NOT in this ZIP and is not started** (see docs/AUDIT.md).

## Complete and verified (by tests listed below)
- **Alliance is no longer offered in setup.** The type selector now lists General / Country / Party / Military unit; the disabled "alliance" module checkbox, the
  "alliance not available yet" notes and the alliance group in the role-mapping selector are gone. A guild that already stores `alliance` shows it only as a
  disabled, localized **Closed** option (`مغلق` / `Closed`). Data and backend code are untouched. This also removes the frontend/backend mismatch (saving failed
  because the API rejects `alliance`).
- **`/profile` never shows a country ID.** It shows the country **name** when it can be resolved and omits the row otherwise (name is escaped and clipped).
  `AonClient.countryName(id)` resolves it from `GET /countries` with a 6 h cache and serves the stale cache on failure.
- Audit document `docs/AUDIT.md` (findings, evidence limits, requirements checklist).

## Not done / limitations (honest)
- **Country flag: not implemented.** `GET /countries` has never been sampled; no verified flag/ISO field exists. The name extractor (`extractCountryNames`) is
  **tolerant and UNVERIFIED** (array or `{countries:[{id,name}]}`); if the real shape differs the country row is simply omitted. Please send one real
  `GET /countries` response.
- **War/Eco/Hybrid is unverified**: the real profile sample in the fixtures has **no `skills` array**, and the skill groups/thresholds are provisional. Behaviour is
  non-destructive (no skills → no change). Needs a real profile containing skills and your approval of the formula.
- The game API was unreachable from the sandbox: nothing was run against the live API, real Discord, a real browser, or Docker.

## Tests actually run (this session)
- `npm run typecheck` (tsc --strict, all packages): 0 errors.
- `@aon/client` (vitest): 53 passed (51 before + 2 new). `@aon/bot`: 84 passed (80 + 4 new). `@aon/web`: 114 passed (includes 1 new + 2 updated UI tests, jsdom).
- `@aon/core` (79 passed) was run before the changes, on unchanged code. `@aon/db` and `@aon/sync` were **not changed and their full run did not finish within the sandbox time limit** → not re-verified in this session.
- Not run: real PostgreSQL, real browser, live API.

## Changed / new files
- `docs/AUDIT.md` (new)
- `packages/aon-client/src/mappers.ts`, `src/client.ts`, `test/mappers.test.ts` — `extractCountryNames`, `countryName()`
- `packages/bot/src/profile-card.ts`, `src/handlers.ts`, `test/profile-card.test.ts`, `test/handlers.test.ts`, `test/bot-harness.ts` — name-only country row
- `packages/web/public/app.js`, `public/i18n.js`, `test/ui.test.ts` — alliance removal, `closed` string

---

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
