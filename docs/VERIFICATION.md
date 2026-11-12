# Account verification and global linking (Phase 1)

## What changed
* A Discord account is linked to **one** Age of Nations account, and vice versa, **globally** (all servers). The database enforces it:
  `global_links` has partial unique indexes on `discord_user_id` and on `player_id` (active rows). A trigger on `account_links` makes
  it impossible to hold an active per-server link that disagrees with the global link.
* Ownership is proven by **renaming one of your own companies** so the name contains a one-time code. The bot reads the real company
  names from `GET /players/{userId}/companies?limit=50&offset=N` (paginated) and looks for the code. A name typed by the member,
  or a claim of ownership, is never evidence. `/link` is now an alias of `/verify`; the old name-only claim is gone.
* Verify once, then use any server: the first time a globally linked member uses the bot in another server (`/sync me`, `/profile`,
  `/link-status`, `/verify`, the panel button) the per-server link is created from the global one and roles are synced. No second
  ownership check. (The bot has no privileged member-join intent, so this is on first explicit use, not on join.)

## Flow
1. Member presses **Open verification ticket** on the panel (or runs `/verify username:<name>`); the bot resolves the player by name.
2. A ticket (private/ephemeral message) shows the code `AON-XXXXXXXXXX` (10 characters from a 31-symbol alphabet, about 49 bits) and the buttons
   **Check verification / New code / Close ticket**. The code is shown once; only `sha256(attemptId + code)` is stored.
3. The member renames a company in the game. **Check verification** fetches all pages of the player's companies, extracts every
   code-shaped token from each name, hashes it with the attempt id and compares in constant time.
4. On a match one transaction locks the attempt and both global identities, creates the global link (`company_verified`) and this server's
   link, closes the attempt and writes the audit event; roles are synced immediately.

## Protections (all enforced in the database or server code, not in the UI)
| Rule | Where |
|---|---|
| Code is random (`crypto.randomInt`), unique (unique hash), bound to attempt + Discord user + player | core `verification.ts`, `verification_attempts` |
| Expires after 30 minutes; one open ticket per member (new one supersedes) | `verification_attempts` + partial unique index |
| At most 10 checks per ticket, 20 s between checks (API caches 30 s); API outages and unreadable data do not consume a check | `beginCheck`/`endCheck` |
| At most 8 tickets per member per rolling 24 h | `createAttempt` |
| Only the ticket's owner can use its buttons (someone else's id is "not found") | `beginCheck` (`WHERE discord_user_id=`) |
| A code from another ticket never verifies (hash is bound to the attempt) | `hashVerificationCode` |
| Two members racing for one game account: exactly one wins; double-click cannot create two links | row locks + unique indexes (tested on PostgreSQL 16) |
| A **proven** link is never displaced by a server administrator or another ticket | `createAttempt`, `completeVerification`, `forceLink` |
| An **unproven** link (legacy self-claim, staff approval, forced link) **is** replaced when the real owner proves ownership; its roles are removed; audited | `completeVerification` |
| Unlinking: members `/unlink` themselves (all servers). A server admin's `/admin unlink` only ends the link **in that server**. Lost-account recovery of a proven link is an **operator** action (`scripts/recover-link.ts`, reason mandatory, audited) because it affects every server | `unlinkGlobalSelf`, `recoverGlobalLink` |
| Every step is audited: `verification.opened / verified / expired / locked / cancelled / api_incomplete / panel_posted`, `link.global_materialized`, `link.displaced_by_verification`, `link.recovered` | `audit_events` |

## Migration 0009 (forward-only, runs automatically at start)
Creates `global_links` and `verification_attempts`, adds `guilds.verification_channel_id`, widens `account_links.method` with `global_link`,
adds the guard trigger. **Existing links are preserved**: each distinct (Discord user, player) pair becomes a global link, marked
`legacy_unverified` (or `admin_forced` / `staff_approved`). Where one Discord user or one game account appears in conflicting links, the strongest
and oldest link is kept (greedy, admin > staff > self-claim) and each losing per-server link is set to `unlinked` with a reason and an
`link.migration_conflict_unlinked` audit event; **nothing is deleted**. Roles already granted by such a losing link stay on the member until
they are removed by hand (the sync no longer manages unlinked members).

## UNVERIFIED assumption: the companies response shape
The OpenAPI file declares the body of `/players/{id}/companies` as a free-form object and the repository has no sample. The client reads:
a list of company objects either as the top-level array or under `companies` / `items`; each with a string `name`; `id` and `ownerId` when present
(`ownerId` other than the player = ignored); `total` / `hasMore` when present. Anything else (no list, an entry without a string `name`) is
**incomplete**: nothing is verified, no check is used, the audit log gets `verification.api_incomplete` with the missing field names, and the member
is told to try later. To confirm the real shape run `scripts/probe-api.sh <username> <countryId>` (now also captures `player_companies.json`) and
send `api-samples/player_companies.json`; if the shape differs only `extractCompaniesPage` (about 20 lines) changes.

## Decisions taken (change on request)
* The ticket is an ephemeral Discord message flow with state in the database, not a private thread/channel: it needs no extra Discord permissions.
  The "ticket channel" is where the panel is posted (`/admin verify-panel`). Staff-visible ticket threads can be added later.
* Per-server membership appears on first explicit use (no privileged intent). A `GuildMembers` intent would allow doing it on join.
* Legacy name-only links remain valid (marked `legacy_unverified`) until their owner is replaced by a real proof or they re-verify.
