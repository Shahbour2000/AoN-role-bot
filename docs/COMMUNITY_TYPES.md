# What each server type supports

Every server configures itself in the dashboard (community type, the game entity — country / party / unit — and which modules are on).
The community type only *suggests* modules; roles are always independent of each other. A player may hold several roles at once whenever the
game data says they qualify; the bot adds **no** exclusivity except the military-rank group (below).

Evidence rule for every role: `qualifies` / `not_qualifies` / `unknown`. Only a trustworthy `not_qualifies` removes a role; failures,
rate limits and incomplete data are `unknown` and never remove anything.

## Country server
| Role | Source (verified) | Notes |
|---|---|---|
| President, Vice President, Minister of Defense, Minister of Economy, Congress | `GET /countries/{id}/government/members`, `role` = `president`, `vicePresident`, `ministerDefense`, `ministerEconomy`, `congress` | one player may hold several offices; a roster that is empty, truncated (`count` mismatch) or for another country is *incomplete* |
| Minister of Foreign Affairs | same endpoint | the game's raw role value was **not observed**; the admin supplies it in "Game value" (the dashboard lists values seen in your last sync) |
| Any other office | same endpoint | "Other government office" + its raw value |
| Citizen of the server's country | `GET /countries/{id}/citizens` (all pages) | complete list required |
| Citizen of a specific country | profile `countryId` | enter the country ID as "Game value" |

## Party server
| Role | Source | Notes |
|---|---|---|
| Party leader | profile `party.role == "leader"` | observed value |
| Party member | profile `party.id` | independent of role: a leader can also hold the member role |
| Treasurer, council members, … | profile `party.role` | **the game's role values were not observed**; map "Other party role" with the exact value. Values seen during syncs are shown in the dashboard |

## Military-unit server
| Role | Source | Notes |
|---|---|---|
| Unit member | profile `militaryUnit.id` | |
| Unit leader | profile `militaryUnit.role == "commander"` | a single leader role; no separate owner role |
| Option | per server: *leader receives the leader role instead of the member role* | off by default |
A unit leader receives **no** political or military roles unless they qualify independently.

## Alliance server — not available
The API has no verified data for alliance membership or a player's country inside an alliance (`/alliances` responses were never sampled).
The dashboard shows this and does not accept alliance mappings; the sync engine would never act on them. Deferred until the data exists.

## Military ranks (optional, any server type)
Off by default; enabling it creates the 17 starter ranks (عسكري 10,000 … مشير 250,000,000) which are fully editable.
- Ranks are **not cumulative**: a player holds only the highest enabled rank whose minimum damage (`stats.damage.all`, all-time) they meet;
  all other roles of the rank group are removed. Overlapping syncs of one member are serialised, so two rank roles can never remain.
- Dashboard + server + database all enforce: thresholds strictly increase with order (among enabled ranks), positive integers, unique keys,
  both Arabic and English names, a Discord role can be used by only one rank **and cannot also be a mapped office/membership role**.
- Roles with Administrator / Manage Server / Manage Roles, `@everyone` and integration roles cannot be chosen; the bot never manages them.
- Moving a rank swaps positions while the thresholds stay in their slots (the order always remains valid).
- Deleting a rank is refused while a sync is running. The deleted rank's Discord role is queued and removed from members by the next
  *complete, clean* sync, then forgotten. Disabled ranks are completely unmanaged.
- Changing thresholds is reflected by the next sync. Demotion policy per server: *immediate* (default for new servers), *grace period*,
  or *never*. A failed/malformed/missing damage value never changes any rank.
- A rank earned but with no Discord role mapped changes nothing (no neighbouring role is guessed); the reason is shown after the sync.
