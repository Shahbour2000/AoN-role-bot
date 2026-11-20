# AoN Role Bot — project status

Updated for **M2a (optional Unverified-role removal, section "M2a — this delivery")**, on top of **M1.1 (strict one-party / one-unit membership + API data probe)**, on top of **M1 (role-system corrections)**, on top of **Delivery B: proxy countries, country-wide party/unit roles, searchable role & entity pickers, trusted bot administrators, guild-lock concurrency fix** (on top of Delivery A, which the owner tested on the live server and accepted, and Phase 1). Base: the repository as uploaded after the dashboard hotfix
(no `.git` metadata in the upload, so no commit hash can be stated). Statuses: **COMPLETE** implemented and verified · **PARTIAL** implemented but
incomplete · **UNVERIFIED** implemented but not sufficiently tested (see "Evidence") · **BLOCKED** genuine external limitation · **NOT STARTED**.

**Evidence levels used below:** *mock* = fakes for Discord / game API · *PGlite* = in-process PostgreSQL · *PG16* = real PostgreSQL 16 server ·
*jsdom* = simulated browser. **Nothing has been verified against real Discord, the live game API, a real browser, or the production host.**

> **ROADMAP v3 (approved):** three requirements were added after M1 (strict one-party / one-unit membership, optional Unverified-role removal, skill-point War / Eco / Hybrid). M1.1 and the probe M5a are in production; M2a is delivered; M2b, M3, M4, M5b, M5c are not implemented. The probe output UNBLOCKED M5b (skill data confirmed; the Prestige budget is the one open point): see `docs/ROADMAP.md` section 5.6. The owner's sync-result-embed request is placed in M2b (section 9). The complete updated roadmap, design, test plan, acceptance criteria and open questions are in **`docs/ROADMAP.md`**. New order: M1.1 → M2a → M2b → M3 → M4 → M5a → M5b → M5c. The skill-based classification (M5b) is **BLOCKED on data**: the API reference and the real profile samples contain no skill information.

## Roadmap requested by the owner (priority order) — where each item stands
| # | Requirement | Status |
|---|---|---|
| 1 | Verification dashboard + customizable ticket panel published from the dashboard | **COMPLETE — accepted by the owner after testing on the live Discord server (Delivery A)**. A stray "null" text seen in the owner's screenshots was fixed in Delivery B. |
| 2 | Proxy countries | **Delivery B + M1 (proxy roles may share the citizen role).** Tested on mock / PGlite / PG16 / jsdom. Not yet run on real Discord. |
| 3 | Country party / military-unit roles | **M1: corrected model — one membership role per party / unit + shared Party President, Unit Leader, Unit Owner; server-side country isolation.** Same evidence level. Depends on two unverified API facts, see "Known limitations". |
| 4 | Searchable role / party / unit / country selectors | **Delivery B: role picker (real names + colours) and image-or-initials entity pickers.** Role picker is used on the Roles, Builds, Ranks, Country-roles and Bot-administrators pages. |
| 5 | Trusted bot administrators | **Delivery B: implemented (dashboard + slash commands); never run on real Discord.** |
| 6 | Guild-level lock (server type vs mappings); stale-response protection in pickers | **Delivery B: both fixed.** Lock proven on real PostgreSQL 16 (red/green); stale fix has a red/green test for one of two scenarios. |
| – | Phase 3-6 items from the older plan (nickname sync, build roles formula, alliance, …) | unchanged, see the older phase tables below |

