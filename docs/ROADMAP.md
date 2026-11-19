# Roadmap (v3, approved) — M1.1 and M5a delivered; the rest is not implemented yet

Status: **APPROVED with the default answers to Q1–Q9.** M1.1 + M5a are delivered. Written after M1 was deployed and confirmed in production. Every completed delivery stays as it is (Delivery A, Delivery B, M1). This document adds three requirements to the existing roadmap; it does not redesign the project.

## 1. Roadmap with the new items placed

| Id | Delivery | Contains | Depends on | DB migration | Status |
|---|---|---|---|---|---|
| – | Delivery A | verification ticket panel, global linking, company-name verification | – | 0009, 0010 | **DONE** (production) |
| – | Delivery B | proxy countries, country-wide roles (old model), pickers, trusted admins, guild lock | A | 0011 | **DONE** |
| – | M1 | shared citizen role, per-party / per-unit membership roles, shared president / leader / owner, server-side country isolation | B | 0012 | **DONE** (production) |
| **M1.1** | strict one-party / one-unit membership (**new req. 1**) + read-only API shape probe (see M5a) | hardening of the M1 sync rules | M1 | none (no index: application-level check under the guild lock) | **DELIVERED** (awaiting your production confirmation) |
| **M2a** | optional Unverified-role removal (**new req. 2**) + a shared "verification outcome" result object | verification success path, verification settings card | M1 | 0013 (2 columns on `guilds`) | PLANNED |
| M2b | verification log channel, durable outbox, "new link vs activated in another server" events (original M2) | the outcome object from M2a (roles granted / removed) | M2a | 0014 | PLANNED |
| M3 | names instead of IDs everywhere, verification history search / filters / pagination / detail (original M3) | M2b events table | M2b | none planned | PLANNED |
| M4 | professional dashboard redesign on every page + custom scrollbar (original M4) | – | M3 (so the new tables are redesigned once) | none | PLANNED |
| **M5a** | **evidence for skill data** (read-only API shape probe, run by the bot on a linked account) (**new req. 3, part 1**) | – | – | none | **DELIVERED inside M1.1** — run it and send me the JSON |
| **M5b** | **skill-point based War / Economy / Hybrid classification + role sync** (**new req. 3, part 2**) | M5a evidence **and** owner answers in section 7 | M5a | none planned (role kinds `build_war/eco/hybrid` exist since 0007) | PLANNED, **BLOCKED on data** |
| M5c | remaining original roadmap: nickname synchronisation, per-unit Owner mapping, other PARTIAL items in the phase tables of PROJECT_STATUS.md | – | M5b not required | later | PLANNED |

Order is unchanged for the original items (M2 → M3 → M4 → M5). The new items are inserted as sub-milestones: M1.1 first because it hardens what M1 just shipped; M2a before M2b because the log embed must list roles granted **and** removed by the same operation; M5 is split because its data does not exist yet (section 5).

## 2. Do the three requirements share infrastructure?
* **Req. 1 and req. 3** both live in the sync engine (`member-sync.ts`, `evalMapping`) and both read the player **profile**. They are kept in separate deliveries because req. 3 is blocked on missing data while req. 1 is not.
* **Req. 2** is independent of the sync engine: it only uses the Discord port (`removeRole`, `assignableRoles`) and runs **after** `syncOneUser` in the verification success path (`bot/src/verification.ts`: `checkTicket`, and `openTicket` for an existing global link). It shares the "verification outcome" object with M2b.
* Therefore: three separate deliveries (M1.1, M2a, M5b); nothing is bundled except the harmless read-only probe (M5a), which is offered as an optional passenger of M1.1.

## 3. Requirement 1 — strict one party / one unit membership per player (M1.1)

