# Server types, entity selectors and country reservation

## Server types
`general`, `country`, `party`, `military_unit`. **Alliance is not configurable.** A server that already stores `alliance` keeps its type, its alliance id and its `alliance_*`
mappings untouched (shown only as a disabled, localized "Closed" option); nothing in this feature deletes alliance data.

| Type | Role kinds a mapping may use | Modules offered |
|---|---|---|
| country | president, vice_president, minister_defense/foreign/economy, congress, government_role, citizen, party_member, party_leader, unit_member, unit_leader | government, party, unit, ranks |
| party | party_leader, party_member, party_role (game-defined roles such as treasurer/council, taken from the game's own role value) | party, ranks |
| military_unit | unit_leader, unit_member | unit, ranks |
| general | everything except alliance | all four; country optional (not reserved) |

Source of truth: `packages/core/src/community.ts` (used by the API, the database layer and, via the settings response, the dashboard).
Not in this phase: `unit_owner`, a dedicated council/treasurer kind, proxy citizens (they need sync-engine support and verified data).

### Changing the type
The API refuses a change that would leave mappings the new type cannot use (`409 incompatible_mappings`, with the list) and saves nothing. The dashboard shows
exactly those mappings and requires an explicit tick. On confirmation the database removes them **in the same transaction** as the type change (rows locked, audited as
`mapping.removed_by_type_change`). Build-role mappings and legacy alliance mappings are never removed. Discord roles are never touched, only the mappings.
Modules the new type does not offer are switched off and reported in the response (`notices.coercedModules`). Stored entity ids (party, unit, country) are kept.

## Entity selectors
`GET /api/guilds/:id/entities/{country|party|unit}?q=&limit=&offset=&countryId=` (manager only, 120 requests/min/user), and
`GET /api/guilds/:id/entities/:type/:entityId` (display name of the current selection; never fails the page). Lists are cached 5 minutes server-side, searched and paginated
on the server; failures are not cached. Only `id` and `name` leave the server.

| Source | Status |
|---|---|
| a country's parties (`GET /countries/{id}/parties`) | **verified** against real samples |
| a country's units (`GET /countries/{id}/units`) | **verified** against real samples |
| country list (`GET /countries`) | **UNVERIFIED shape**; tolerant extractor (array or `{countries:[{id,name}]}`); anything else => `game_incomplete` and the dashboard offers manual ID entry |
| global unit search (`GET /units?search=`) | endpoint and parameters documented, **response shape UNVERIFIED**; read with the verified list extractor |
| single party / unit name (`GET /parties/{id}`, `/units/{id}`) | **UNVERIFIED**; only a top-level string `name` is read, otherwise "selected (name unavailable)" |

No flag or image is shown. No sample has ever shown a flag/ISO field for countries or an image for parties; the unit sample has a `logoUrl` field (null in the sample), but its host
is unknown and the dashboard's CSP only allows `'self'` and Discord's CDN, so a neutral initials avatar is used. A Party/Unit server's country picker is only a search filter and is not saved.

## Country reservation (migration 0008)
* `country_reservations(guild_id PRIMARY KEY, country_id, reserved_at)` + `UNIQUE (lower(country_id))`: a server holds at most one country, a country is held by at most one server (case-insensitive).
* A trigger on `guilds` keeps the table in step with `country_id`/`community_type` **inside the same statement**, so no code path (dashboard, bot, scripts, concurrent requests) can bypass it; a conflicting claim aborts the whole update/transaction (`unique_violation`, mapped to `409 country_reserved`).
* Only **country**-type servers reserve. Party/unit/general servers may store a country without reserving it.
* Release happens only through the authorized, audited `DELETE /api/guilds/:id/country` (Manage Server on that guild + CSRF), or by moving to another free country / leaving the country type with confirmation. Saving an empty country field is refused (`use_release_endpoint`).
* **A reservation is a first-come claim. It does not prove the Discord administrator has any authority over the country in the game**; no official API data proves that, and the dashboard says so. Disputes: contact `abudujana15` (no automatic DM or override exists).
* Existing data: among servers that already share a country, the **oldest** keeps the reservation. The others are not changed or cut off; they keep working, the dashboard shows a notice, and they cannot claim another taken country. Find them with
  `SELECT lower(country_id), count(*) FROM guilds WHERE community_type='country' AND coalesce(country_id,'')<>'' GROUP BY 1 HAVING count(*)>1;`
* The dashboard never reveals which other server holds a country.
