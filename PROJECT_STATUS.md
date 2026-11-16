# AoN Role Bot — project status

Updated for **Delivery B: proxy countries, country-wide party/unit roles, searchable role & entity pickers, trusted bot administrators, guild-lock concurrency fix** (on top of Delivery A, which the owner tested on the live server and accepted, and Phase 1). Base: the repository as uploaded after the dashboard hotfix
(no `.git` metadata in the upload, so no commit hash can be stated). Statuses: **COMPLETE** implemented and verified · **PARTIAL** implemented but
incomplete · **UNVERIFIED** implemented but not sufficiently tested (see "Evidence") · **BLOCKED** genuine external limitation · **NOT STARTED**.

**Evidence levels used below:** *mock* = fakes for Discord / game API · *PGlite* = in-process PostgreSQL · *PG16* = real PostgreSQL 16 server ·
*jsdom* = simulated browser. **Nothing has been verified against real Discord, the live game API, a real browser, or the production host.**

## Roadmap requested by the owner (priority order) — where each item stands
| # | Requirement | Status |
|---|---|---|
| 1 | Verification dashboard + customizable ticket panel published from the dashboard | **COMPLETE — accepted by the owner after testing on the live Discord server (Delivery A)**. A stray "null" text seen in the owner's screenshots was fixed in Delivery B. |
| 2 | Proxy countries | **Delivery B: implemented; tested on mock / PGlite / PG16 / jsdom. Not yet run on real Discord.** |
| 3 | Country-wide party / military-unit identification roles | **Delivery B: implemented; same evidence level.** Depends on two unverified API facts, see "Known limitations". |
| 4 | Searchable role / party / unit / country selectors | **Delivery B: role picker (real names + colours) and image-or-initials entity pickers.** Role picker is used on the Roles, Builds, Ranks, Country-roles and Bot-administrators pages. |
| 5 | Trusted bot administrators | **Delivery B: implemented (dashboard + slash commands); never run on real Discord.** |
| 6 | Guild-level lock (server type vs mappings); stale-response protection in pickers | **Delivery B: both fixed.** Lock proven on real PostgreSQL 16 (red/green); stale fix has a red/green test for one of two scenarios. |
| – | Phase 3-6 items from the older plan (nickname sync, build roles formula, alliance, …) | unchanged, see the older phase tables below |

