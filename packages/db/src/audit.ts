import type { Db } from './db.js';
export async function audit(db: Db, e: { guildId: string; actor: string | null; action: string; target?: string; details?: Record<string, unknown> }) {
  await db.query('INSERT INTO audit_events (guild_id, actor_discord_id, action, target, details) VALUES ($1,$2,$3,$4,$5)', [
    e.guildId, e.actor, e.action, e.target ?? null, JSON.stringify(e.details ?? {}),
  ]);
}