## M2a — this delivery (optional Unverified-role removal after verification)
| Requirement (docs/ROADMAP.md §4) | What exists now | Status | Evidence |
|---|---|---|---|
| Optional, disabled by default | migration `0013`: `guilds.unverified_role_enabled` (default false) + `unverified_role_id`; DB checks (enabled needs a role, id format) | COMPLETE (code) | db migration upgrade test on **PG16 and PGlite** |
| Dashboard setting: toggle + searchable role selector | *Verification* page card; API `PUT /api/guilds/:g/verification/unverified-role`; `GET .../verification` returns the setting; AR / EN | COMPLETE (code) | API 4, jsdom 2 |
| Validation | role must exist in THIS server, not @everyone / integration / dangerous, below the bot and manageable (`role_not_removable`), not a role the bot manages (409 `role_conflict`); a disabled setting may keep a deleted role | COMPLETE | API matrix, db tests |
| Never removes the citizen role or other managed roles | refused when saving; mapping / proxy / identity / entity / build / rank writers refuse the role once enabled (under the guild lock); a last guard before removing re-checks `role_mappings` + ranks | COMPLETE | db tests incl. a concurrent-writer race on **PG16**, sync tests (settings bypassed => skipped) |
| Order: existing verification and citizen role first, then removal | `verification.ts`: `syncNote` (grants roles) then `removeUnverifiedRole`; call log shows grant before removal | COMPLETE | bot flow tests (real ticket flow) |
| Both success points | new verification (`checkTicket`) and an existing global link activated in this server (`openTicket`), each with that server's own setting | COMPLETE | bot flow test |
| Retry-safe, idempotent, never breaks verification | absent role = no call; second run no-op; transient errors retried once; permanent errors not retried; unexpected throw caught; reply text identical to the disabled case | COMPLETE | sync 10, bot 7 |
| Hierarchy / permission / deleted role / Discord outage handling | `role_not_removable` skip without an attempt; 50013 `missing_permissions`, 10011 and 10007 moot; every outcome audited | COMPLETE (mock Discord) | sync tests |
| Existing behaviour preserved | disabled => call log and reply identical to before; Delivery A, B, M1, M1.1 tests unchanged and green | COMPLETE | all suites |
| Roadmap docs updated with the M5a evidence | `docs/ROADMAP.md` 5.6 / 5.7 (skill groups, cost schedule, rule, Prestige open point), section 9 (sync embeds in M2b) | COMPLETE (docs) | – |

**Decisions taken (defaults you approved):** removal at both verification points; kept when the role synchronisation did not complete; no extra line in the reply; removal only at verification time (not at every sync).

**Limitations (M2a)**
1. A member who is not verified through the bot (admin force-link, legacy links) keeps the Unverified role: the feature runs only on verification / link activation.
2. If the removal fails (e.g. the bot lost Manage Roles) the member keeps the role until an administrator removes it by hand; the failure is in the audit log (`verification.unverified_removal_failed`), not shown in the dashboard yet (the verification log channel in M2b will show it).
3. "Sync did not complete" is decided from the role synchronisation result of that member (error, or any role the bot could not write); a role blocked for an unrelated reason also keeps the Unverified role (conservative).
4. Not run: real Discord, the live game API, a real browser, production.
5. Not done in this delivery by design: the sync-result embeds (M2b), M3, M4, M5b.

## M1.1 (previous delivery: strict one-party / one-unit membership + read-only API data probe)
| Requirement (docs/ROADMAP.md §3, §5.3) | What exists now | Status | Evidence |
|---|---|---|---|
| A player holds at most ONE party membership role and ONE unit membership role | sync: if more than one DIFFERENT role of a membership family would qualify (legacy / ambiguous data) none is granted, nothing is removed, `membership_conflict` is reported; writers refuse a second membership role for one entity (`ROLE_ENTITY_DUPLICATE`, HTTP 409) across the generic (`party_member` / `unit_member`) and country (`country_*_member`) kinds | COMPLETE (code) | sync, db, API tests on PG16 |
| Move party / unit → old role removed, new granted; leave → all removed; never on unknown data | exhaustive matrices: 6 profile states × 8 starting role subsets × 3 list states for parties and for units (144 combinations each) compared with an independent oracle; swap = exactly 1 remove + 1 add, next run 0 Discord calls | COMPLETE (code) | sync (mock Discord / mock game) |
| Shared Party President / Unit Leader / Unit Owner independent of membership | tests: president survives a party switch and goes only with leadership; owner outside a unit; commander keeps Leader across a unit switch | COMPLETE (code) | sync |
| Membership changing while a sync runs | when a membership role change is about to be written the profile is re-read ONCE (no extra request otherwise); if the membership differs the plan is recomputed; a failed re-read keeps the first read and reports `profile_recheck` | COMPLETE (code) | sync; overlapping syncs of one member on **real PG16** converge and never hold two party roles |
| Malformed / incomplete / conflicting data | profile error / rate-limited / malformed `party` / `militaryUnit` and list error / incomplete: nothing removed (matrices) | COMPLETE (code) | sync |
| Dedicated party / unit servers | mappings without a game reference are outside the new rules (two roles for the dedicated party still both granted) | COMPLETE (code) | sync |
| Concurrency of mapping writers | generic and country writers racing for one party leave exactly one distinct role (guild lock) | COMPLETE | db tests on **PG16** (and PGlite) |
| M5a: read-only API data probe (new) | Diagnostics page button -> `GET /api/guilds/:g/diagnostics/api-shape`: for the administrator's OWN linked account (player id from the global link, never from the browser) it calls the documented `/players/{id}` and `/players/{id}/stats` and returns only key paths and types plus skill-related numbers (`@aon/core` `describeShape`); strings are never copied; audited; AR/EN | COMPLETE (code), **not run against the live game** | core 4, API 2, jsdom 1 |

