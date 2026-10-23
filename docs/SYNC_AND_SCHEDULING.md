# Role synchronization and scheduling

## How reconciliation works (add AND remove)
For every linked member the engine decides, **per managed role**, one of three things from current game data:
`qualifies` · `not_qualifies` · `unknown`. Then it compares with the roles the member has in Discord:

| Evidence | Member has role | Member lacks role |
|---|---|---|
| `qualifies` | keep (no API call) | **add** |
| `not_qualifies` | **remove** | nothing |
| `unknown` | keep, report reason | nothing |

*Managed roles* = exactly the Discord roles this server mapped (role mappings of enabled modules + enabled military ranks that have a role).
Everything else on the member is never read for decisions and never touched. Roles that carry Administrator / Manage Server / Manage Roles,
`@everyone`, integration roles and roles above the bot are never assigned or removed. The bot never deletes roles or edits permissions
(a source test enforces this). Running a sync twice with unchanged data makes zero Discord calls the second time.

| Rule | `qualifies` | `not_qualifies` | `unknown` (nothing removed) |
|---|---|---|---|
| President, VP, ministers, Congress (`/countries/{id}/government/members`) | player holds that office in a **complete** roster | complete roster without that office for the player | roster failed / empty / count mismatch / wrong country |
| Citizen of the server's country | in the **complete** paginated citizens list | absent from a complete list | any page failed, total changed, too many pages |
| Citizen of a specific country (mapping with a country in "game value") | profile `countryId` equals it | profile `countryId` is another country | `countryId` null/missing, profile failed |
| Party / military-unit member (mapping with or without a specific id) | profile `party` / `militaryUnit` has that id | other id, or explicit `null` | key absent, profile failed or deleted |
| Party leader / unit leader | role `leader` / `commander` in that party/unit | member with another role, or not a member | as above |
| Other party role (treasurer, council, …) | profile `party.role` equals the mapped game value | other role or not a member | as above; no game value mapped |
| Unit member when *leader replaces member* is on | member of the unit and not `commander` | commander (holds the leader role instead) | as above |
| Rank roles deleted from the ladder | – | always (configuration fact, needs no game data) until one complete, clean sync has run | – |
| Military rank | highest enabled rank ≤ **all-time** damage (`stats.damage.all`) | every other rank role of the group (one rank role at a time) | damage failed/missing/malformed; earned rank has no role; demotion withheld by policy |
| Alliances | never evaluated (no verified API data) | – | always |

Changes between offices, parties, units, countries and ranks are therefore a remove + add in the same pass. Syncs of the same member (manual, scheduled, `/sync me`, on link) are serialised, so they can never interleave. A *cumulative* rank system
(keep all lower ranks) is **not implemented**; the group is always exclusive.

Discord errors are classified: deleted role / missing permission → reported, not retried; member left → member skipped; rate limit and
network/5xx → up to 2 retries with backoff (Retry-After honoured), then reported. One failing role never stops the others.

## Automatic schedule (per server)
Dashboard → server → **Synchronization**: enable the switch, pick **every 3 / 6 / 12 / 24 hours**, Save. (API: `PUT /api/guilds/{id}/settings`
with `{"autoSyncEnabled": true, "syncIntervalHours": 6}`; any other value is rejected, also by a database constraint.)
The page shows the interval, **last successful sync**, **next scheduled sync**, current status, the last result (roles added/removed,
members processed/skipped/failed), skipped operations with reasons, roles the bot could not change, and errors. **Sync now** runs a
manual sync at any time.

How it stays reliable (no in-memory timers carry the schedule):
- The schedule is the column `guilds.next_sync_at`. Enabling or changing the interval re-anchors it in one transaction to
  `max(last scheduled run + interval, now + 5 min)`; disabling clears it. There is one value per guild, so a change can never create a second job.
- The worker wakes every minute and **claims** due guilds with a single atomic `UPDATE … RETURNING` that also advances `next_sync_at`
  (two workers cannot take the same slot; a long outage causes one catch-up run, not one per missed slot). Guilds run one at a time because the
  game API limit (60 requests/min per IP) is shared.
- A running manual or scheduled job postpones the claim; the database allows only one running server-wide job per guild.
- A failed scheduled run is retried within 30 minutes. On startup, interrupted jobs are marked failed and their guilds become due immediately.
- Manual runs do not move the schedule.

**Deployment requirement:** run the bot process (`packages/bot`, `npm start -w @aon/bot`) as a persistent worker (it hosts the Discord
connection, the scheduler and the dashboard). A serverless platform that sleeps cannot keep the Discord gateway connected. If the worker is
down, nothing is lost: due guilds are claimed when it returns.

## Logs
`sync[guild=… job=… kind=scheduled] start members=N` and
`… end status=succeeded processed=N/N updated=… unchanged=… partial=… failed=… skipped=… rolesAdded=… rolesRemoved=… durationMs=…`,
plus a line per failed or blocked member. No tokens or secrets are logged.

## Database migration
Migrations run automatically and forward-only at startup (`0005_durable_schedule.sql` is new). **Back up the database first.**
0005 maps any old interval to the next allowed value (≤3 h→3, ≤6 h→6, ≤12 h→12, else 24), schedules every guild that already had auto-sync on
(`now + interval`), adds `sync_jobs.details`, and adds the constraints. There is no down-migration; to roll back restore the backup.

## Demotion policy
Per server: **immediate** (default for new servers; the next sync reflects changed thresholds), **grace period** (N days below the earned rank), or **never**. Damage is lifetime and only grows, so demotions come from configuration changes. A failed or malformed damage value never triggers any of them.
