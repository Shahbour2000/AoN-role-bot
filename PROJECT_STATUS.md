# AoN Role Bot — project status

Updated for **Delivery A: customizable verification ticket panel published from the dashboard** (on top of Phase 1, global linking + company-verification tickets). Base: the repository as uploaded after the dashboard hotfix
(no `.git` metadata in the upload, so no commit hash can be stated). Statuses: **COMPLETE** implemented and verified · **PARTIAL** implemented but
incomplete · **UNVERIFIED** implemented but not sufficiently tested (see "Evidence") · **BLOCKED** genuine external limitation · **NOT STARTED**.

**Evidence levels used below:** *mock* = fakes for Discord / game API · *PGlite* = in-process PostgreSQL · *PG16* = real PostgreSQL 16 server ·
*jsdom* = simulated browser. **Nothing has been verified against real Discord, the live game API, a real browser, or the production host.**

## Roadmap requested by the owner (priority order) — where each item stands
| # | Requirement | Status |
|---|---|---|
| 1 | Verification dashboard: settings, publish panel from the dashboard, customization, stats/history, localization | **Delivery A below: implemented, tested on mocks/PGlite/PG16/jsdom; never run on real Discord** (stats, channel selector, history and translations were already fixed in the previous delivery and are untouched) |
| 2 | Proxy countries | NOT STARTED |
| 3 | Country-wide party / military-unit identification roles | NOT STARTED |
| 4 | Searchable role / party / unit / country selectors | NOT STARTED (an earlier partial picker exists, see Phase 2/3 tables) |
| 5 | Trusted bot administrators (roles other than Discord Administrator) | NOT STARTED. The dashboard gate is a single function, so this plugs in later. |
| 6 | Guild-level lock shared by server-type change and mapping update; stale-response protection in entity pickers | NOT STARTED (known issues A and B) |

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
| Proxy Countries section (add/remove, country picker from API list, proxy-citizen role) | NOT STARTED | rule now defined (proxy country belongs to Egypt; citizens keep Egyptian server access; Proxy Citizen role) |
| Proxy removal reconciliation | NOT STARTED | design needed: never delete unrelated roles |
| Country server: Party Member / Party President (any party of the server's country) | NOT STARTED | today's `party_member`/`party_leader` are bound to ONE party. Needs party→country index from `/countries/{c}/parties` |
| Country server: Unit Member (ANY unit, any country) / Unit Leader / Unit Owner (units of the server's country only) | NOT STARTED | needs `/countries/{c}/units` (`countryId`, `ownerId`); no `unit_owner` kind exists |
| Discord role selector with real colours | NOT STARTED | `/roles` API returns `color`; UI is a plain `<select>` |
| Party/unit selectors with logos, country-filtered | PARTIAL | searchable pickers exist; **no verified logo field** → initials fallback to be built |

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
| Trusted bot-administrator roles (bot + dashboard) | NOT STARTED | |
| Nickname synchronisation | NOT STARTED | needs Manage Nicknames + hierarchy rules |
| Role reconciliation, manual (`/sync`) and scheduled sync, history | UNVERIFIED | durable scheduler + tests (mock/PGlite/PG16); never run on real Discord |
| War / Economy / Hybrid build roles | PARTIAL / BLOCKED | code + migration 0007 exist; the real profile sample has no `skills`, formula provisional |
| Military rank roles | UNVERIFIED | strong tests, never on real Discord |
| Government office roles | UNVERIFIED | foreign-minister raw value unknown |
| Party-specific roles (leader, member, Treasurer, Council) | PARTIAL | Treasurer/Council need the game's role value (admin enters it) |
| Unit-specific roles (Member, Leader, **Owner**) | PARTIAL | Owner kind missing |

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

## Test results of this delivery (Delivery A)
| Suite | Backend | Result |
|---|---|---|
| typecheck, 6 packages | – | clean |
| core / aon-client | pure | 103 / 66 passed |
| sync | PGlite; PG16 | 96 passed; 96 passed |
| bot | PGlite; PG16 | 104 passed; 104 passed |
| db | PGlite; PG16 | 114 passed; 114 passed |
| web | PGlite | 219 passed (8 files) |
Not run: real Discord, live game API, real browser, production host. The previous delivery's web baseline had one crashed worker when six suites ran in parallel; suites were run one package at a time here.
