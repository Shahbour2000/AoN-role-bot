# Linking a Discord account to a game account

## How it works
`/link username:<game name>` — the Discord **user ID** of the person running the command is the identity (never a typed Discord name).
The bot looks the player up (`GET /players/by-name/{username}`), shows the resolved name and **stable player ID**, and links on **Confirm**.
No password or token of the game is ever requested.

## Important limitation
**This does not prove that the person owns the game account.** The game API is read-only and offers no editable profile field or other challenge.
Anyone who knows a player's name can claim it. Two policies mitigate this (per server, in *Server setup*):
- **Direct** (default for new servers): the link is active immediately (method `self_direct`).
- **Staff approval**: the link is *pending* until a moderator approves it (`/admin approve`) — roles are granted only afterwards.
Moderators can always `/force link` (explicit confirm; `replace` to displace an existing link) and `/admin unlink`.

## Rules
- One game account per Discord user and one Discord user per game account **within a server**; another server is independent.
  A second claim for an already-linked account is refused with guidance (ask a moderator); in staff mode competing claims are flagged for review.
- Re-linking requires `/unlink` first. `/unlink` (or a moderator's unlink) removes the roles the bot granted, only those, and only if the bot may manage them.
- Links use the **stable player ID**. A game-side rename is picked up at the next sync (stored name refreshed); nothing breaks.
- Unknown player, API failure, rate limit and incomplete responses are reported **differently**; none of them ever deletes or alters a stored link.
  Links are removed only by an explicit unlink / replace action (audited).
- Every link, approval, rejection, unlink and force action is written to the append-only audit log.

## Designed for stronger verification later
`OwnershipVerifier` (packages/bot/src/handlers.ts) runs before a link is created; the default accepts any existing player. A future verifier
(profile challenge, staff ticket, …) plugs in there and records a new `account_links.method` value — no change to the schema's shape, the
sync engine or the dashboard flow. **Not built (deferred):** verification tickets that grant a role after a country-membership check, and any
ownership proof.
