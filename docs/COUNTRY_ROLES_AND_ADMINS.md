# Country roles, proxy countries and trusted bot administrators

## Proxy countries (country servers only)
A proxy country is a foreign country your country controls through your players. Dashboard: **Country roles → Proxy countries**.
* Each proxy country is chosen from the game's own country list (never typed as an id) and gets **one Discord role**: it may be the very same role as the server's ordinary citizen role (and several proxy countries may all use it). Edit = replace the role. Remove = the role is no longer managed (members keep it until removed by hand).
* Synchronisation (scheduled, manual and single-user alike): a linked player whose **current in-game nationality** is a proxy country receives that country's role. They are never treated as ordinary citizens: the citizen role is evaluated against the server's own country only, so a Sudanese-nationality player does not get the Egyptian citizen role, and a stale citizen role is removed.
* If the player's profile cannot be read (error, rate limit, not found, incomplete), **nothing is removed**. Unrelated roles are never touched. The bot never kicks anyone; channel visibility stays in Discord's permission setup.
* **Shared citizen role (M1):** the own-country citizen role and any number of proxy-country roles may be one Discord role; synchronisation then grants it to Egyptians and to proxy nationals, and removes it only when the player is neither (a definite answer from both rules). While either rule is uncertain (unreadable profile or citizens list) nothing is removed. A nationality change (citizen ⇄ proxy ⇄ foreign) grants / removes it correctly, with no remove-and-re-add churn between two rules that share the role.
* Rules enforced by the database: only a country server with its own country; the proxy country differs from it; the role is not a military-rank role, not the citizen role of some *other* specific country, and not a party / unit / president / leader / owner role. This is the only intentional exception to role exclusivity; every other duplicate-role protection is unchanged.

## Country party and unit roles (country servers only)
Dashboard: **Country roles**. Two different behaviours, evaluated independently, none required.

**One role PER party / PER unit (membership).** Choose a party (or military unit) from a searchable selector that lists **only this server's own country's** parties (units: only units *owned by* that country) with name and logo (initials when the game gives no image), then choose its Discord role. A player receives the membership role of the party / unit they **actually belong to**, and no other. Changing party or unit swaps the role. Different parties / units cannot share a Discord role.

**ONE shared role (leadership).**
| Kind | Qualifies when |
|---|---|
| Party president | the player leads **any** party of the server's country (the country's party list names them as leader, or their profile says leader of such a party) |
| Unit leader | the player is the **commander** (the game's unit role `commander`) of any unit of the server's country |
| Unit owner | the player is the **owner** (`ownerId` of the country's unit list) of any unit of the server's country; need not be inside it |
Commander and owner are separate facts from separate API fields: owning a unit never makes someone its leader, and vice versa. A member + commander + owner of the same unit therefore receives three roles: that unit's membership role, Unit leader and Unit owner.

**Country isolation is decided by the server.** The dashboard never sends a country: the selector endpoint uses the server's own configured country, and saving a party / unit role re-checks that the party / unit is in that country's list (a foreign unit that appears in the list is refused too). The generic per-party / per-unit mapping endpoint applies the same check for country servers. A party or unit of **another** country never qualifies in synchronisation either (an Egyptian inside a foreign unit gets no Egyptian unit role), and a mapping whose party / unit is no longer in the country's list stops granting (the dashboard flags it).

**One membership role at a time (M1.1).** A player is in at most one party and one unit, so at most one membership role of each kind can be granted. A party / unit may have only ONE membership role in a server, counting both the Country roles page and the per-party mappings of the Role mappings page (the second is refused). On every sync the bot gives the role of the party / unit the player is really in, removes the roles of all other configured parties / units, and removes all of them when the player is in none. It never removes anything when the profile or the country list is unavailable or malformed. If the data is ambiguous (two different roles configured for the same party by older settings) the bot grants neither and removes nothing. Just before it writes a membership change it re-reads the player's profile once, so a player who switched party a moment ago receives the new role directly. President, Unit leader and Unit owner are separate and unaffected.

The country's own lists are fetched once per synchronisation run. If a list is unavailable or incomplete the bot can still grant a role it can prove, but never removes one on missing data. Roles of the old model ("any party" / "any unit" membership, `game_ref` empty) are **kept in the database but no longer applied or removed**; the dashboard shows a notice with a button to delete the setting (members keep the Discord role until you remove it by hand). Removing or replacing a party / unit role likewise only stops managing the old Discord role. Needs the *Parties* / *Military units* modules.

## Trusted bot administrators
Dashboard: **Bot administrators** (owner-level only can change it; everyone with access can view it).
* A member holding any configured role may use the dashboard and the bot's admin slash commands **without** Discord's Administrator or Manage Server permission. The role grants no Discord permission.
* **Allowed:** role mappings, builds, ranks, verification (incl. the ticket panel), players/links, proxy countries and country-wide roles, synchronisation, audit and diagnostics.
* **Not allowed (owner-level only = Discord owner, Administrator or Manage Server):** changing the trusted roles, changing the server type / country / party / unit, releasing the reserved country.
* Safety: roles are read from Discord by the bot on every check (dashboard: cached 15 s), never from the request. @everyone and integration-managed roles are refused. At most 10 roles. If Discord cannot be reached the member is treated as *not* trusted. Every add/remove is audited (`admin_role.added/removed`) with the acting user; proxy and country-role changes are audited too (`proxy.set/removed`, `identity_role.set/cleared`).
* A server listed in the dashboard shows a "Trusted bot administrator" badge for such members.

## Concurrency
Every writer that depends on, or changes, a server's type or its mappings takes the same row lock on the guild first (`lockGuild`), and re-checks the kind against the server type **inside** the transaction. A mapping can therefore never be created for a kind the server type no longer allows, and a type change always sees every mapping. Verified on PostgreSQL 16 (the test fails without the lock).
