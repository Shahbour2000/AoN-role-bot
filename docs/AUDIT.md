# AoN Role Bot — technical audit and requirements checklist

Audit date: 2026-11-08. Base: repository `Shahbour2000/AoN-role-bot`, single commit `5d36246` (which already contains the Phase 1 "builds" delivery).
Method: read of the code and docs, `tsc --noEmit` on every package, test runs, and the provided OpenAPI file.

## Evidence limits (read first)
- **The game API was not reachable** from the audit sandbox (only package registries / GitHub are allowed), so **no live response was fetched**.
- The provided OpenAPI file lists endpoints, parameters, limits (60 req/min/IP, 30 s cache, money = string in 1/10 000) and that
  `GET /players/{id}/companies` takes `limit` (max 100) / `offset`. **Every 200 response is declared as a free-form object**: it documents
  no response fields. Field names therefore come only from the owner's earlier real samples, preserved as test fixtures
  (`packages/aon-client/test/fixtures.ts`), and are not re-verified here.

## Findings
| # | Finding | Evidence | Severity | Status after this delivery |
|---|---|---|---|---|
| 1 | Setup UI offered `alliance` as a community type; the API rejects it (`z.enum` without alliance) → saving failed with a validation error. Also showed an "alliance not available yet" note (advertises it). | `public/app.js`, `src/app.ts:201` | Bug | **Fixed** (UI no longer offers it; a legacy stored value is shown only as a disabled localized "Closed") |
| 2 | `/profile` showed the raw country **ID** as the country label. | `profile-card.ts` | Bug | **Fixed** for the ID (name only; row omitted when the name is unknown). The **flag is not implemented** — see 6 |
| 3 | Build classification (War/Eco/Hybrid) reads a `skills[]` array from `GET /players/{id}`. **The real profile sample in the fixtures has no `skills` key**; the skill groups and thresholds are the owner's provisional candidates. | `builds.ts`; `fixtures.ts` `profileAbuDujana` | Unverified feature | **Not changed.** Behaviour is already non-destructive: with no `skills` the result is `insufficient` and no role changes. Needs one real profile sample that contains skills, plus the owner's approval of the formula |
| 4 | Setup still uses raw ID text inputs for country / party / unit. | `app.js` | Missing requirement | Open (Phase 2) |
| 5 | Unit **owner** vs **leader**: the unit list exposes `ownerId`/`ownerName`; the profile exposes `militaryUnit.role: 'commander'`. Whether several "leaders" exist is unknown. Party roles seen: `leader`, `commander` only; treasurer / council values unknown. | fixtures, `PROJECT_STATUS.md` | API data gap | Open; needs real samples |
| 6 | `GET /countries` was never sampled; no verified country name/flag field. | `MAPPING_STATUS` | API data gap | Name extractor is **tolerant and unverified**; no flag until a sample shows a flag/ISO field |
| 7 | Ownership proof via company names is feasible with the documented `GET /players/{id}/companies` (paged by `limit`/`offset`; response `total`/owner fields **unverified**). Existing link flow is explicitly "ownership not proven". | OpenAPI, `docs/LINKING.md` | Missing requirement | Open (Phase 3) |
| 8 | No test run against real Discord, the live API, a real browser, or Docker (stated by the previous author; still true). | `PROJECT_STATUS.md` | Limitation | Unchanged |
| 9 | Full test suite is slow (PGlite, ~5 s per DB test): running all packages at once exceeds a 5-minute shell limit. Not a failure. | observed | Info | — |

## Requirements checklist (status at end of Phase 1)
| Area | Requirement | Status |
|---|---|---|
| Foundation | Audit + previous ZIP review | Done (this file) |
| Foundation | Alliance mismatch | Fixed |
| Foundation | Nova-inspired redesign, landing page, responsive/RTL | **Not started** |
| Config | Searchable country/party/unit selectors | Not implemented |
| Roles | Country/Party/Unit role sets, Council, Owner vs Leader | Partially present (earlier work); data gaps above |
| Proxy citizens, country reservation | | Not implemented |
| Verification tickets, nickname sync | | Not implemented |
| Builds | Verified formula | Blocked (needs real skills data + approval) |
| Profile | Country name | Done; flag blocked; conditional Government/Congress, designer: not implemented |
| Ranks, players, sync, audit, diagnostics redesign | | Not implemented |
