# Country roles, proxy countries and trusted bot administrators

## Proxy countries (country servers only)
A proxy country is a foreign country your country controls through your players. Dashboard: **Country roles → Proxy countries**.
* Each proxy country is chosen from the game's own country list (never typed as an id) and gets **one dedicated Discord role**. Edit = replace the role. Remove = the role is no longer managed (members keep it until removed by hand).
* Synchronisation (scheduled, manual and single-user alike): a linked player whose **current in-game nationality** is a proxy country receives that country's role. They are never treated as ordinary citizens: the citizen role is evaluated against the server's own country only, so a Sudanese-nationality player does not get the Egyptian citizen role, and a stale citizen role is removed.
* If the player's profile cannot be read (error, rate limit, not found, incomplete), **nothing is removed**. Unrelated roles are never touched. The bot never kicks anyone; channel visibility stays in Discord's permission setup.
* Rules enforced by the database: only a country server with its own country; the proxy country differs from it; the role is not the citizen role, not a military-rank role and not used by another proxy/country role.

## Country-wide party and unit roles (country servers only)
Dashboard: **Country roles → Country-wide party and unit roles**. One Discord role per kind; none is required.
| Kind | Qualifies when |
|---|---|
| Party member | the player belongs to ANY party registered under the server's country (rank irrelevant) |
| Party president | the player leads any such party (the country's party list names them as leader, or their profile says leader of such a party) |
| Unit member | the player belongs to ANY military unit **owned by** the server's country (rank irrelevant; nationality irrelevant) |
| Unit leader | the player commands any such unit |
| Unit owner | the player owns any unit of the server's country (need not be inside it) |
A party or unit of **another** country never qualifies; an Egyptian inside a foreign unit gets no Egyptian unit role. The country's own lists (`/countries/{id}/parties`, `/countries/{id}/units`) are fetched once per synchronisation run. If a list is unavailable or incomplete the bot can still grant a role it can prove, but it never removes one on missing data. They need the *Parties* / *Military units* module switched on in Server setup. They are independent of the per-party / per-unit roles on the Role mappings page and of party-server / unit-server mappings (which are unchanged; those server types cannot have these kinds).

## Trusted bot administrators
Dashboard: **Bot administrators** (owner-level only can change it; everyone with access can view it).
* A member holding any configured role may use the dashboard and the bot's admin slash commands **without** Discord's Administrator or Manage Server permission. The role grants no Discord permission.
* **Allowed:** role mappings, builds, ranks, verification (incl. the ticket panel), players/links, proxy countries and country-wide roles, synchronisation, audit and diagnostics.
* **Not allowed (owner-level only = Discord owner, Administrator or Manage Server):** changing the trusted roles, changing the server type / country / party / unit, releasing the reserved country.
* Safety: roles are read from Discord by the bot on every check (dashboard: cached 15 s), never from the request. @everyone and integration-managed roles are refused. At most 10 roles. If Discord cannot be reached the member is treated as *not* trusted. Every add/remove is audited (`admin_role.added/removed`) with the acting user; proxy and country-role changes are audited too (`proxy.set/removed`, `identity_role.set/cleared`).
* A server listed in the dashboard shows a "Trusted bot administrator" badge for such members.

## Concurrency
Every writer that depends on, or changes, a server's type or its mappings takes the same row lock on the guild first (`lockGuild`), and re-checks the kind against the server type **inside** the transaction. A mapping can therefore never be created for a kind the server type no longer allows, and a type change always sees every mapping. Verified on PostgreSQL 16 (the test fails without the lock).