### 3.1 What exists after M1 (audited in `sync/src/member-sync.ts`) and what is missing
Already true: each `country_party_member` / `country_unit_member` mapping is evaluated against the player's **profile** (`party.id`, `militaryUnit.id`); "member of another entity" is a definite *not qualifies* ⇒ the old role is removed and the new one granted; "no party" removes all; an unreadable / incomplete profile or list removes nothing; idempotent second run (tests prove it).
Gaps to close (these are the real work):
1. **Two role families can coexist.** On a country server a party can have a *generic* `party_member` mapping (Role mappings page, per party) **and** a `country_party_member` mapping, with different Discord roles; a player in that party then gets two party roles. Same for units (`unit_member`). Plan: a "membership family" (party: `party_member` + `country_party_member`; unit: `unit_member` + `country_unit_member`) may hold only one role per entity per server — refused at write time under the existing guild lock (`ROLE_ENTITY_DUPLICATE`), plus a **sync-time invariant**: if more than one membership role of a family would qualify (legacy data), grant none of the extras, never remove anything, and report it in the sync result / audit. An index is added only if the audit of existing rows shows it is safe (otherwise application-level under `lockGuild`, which already serialises all mapping writers).
2. **Membership changes while a sync runs.** The profile is read once at the start of a member's pass. Plan: when the computed plan changes a membership role, re-read the profile once just before writing (one extra API call **only** when a membership change is planned); if the answer differs, recompute once; otherwise apply. The next scheduled run converges anyway; two syncs of the same member are already serialised.
3. **Conflicting data.** Rule set (documented in code and docs): the profile is authoritative for *which* entity the player is in; the country's party / unit list is authoritative only for *whether that entity belongs to the server's country*. Profile entity not in a complete country list ⇒ foreign ⇒ no grant (existing). Profile membership missing / malformed ⇒ unknown ⇒ nothing removed (existing). New explicit case: profile and a second source disagree ⇒ not applicable, because no second source of per-player membership exists in the documented API (`/parties/{id}` and `/units/{id}` are summaries; per-entity member lists would need one call per entity and are **not** planned).
4. **No event source.** The documented `/history` feed has no party / unit join or leave events, so membership changes are noticed only by the periodic / manual / single-user syncs. This is documented, not "fixed".
5. Leadership roles stay shared and independent: president / leader / owner evaluation is untouched (tests assert they survive a membership swap).

### 3.2 Files
`packages/sync/src/member-sync.ts` (family invariant, pre-write re-check), `packages/db/src/guild-repo.ts` (`addRoleMapping`, `setEntityMemberRole`: duplicate-entity refusal), `packages/web/src/app.ts` (error mapping) and `public/app.js` / `i18n.js` (message), docs.

### 3.3 Tests and acceptance criteria
* **A1.1** Exhaustive matrix test: profile party ∈ {none, p1, p2, foreign, unknown/malformed} × mapped entities {p1, p2, p3} × every starting subset of the three roles (8) × list state {ok, error, incomplete}. After one sync the member's party roles are **exactly** the expected set; never more than one; zero removals whenever the evidence is unknown. Same matrix for units. (Deterministic, mock Discord, PGlite **and PG16**.)
* **A1.2** Swap p1→p2 produces exactly one `remove` and one `add` Discord call; second run produces **zero** calls.
* **A1.3** Leaving all entities removes every configured membership role of that family and nothing else.
* **A1.4** Generic + country mapping for the same entity: second save refused (`ROLE_ENTITY_DUPLICATE`); legacy data with both ⇒ at most one granted, nothing removed, reported.
* **A1.5** Mid-run change (fake game flips membership between the first and second profile read): final state equals the new membership after the run; at most one extra profile request, only when a membership change was planned; a run without a membership change makes the same number of requests as today.
* **A1.6** Real PostgreSQL: concurrent single-user syncs + scheduled run + an admin saving mappings for the same member end in the converged state (no duplicate, no lost role); two admins saving different roles for the same entity ⇒ exactly one row.
* **A1.7** Presidents / leaders / owners keep their shared roles across a membership change; dedicated party / unit server tests are unchanged and green.

## 4. Requirement 2 — optional Unverified-role removal after verification (M2a)