**What to do with the probe (blocks M5b):** after deploying, open *Diagnostics -> Inspect my linked account*, press *Copy result (JSON)* and send it to me. It contains no name, id or text value. It will show whether the game exposes skills (and in which fields). M5b (skill-point War / Eco / Hybrid) cannot be finished without it.

**Decisions taken (defaults you approved):** profile decides which entity the player is in, the country's party / unit list only proves the entity belongs to the country; no extra database index (guild-lock application check instead, no migration in this delivery); the probe ships inside M1.1; no migration.

**Limitations (M1.1)**
1. Membership changes are noticed only by periodic / manual / single-user syncs (the documented `/history` feed has no party / unit join or leave events).
2. If a legacy configuration gives one party two different roles the bot grants neither and reports `membership_conflict`; the dashboard does not show that report yet (visible in sync results / audit); new duplicates are refused at save time.
3. Not run: real Discord, the live game API (so the probe's real output is unknown), a real browser, production.
4. A flaky test was fixed: `reconcile.test.ts › two simultaneous /sync all` now holds the first run open (`delayMs`) instead of racing; it failed intermittently before M1.1 on the untouched code.

## M1 (previous delivery, role-system corrections)
| Requirement | What exists now | Status | Evidence |
|---|---|---|---|
| Shared citizen role for proxy countries | exception limited to own-country `citizen` (no game ref) ⇄ `proxy_citizen`; all other duplicate-role protection kept | COMPLETE (code) | db 20 + sync 29 + web API; **PG16 and PGlite** |
| Sync of the shared role: grant, removal, nationality change, no removal while uncertain, no churn | union rule of `planRoleChanges`; proxy→proxy change makes no Discord call | COMPLETE (code) | sync tests (mock Discord / mock game) |
| Party membership: one role per party | `country_party_member`, `game_ref` = party id; unique per (server, party); NOT VALID check for new rows | COMPLETE (code) | db, sync, API, jsdom |
| Party President: one shared role | `country_party_president` unchanged | COMPLETE (code) | sync |
| Unit membership: one role per unit | `country_unit_member`, `game_ref` = unit id | COMPLETE (code) | db, sync, API, jsdom |
| Unit Leader (commander) and Unit Owner (`ownerId`): one shared role each, independent | unchanged evaluation; tests for member+leader+owner of one unit, leader-not-owner, owner-not-leader, owner outside the unit | COMPLETE (code) | sync |
| Dashboard selectors: only the server's country, name + logo/initials, searchable | `GET /country-entities/:type`, scoped `AON.entityPicker`; shared roles have no selector | COMPLETE (code) | API 13, jsdom 5 |
| Strict server-side isolation | server uses its configured country; `countryId` from the browser → 422; PUT / POST re-check membership in the country list; a foreign unit inside the list is refused; game down → 503 (never saved on a guess) | COMPLETE (code) | API tests incl. smuggled unit |
| Safe sync: incomplete data, idempotency, switching party / unit / leadership / ownership / nationality | see tests; lists fetched once per run | COMPLETE (code) | sync (25-member run, second run = 0 Discord calls) |
| Migration 0012 on an existing database | additive; legacy rows preserved byte-for-byte (test upgrades a Delivery-B-shaped schema with legacy rows) | COMPLETE (code) | db migrate test on **PG16 and PGlite** |
| Dedicated party / unit server configurations | unchanged; new kinds refused there | COMPLETE (code) | sync + db tests |
| Real-PostgreSQL concurrency | same entity saved by 3 admins ⇒ 1 row; 3 writers grab one Discord role ⇒ exactly 1 wins; existing guild-lock race tests | COMPLETE | **PG16** (also pass on PGlite) |

**Remaining limitations (M1)**
1. Legacy "any party / any unit" rows are not auto-deleted and members keep the old Discord role until the admin removes it by hand (deliberate: no destructive change on deploy). Your screenshot shows them unset, so this should be a no-op in production.
2. Removing or replacing a party / unit role stops managing the old Discord role; members keep it until removed by hand (same behaviour as proxy roles).
3. A party / unit mapped before it left the country is flagged "no longer part of this country" and stops granting, but is not deleted automatically.
4. The generic per-party / per-unit mappings on the Role mappings page still exist for country servers (now with the same country check); the Country roles page is the intended place for the whole-country model.
5. Parties and countries have no image in any API sample ⇒ initials; units show `logoUrl` only if https. Nothing here was verified against the live API.
6. **Pre-existing flaky test** (not caused by M1): `reconcile.test.ts › two simultaneous /sync all` failed in 2 of 10 runs on the untouched upload on this single-CPU sandbox (timing: the second sync sometimes starts after the first finished).
7. Not run: real Discord, the live game API, a real browser, production.
8. Next milestones are not started: M2 verification log channel, M3 names instead of IDs + history, M4 dashboard redesign + scrollbar, M5 remaining roadmap (nickname sync, build classification evidence).

## Delivery B (previous delivery)
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
4. A proxy mapping that is removed stops being managed: members keep the Discord role until it is removed by hand (if that role is also the citizen role, citizens keep it as before).
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
| War / Economy / Hybrid build roles | PARTIAL / BLOCKED | code + migration 0007 exist with the OLD level-progress formula; superseded by the skill-point 70 % rule (roadmap M5a/M5b). The real profile sample has no `skills` and the API reference never mentions skills |
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

## Test results of M2a (this delivery)
| Suite | Backend | Result |
|---|---|---|
| typecheck, 6 packages | – | clean (no separate build script exists in the repository) |
| core / aon-client | pure | 107 / 68 passed |
| db | **PG16** (new files also PGlite) | 143 passed |
| sync | **PG16** | 147 passed |
| bot | **PG16** | 114 passed |
| web | **PG16** | 282 passed (11 files) |
Real PostgreSQL 16.15 for migrations / locking / concurrency; everything else is mock / jsdom. **Not run:** real Discord, the live game API, a real browser, production.

## Test results of M1.1 (previous)
| Suite | Backend | Result |
|---|---|---|
| typecheck, 6 packages | – | clean |
| core / aon-client | pure | 107 / 68 passed |
| db | **PG16** (changed file also PGlite) | 138 passed |
| sync | **PG16** (new file also PGlite; the real-server overlap test is PG-only) | 137 passed |
| bot | **PG16** | 107 passed |
| web | **PG16** (new API file also PGlite) | 276 passed (11 files) |
Real PostgreSQL 16.15 for migrations / locking / concurrency; everything else is mock / jsdom. **Not run:** real Discord, the live game API, a real browser, production.

## Test results of M1 (previous)
| Suite | Backend | Result |
|---|---|---|
| typecheck, 6 packages | – | clean |
| core / aon-client | pure | 103 / 68 passed |
| db | **PG16** (changed files also on PGlite) | 135 passed |
| sync | **PG16** (changed file also on PGlite) | 125 passed (one earlier run hit the pre-existing timing flake described in limitation 6; the rerun was green) |
| bot | **PG16** | 107 passed |
| web | **PG16** (new API file also on PGlite) | 272 passed (11 files) |
Real PostgreSQL 16.15 was installed in the sandbox for these runs (migrations, locking, concurrency). Everything else is mock / jsdom. **Not run:** real Discord, the live game API, a real browser, the production host.

## Test results of Delivery B (previous)
| Suite | Backend | Result |
|---|---|---|
| typecheck, 6 packages | – | clean |
| core / aon-client | pure | 103 / 68 passed |
| db | **PG16** (+ PGlite for the new files) | 129 passed |
| sync | **PG16** (+ PGlite for the new file) | 117 passed |
| bot | **PG16** | 107 passed |
| web | **PG16** (+ PGlite for the new files) | 254 passed (10 files) |
Not run: real Discord, live game API, a real browser, the production host. Test-file changes to existing tests: 8 UI tests that assumed a native role `<select>` now use the picker's DOM; 2 tests expect 12 nav items instead of 10; 3 sync tests that created alliance mappings through the API now insert them as legacy rows (the database now refuses a kind the server type does not allow, as the dashboard API always did).