## Delivery B — this delivery
| Requirement | What exists now | Status | Evidence |
|---|---|---|---|
| Migration 0011 | additive: kind list only grows; indexes cover only new kinds; new table `bot_admin_roles` | COMPLETE (code) | `db/test/migrate.test.ts`; `proxy-identity-admin.test.ts` (PGlite **and PG16**) |
| **Proxy countries**: add / edit (replace role) / remove, multiple, country chosen from the game's country list, one dedicated role per country | stored as role mappings of kind `proxy_citizen` (game reference = country id) with replace semantics; dashboard page *Country roles*; `GET/PUT/DELETE /api/guilds/:g/proxy-countries[/:id]` | UNVERIFIED | db 15 (PGlite+PG16), web API 15, jsdom 19, sync 21 |
| Proxy sync: nationality = proxy country ⇒ proxy role; never the citizen role; survives later syncs; never removed when the lookup fails; unrelated roles untouched; scheduled + manual + single-user; global link untouched | `proxy_citizen` evaluation in `member-sync.ts` (uses the player's CURRENT in-game country) | UNVERIFIED | `sync/test/proxy-identity.test.ts`: citizen/proxy swap, idempotency (no Discord calls on re-run), failures (500, rate limit, not found, incomplete), guild-wide run, cross-server isolation |
| A proxy role cannot be the citizen role, another proxy/identity role, or a military-rank role; proxy ≠ own country; only country servers | enforced in the database transaction (and again in the API) | COMPLETE (code) | db + API tests |
| **Country-wide party roles**: Party Member (any party of the server's country, any rank), Party President | kinds `country_party_member` / `country_party_president`, evaluated against the country's own party list (`/countries/{id}/parties`) | UNVERIFIED | sync tests: any party, any rank, foreign party grants nothing, stale roles removed, president via list or profile, failures never remove |
| **Country-wide unit roles**: Unit Member / Leader / Owner | kinds `country_unit_*`, evaluated against the country's unit list (`/countries/{id}/units`: `countryId`, `ownerId`); **nationality is never used** | UNVERIFIED | sync tests: Egyptian citizen in a foreign unit gets nothing; foreign national in an Egyptian unit does; owner of a foreign unit gets nothing; list with gaps can grant but never remove |
| Separate from party-server / unit-server mappings | new kinds are rejected for those server types; their own member/leader/role mappings are unchanged | COMPLETE (code) | sync + db tests |
| Party/unit lists fetched once per run, failures not cached | `memoizeCountryData` (in-flight promise cached) | COMPLETE (code) | 25-member guild run ⇒ 1 request each |
| **Role picker**: real name, real Discord colour, search, only this server's roles, blocked roles disabled, keyboard | `AON.rolePicker`; drop-in for the old `<select>` (same `.value` / `change`), also keeps unsaved choices across a language switch | UNVERIFIED | jsdom |
| **Entity pickers**: name, image when the API gives one, otherwise initials; parties/units filtered by country | units: `logoUrl` only if an absolute https URL; parties/countries: **no image field exists in any API sample** ⇒ initials | PARTIAL | jsdom; see limitation 3 |
| **Trusted bot administrators**: roles chosen in the dashboard, add/remove, view; audited | table `bot_admin_roles`; roles read from Discord by the bot, never from the browser; works in the dashboard and in slash commands | UNVERIFIED | db 3, web API 8, bot 3, jsdom 3 |
| Trusted scope (exact) | see `docs/COUNTRY_ROLES_AND_ADMINS.md`. Trusted = everything the dashboard/commands offer EXCEPT: changing the trusted roles, server type/country/party/unit, releasing the country. Grants no Discord permission. | COMPLETE (code) | API tests (`owner_only`) |
| **Concurrency**: mapping writes and server-type changes share the guild row lock; kind re-checked under the lock | `lockGuild()` in `guild-repo.ts`, used by `addRoleMapping`, `removeRoleMapping`, `setProxyCountry`, `removeProxyCountry`, `setIdentityRole`, `addAdminRole` and `updateGuildSettings` | COMPLETE | **PG16**: race test fails without the fix, passes with it. PGlite is single-connection, so it cannot prove this. |
| **Stale-response protection** in entity pickers | `refresh()` now invalidates in-flight requests; sequence guard + debounce kept | PARTIAL | jsdom with controllable promises: one scenario red/green; the country-switch scenario passes with or without the fix (a new load already supersedes the old); loading/empty/error/retry and debounce tested. No real browser. |
| Regression fixed: literal "null" shown on pages | null children are filtered before `replaceChildren` (3 places) | COMPLETE | red/green jsdom test |

**Known limitations / unverified assumptions (Delivery B)**
1. The party/unit **list shapes are real samples** (`leaderId`; `countryId`, `ownerId`), but the exact meaning of `/countries/{id}/units` ("units owned by that country") and the profile role words (`leader`, `commander`) come from the same samples and have not been checked live.
2. If a unit has no `ownerId` or `countryId`, the bot can still *grant* roles but will never *remove* them (it treats that as unknown). So an incomplete API response is safe, but roles may linger until the data is complete.
3. **Images:** only units can have one (`logoUrl`, null in the only sample). A relative path is ignored. The dashboard may load images only from the game API host and the optional media host (no new setting). Parties and countries have no image field in any sample.
4. A proxy mapping that is removed stops being managed: members keep the Discord role until it is removed by hand.
5. Trusted-role membership is cached for 15 seconds per user on the dashboard; slash commands use the interaction's own role list.
6. Never run against real Discord, the live game API, a real browser or production.

## Delivery A — verification ticket panel (this delivery)
| Requirement | What exists now | Status | Evidence (backend) |
|---|---|---|---|
| Panel settings persisted | table `verification_panels` (migration 0010, additive); `NULL` = built-in localized default | COMPLETE (code) | `db/test/panel.test.ts` 7 tests (PGlite **and PG16**), incl. DB CHECK constraints, cascade on guild delete |
| Customize title, description, colour, footer, thumbnail link, button text/emoji/colour, default-text language | validated in `@aon/core` `validatePanelInput` (shared rules for dashboard + DB) | COMPLETE (code) | `core/test/panel.test.ts` 12; `web/test/panel-api.test.ts` 18 (PGlite) |
| Dashboard editor with live preview, save, reset, field errors, AR/EN, RTL | `panelEditor` in `public/app.js`; fails soft if the panel request fails | UNVERIFIED | `web/test/panel-ui.test.ts` 13 + `dashboard-resilience` 14 (jsdom, real shipped scripts). **Layout checked statically in CSS only; no real browser.** |
| Publish / update / post-as-new / move from the dashboard, no slash command | `POST /api/guilds/:g/verification/panel/publish`, destination = configured channel only | UNVERIFIED | API tests with a fake publisher; **never against real Discord** |
| Same implementation as `/admin verify-panel` | both call `publishVerificationPanel` (`@aon/sync`); audit `details.source` = dashboard/command | COMPLETE (code) | `sync/test/panel.test.ts` 15 (PGlite + PG16); `bot/test/verification.test.ts` |
| No duplicate panels | edit in place; new-then-delete-old; per-server in-process lock; orphan cleanup if the DB write fails | COMPLETE (code) | `sync/test/panel.test.ts` |
| Status shown: where, link, up to date / changed since publishing | fingerprint of channel + content | COMPLETE (code) | API + jsdom tests |
| Authorization, CSRF, guild isolation, server-side channel validation | same gate as other settings routes; channel must be a text/announcement channel of THIS server; bot permissions checked and named | COMPLETE (code) for the gate; UNVERIFIED for permissions | API tests (other server → 403, bad Origin/CSRF → 403). Permission checks are tested only against **structural fakes of discord.js** (`bot/test/panel-publisher.test.ts` 12) |
| Click on the button still starts the existing ticket flow | button id fixed to `vt:open` in core; not configurable; unknown properties ignored | UNVERIFIED | unit + payload tests. **A real button click in real Discord has not been tested.** |
| Preview of an external thumbnail | placeholder tile only (dashboard CSP forbids external images; Discord shows the real one) | by design | jsdom |

**Known limitations / unverified assumptions:** a panel posted earlier by the old command is not tracked (first dashboard publish posts a new one; delete the old by hand; the old button keeps working). The publish lock is in-process (single bot process assumed). Custom-emoji buttons depend on Discord accepting that emoji for the bot; not tested live. Trusted-admin roles (item 5) are not part of this gate yet.

## Phase 0 — production stability
| Item | Status | Evidence / notes |
|---|---|---|
| Dashboard loading hotfix integrated | COMPLETE (code) | Files byte-identical to the delivered hotfix; resilience tests (13) pass on jsdom. Live `/app` not re-checked by me (no access). |
| Dashboard never stays on the loading skeleton | COMPLETE | timeouts + Retry panels, tested (jsdom) |
| Hosting config (SERVER_PORT/PORT, 0.0.0.0, health) | UNVERIFIED | code reviewed, never run on the host from here |
| Deploy from Git (no hand-unzipping) | n/a | process recommendation |

## Phase 1 — global linking and verification tickets (this delivery)
| Item | Status | Evidence / notes |
|---|---|---|
| Global Discord↔AoN uniqueness enforced by the database | UNVERIFIED | `global_links` partial unique indexes + guard trigger on `account_links`; PGlite + PG16 tests incl. races. Not deployed. |
| Existing links preserved by migration 0009 | UNVERIFIED | tested on PGlite/PG16 with conflicting legacy data; **not run on your production data** |
| All servers use the same identity; no second verification | UNVERIFIED | mock Discord tests; materialised on first explicit use (no member-join intent) |
| Company-name verification (code in own company name) | UNVERIFIED | full flow tested with mocks. **Companies response shape never sampled** (docs/VERIFICATION.md) |
| Codes: random, hashed, 30 min, one-time, bound to attempt/user | COMPLETE (code) | core + DB tests |
| Retry limits, spacing, daily cap, owner-only buttons, no manual proof | COMPLETE (code) | DB + bot tests |
| API down / expired / wrong code / incomplete data / already linked handled | UNVERIFIED | mock tests |
| Ticket UI (open, instructions + code, check, new code, close, panel, modal) AR/EN | UNVERIFIED | mock tests; discord.js adapters (`interactions.ts`, `main.ts`) **never run against real Discord** |
| Dashboard: ticket channel setting + statistics + attempt history | UNVERIFIED | API tests (PGlite) + jsdom UI tests. Panel editor/publish: see Delivery A. |
| Admin review of exceptional cases | PARTIAL | history table, `/force link` (never overrides a proven link), `/admin unlink` (server-level), operator script `scripts/recover-link.ts`. No interactive review queue. |
| Audit trail for attempts and admin actions | COMPLETE (code) | `verification.*`, `link.*` events |
| Staff-visible ticket threads | NOT STARTED | decision: ephemeral tickets (docs/VERIFICATION.md) |
| Linking on member join (privileged intent) | NOT STARTED | needs `GuildMembers` intent — your decision |

## Phase 2 — proxy countries and country-server identification roles
| Item | Status | Notes |
|---|---|---|
| Proxy Countries section | see Delivery B | implemented in Delivery B |
| Proxy removal reconciliation | by design | removing a proxy country un-manages its role; nothing is deleted from members |
| Country server: Party Member / Party President | see Delivery B | implemented in Delivery B |
| Country server: Unit Member / Unit Leader / Unit Owner | see Delivery B | implemented in Delivery B (only units OWNED by the server's country qualify) |
| Discord role selector with real colours | see Delivery B | implemented in Delivery B |
| Party/unit selectors with logos, country-filtered | PARTIAL | filtered + searchable; units show `logoUrl` when it is an https URL; parties have no image field → initials |

## Phase 3 — setup and configuration
| Item | Status | Notes |
|---|---|---|
| Server-type-driven setup | UNVERIFIED | works; known race (below) |
| Searchable country/party/unit selectors | PARTIAL | exist; country list shape unsampled (manual-id fallback) |
| Country reservation (migration 0008) | COMPLETE | DB-enforced, PG16 tests re-run this session |
| Role-mapping concurrency (`addRoleMapping` must use the guild lock) | NOT STARTED | known issue A |
| Entity-picker stale-response protection | NOT STARTED / UNVERIFIED | known issue B, no tests |
| Mapping validation / conflict prevention | PARTIAL | kind/type rules and role exclusivity exist |

## Phase 4 — bot administrators and synchronisation
| Item | Status | Notes |
|---|---|---|
| Trusted bot-administrator roles (bot + dashboard) | see Delivery B | implemented in Delivery B |
| Nickname synchronisation | NOT STARTED | needs Manage Nicknames + hierarchy rules |
| Role reconciliation, manual (`/sync`) and scheduled sync, history | UNVERIFIED | durable scheduler + tests (mock/PGlite/PG16); never run on real Discord |
| War / Economy / Hybrid build roles | PARTIAL / BLOCKED | code + migration 0007 exist; the real profile sample has no `skills`, formula provisional |
| Military rank roles | UNVERIFIED | strong tests, never on real Discord |
| Government office roles | UNVERIFIED | foreign-minister raw value unknown |
| Party-specific roles (leader, member, Treasurer, Council) | PARTIAL | Treasurer/Council need the game's role value (admin enters it) |
| Unit-specific roles (Member, Leader, **Owner**) | PARTIAL | per-unit Member/Leader exist; country-wide Owner exists (Delivery B); a per-unit Owner mapping does not |

## Phase 5 — dashboard and management
| Item | Status | Notes |
|---|---|---|
| Players management | PARTIAL | list, approve, force, unlink |
| Audit log UI | UNVERIFIED | |
| Diagnostics | PARTIAL | basic |
| Profile card improvements / designer / per-player messages | PARTIAL / NOT STARTED / NOT STARTED | embed exists; flag blocked; designer and messages not started |

## Phase 6 — polish, security, deployment
| Item | Status | Notes |
|---|---|---|
| Arabic + English | PARTIAL | key parity tested for bot and dashboard; wording review by a native reader pending |
| Responsive RTL | UNVERIFIED | jsdom only, no real browser/screenshots |
| Multi-server isolation, server-side authorisation, CSRF | COMPLETE (sandbox) | API/auth tests incl. new routes; never pen-tested |
| Dockerfile / deployment | UNVERIFIED | never built |

## Test results of this delivery (Delivery B)
| Suite | Backend | Result |
|---|---|---|
| typecheck, 6 packages | – | clean |
| core / aon-client | pure | 103 / 68 passed |
| db | **PG16** (+ PGlite for the new files) | 129 passed |
| sync | **PG16** (+ PGlite for the new file) | 117 passed |
| bot | **PG16** | 107 passed |
| web | **PG16** (+ PGlite for the new files) | 254 passed (10 files) |
Not run: real Discord, live game API, a real browser, the production host. Test-file changes to existing tests: 8 UI tests that assumed a native role `<select>` now use the picker's DOM; 2 tests expect 12 nav items instead of 10; 3 sync tests that created alliance mappings through the API now insert them as legacy rows (the database now refuses a kind the server type does not allow, as the dashboard API always did).