### 4.1 Design
* **Where it runs.** After `completeVerification` succeeds **and** the existing role sync (`syncOneUser`, which grants the citizen role) has finished. Recommended scope (needs your confirmation, Q4): both success points — a new verification (`checkTicket`) **and** an existing global link activated in this server (`openTicket`, global branch) — each using **that server's** setting.
* **Order and safety.** Citizen role first (existing flow, unchanged). Then, only if the setting is enabled: if the member currently holds the Unverified role → `removeRole`; if absent → no call, no error. The removal is skipped (and reported) when the sync result shows the member's roles could not be written at all (so nobody is left with neither role; Q4b), when the Unverified role is not removable (missing / deleted / above the bot / managed), or when the configured role is also any role the bot manages (see below).
* **Never removes the wrong role.** The role must exist in **this** server, must not be `@everyone`, integration-managed, a role the bot manages (any `role_mappings` role incl. citizen, proxy, party / unit, president / leader / owner, build roles, rank roles) and the bot must be above it. Enforced when saving the setting **and** when removing, and in the other direction: mapping / rank / proxy / identity / build writers refuse a role that is the configured Unverified role (all under `lockGuild`, so the two cannot race).
* **Retry-safe.** The removal is idempotent. Transient Discord errors (429 / 5xx) are retried once; permission / hierarchy / unknown-role errors are not retried. A failure never changes the verification result or reply; it is written to the existing audit log (`verification.unverified_removal_failed` with the reason) and returned in the shared outcome object so M2b can show it in the log embed ("roles removed" / "removal failed").
* **Default.** Existing installations: **disabled**, no role; no behaviour change (call log identical to today).

### 4.2 Database / API / UI
* Migration `0013` (additive): `guilds.unverified_role_enabled boolean NOT NULL DEFAULT false`, `guilds.unverified_role_id text NULL`, `CHECK (NOT unverified_role_enabled OR unverified_role_id IS NOT NULL)`. (The existing `verification_channel_id` lives in `guilds` too, so this follows the established place; no new table.)
* API: extend the existing verification settings handler (`PUT /api/guilds/:g/verification`, `GET …/verification`) with `unverifiedRole: { enabled, roleId }`; validation through the existing `usableRole` plus the conflict checks above; trusted bot admins may change it like the other verification settings.
* Dashboard: new card on the *Verification* page — toggle + searchable role picker (the existing `rolePicker`, name + colour), inline warnings (above the bot, managed, equals a mapped role, role deleted), Arabic / English / RTL.
* Bot / sync: a small `removeUnverifiedRole` service in `@aon/sync` (testable with the fake Discord), called from `bot/src/verification.ts`.
* Messages: no change to the user-facing success text unless the removal failed (then one neutral line is optional, Q4c).

