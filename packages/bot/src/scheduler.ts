import { claimDueGuilds, recoverStaleJobs, scheduleRetry, type Db } from '@aon/db';

/**
 * One scheduler pass. The schedule lives in the DATABASE (guilds.next_sync_at), not in this process:
 *  - `claimDueGuilds` atomically advances each due guild's next_sync_at, so two workers (or a restarted one) never run
 *    the same slot twice, and changing a guild's interval can never create a second recurring job;
 *  - guilds are run ONE AT A TIME because the game API's 60 requests/min limit is shared by every guild;
 *  - a run that throws is retried soon instead of waiting a full interval.
 * The in-process timer below only decides WHEN to look; if it stops, the schedule is untouched in the database.
 */
export async function schedulerTick(db: Db, now: Date, run: (guildId: string) => Promise<unknown>, log: (m: string) => void = () => undefined): Promise<string[]> {
  const claimed = await claimDueGuilds(db, now);
  for (const g of claimed) {
    try { await run(g); } catch (e) {
      log(`scheduled sync failed for ${g}: ${e instanceof Error ? e.message : 'error'}`);
      await scheduleRetry(db, g, now).catch(() => undefined);
    }
  }
  return claimed;
}

export function startScheduler(db: Db, run: (guildId: string) => Promise<unknown>, log: (m: string) => void, intervalMs = 60_000): { stop(): void } {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;               // never overlap ticks
    busy = true;
    schedulerTick(db, new Date(), run, log).catch((e) => log(`scheduler error: ${e instanceof Error ? e.message : 'error'}`)).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
export { recoverStaleJobs };