### 4.3 Tests and acceptance criteria
* **A2.1** Upgrade test: after migration 0013 every existing guild has the feature disabled; verification produces the **same** Discord call log as before (golden comparison).
* **A2.2** Enabled: the Discord log shows citizen `add` **before** Unverified `remove`; the member afterwards has the citizen role and not Unverified.
* **A2.3** Role absent from the member: zero removal calls, no error, verification succeeds. Run the finish step twice: second is a no-op.
* **A2.4** Failure matrix (deleted role, bot lacks Manage Roles, role above the bot, managed role, Discord 429 then success, Discord 5xx persistent): verification still succeeds with its normal statuses; audit entry written; 429 / 5xx retried once, permission errors not retried.
* **A2.5** The configured role equal to citizen / rank / proxy / identity / build / `@everyone` / managed is refused at save **and** at removal time; writers of those roles refuse the Unverified role (both directions, tested with concurrent writers on **PG16**: the two cannot both succeed).
* **A2.6** Per-server isolation: the setting of server A never affects a verification in server B (global link activated elsewhere uses B's own setting).
* **A2.7** API tests (validation matrix, 403 for foreign servers, CSRF) and jsdom tests (toggle, picker, warnings, AR / EN parity). Delivery A tests unchanged and green.

## 5. Requirement 3 — skill-point War / Economy / Hybrid classification (M5a → M5b)

### 5.1 What exists
`@aon/core/builds.ts` classifies from `skills[]` of `GET /players/{id}` (`{code, level, maxLevel}`) using the **average level progress** of two skill groups with thresholds 60 / 15 / 50 and "unclassified"; role kinds `build_war | build_eco | build_hybrid` (migration 0007), dashboard *Build roles*, sync and `/profile` use it. It is **not** the rule you now require (skill-**point** share of the level-based budget, 70 %). `PROJECT_STATUS.md` already lists it as PARTIAL / BLOCKED.

### 5.2 API facts — verified vs unverified (important)
* Verified (project fixtures + API reference): the profile has `level`, `xp`, `prestige`, `rank`, `damage`, `offices`, `party`, `militaryUnit`. `GET /players/{id}/stats` has level / rank / damage / work / trade / company worth.
* **Not verified — and absent from everything we have:** the word "skill" does not occur in the API reference you provided, and the real profile / stats samples contain **no `skills` key**. So today there is **no documented source** for per-skill levels, for the skill catalogue, or for the point-cost schedule. I cannot reach the live game from my sandbox, so I cannot check it myself, and I will not invent it.
* The only hint I found is a community article about a *different* game (WarEra): it says 4 points per level and that the cost of a skill level rises with the level (e.g. level *n* costs *n* points). That is **not** evidence for Age of Nations and will not be used unless the AoN data confirms it.

### 5.3 M5a — evidence step (read-only, no role changes)
A diagnostic that, for the **administrator's own linked account** (the id is taken from the existing link; nobody types an id), calls the already-documented `GET /players/{id}` and `GET /players/{id}/stats`, and shows the **shape only**: key names, nested key names, value types, and any key containing "skill" / "point" (values of skill levels only, nothing private), plus a downloadable redacted JSON. Output goes to the existing Diagnostics page and the audit log. Outcomes: (a) the API exposes per-skill levels and costs ⇒ M5b proceeds; (b) it exposes only totals (e.g. spent points per group) ⇒ M5b adapts; (c) no skill data at all ⇒ M5b is **BLOCKED by the game API**, and I say so instead of guessing. If you prefer, M5a ships inside M1.1 so the evidence arrives while M2–M4 are built.

### 5.4 M5b — design (to be finalised after M5a)
* **Budget** `B = 4 × (level − 1)` (your table: 10→36, 20→76, 29→112, 30→116, 40→156, 50→196). Level missing, non-integer, < 1 ⇒ insufficient.
* **Invested points per skill** = cumulative cost of reaching its current level from the **actual** schedule (from the API if it gives it; otherwise a documented table verified against M5a data). A skill whose cost cannot be determined ⇒ the whole classification is *insufficient* (never partial), because one unknown skill could move the result.
* **Groups** (documented per skill with the game effect; the existing provisional lists are **not** assumed correct): proposal pending catalogue evidence — *offensive*: attack, criticalChance, criticalDamages, precision; *economic*: production, entrepreneurship, companies (limit), management; *other (never scored)*: armor, dodge, health (defensive), energy, stamina, hunger, lootChance (to be decided from its effect). Note the current code counts armor / dodge / health and lootChance as war; your new text separates defensive skills, so this is a deliberate change that needs your approval (Q6).
* **Classification**, exact integer arithmetic (no floating point): `war` if `offensive × 10 ≥ B × 7`; `eco` if `economic × 10 ≥ B × 7`; otherwise `hybrid`. Both cannot hold at once (70 % + 70 % > 100 %). `B = 0` (level 1) ⇒ insufficient (no division). Invested > B (inconsistent data) ⇒ insufficient. Unused points stay in the denominator.
* **Consequence to confirm (Q7):** because unused points count in the denominator, a player who has spent few points is **Hybrid**.
* **Roles**: existing kinds `build_war/eco/hybrid` (no DB change); a definite result gives exactly one role and removes the other two; `insufficient` never changes roles (existing safe behaviour). The old `unclassified` result disappears (becomes Hybrid). Profile card and Build roles page text updated.
* Files: `packages/core/src/builds.ts` (+ tests), `aon-client` mapper for the skill fields (if present), `sync/src/member-sync.ts` (build block already isolated), `bot/src/profile-card.ts`, dashboard Build roles page text, docs.

### 5.5 Tests and acceptance criteria (M5b)
Integer examples (assuming a verified cost schedule). Note: at level 29, B = 112 and 70 % = 78.4, so "exactly 70 %" cannot occur there; the boundary is **79 points qualifies, 78 does not**. Exactly-70 % cases need B divisible by 10: level 6 (B = 20 → 14), 11 (40 → 28), 16 (60 → 42), 21 (80 → 56), 26 (100 → 70), 36 (140 → 98).
* **A3.1** L29, 79 offensive points ⇒ War; 78 ⇒ Hybrid. L29, 79 economic ⇒ Eco.
* **A3.2** L29, 50 offensive + 50 economic ⇒ Hybrid. L29, 20 invested in total ⇒ Hybrid (unused points counted).
* **A3.3** Exactly 70 % at L6 / L11 / L26 for war and for eco ⇒ the specialist role (inclusive threshold).
* **A3.4** Different levels (10, 20, 29, 30, 40, 50) with the same *share* give the same class; the same *absolute* points give different classes (denominator is per player, never fixed).
* **A3.5** Other / defensive skills never inflate offensive or economic scores (same offensive points, add defensive points ⇒ share unchanged).
* **A3.6** Invalid data matrix (skills missing / not an array, duplicate codes, negative or fractional level, level above max, unknown skill code, cost unknown, invested > budget, level missing or 1) ⇒ `insufficient`, **no role changes**, no exception, deterministic output (run twice, equal).
* **A3.7** Sync: class change swaps the role (one remove + one add), second run zero calls; failed / incomplete profile removes nothing.
* **A3.8** Old tests of the previous formula are replaced (listed in the delivery report); dashboard + AR / EN parity tests.
* **A3.9** Delivery gate: the report states which of the skill fields were **verified against real API output** (from M5a) and which were not.

## 6. All affected areas (summary)
| Area | M1.1 | M2a | M5a | M5b |
|---|---|---|---|---|
| Database / migrations | maybe 1 index | 0013 | – | – |
| Backend API (web) | error mapping | verification settings | diagnostics route | – |
| Discord bot | – | verification success path | probe command / button | `/profile` card |
| Sync engine | family invariant, pre-write re-check | new small service | – | build block |
| Verification system | – | yes | – | – |
| Dashboard UI | message | new card | diagnostics panel | build-roles text |
| Age of Nations API integration | – | – | read-only probe of documented endpoints | skill fields mapper |
| Tests / docs | A1.x | A2.x | probe tests | A3.x |

## 7. Unresolved questions (please answer or approve my defaults)
* **Q1 (req. 1)** If the profile says the player is in party X but the country party list cannot be read, should X's role be granted anyway? *Default: no* (keep the foreign-entity protection; roles follow once the list is readable; other membership roles are still removed because the profile is definitive).
* **Q2 (req. 1)** May I add one database index to forbid two membership roles for one entity across the generic and country kinds, if the audit shows it is safe? *Default: application-level check only.*
* **Q3 (req. 1)** Ship the read-only probe (M5a) inside M1.1? *Default: yes, it is read-only.*
* **Q4 (req. 2)** (a) Apply the removal also when an already-verified player activates the existing link in another server? *Default: yes.* (b) If the role sync after verification did not complete, keep the Unverified role and report it? *Default: yes.* (c) Add one neutral line to the user's reply if the removal failed? *Default: no, audit only.*
* **Q5 (req. 2)** Also enforce "no Unverified role on verified members" at every later sync? *Default: no — only at verification time, as you described.*
* **Q6 (req. 3)** Approve moving armor / dodge / health (and decide lootChance) out of "war" into "other"? Needs the game's skill catalogue from M5a.
* **Q7 (req. 3)** Confirm that a player with few spent points is **Hybrid** (the literal result of your rule).
* **Limitation L1** No documented skill data exists today (section 5.2). M5b cannot be finished until M5a shows the real structure; if the API does not expose it, only the game's operator can unblock it.
* **Limitation L2** Nothing here has been or can be verified against real Discord / the live game from my sandbox.

## 8. Unchanged rules
Delivery A, Delivery B and M1 behaviour is preserved. Delivery workflow unchanged: you approve a milestone, I implement, test and document it completely, deliver a changed-files-only ZIP (verified on a clean copy), you apply, deploy and confirm in production before the next milestone.
