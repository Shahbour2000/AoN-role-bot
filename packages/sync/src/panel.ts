/**
 * Publishing the verification ticket panel. ONE implementation used by the dashboard (`POST .../verification/panel/publish`) and by the
 * `/admin verify-panel` command, so both behave identically: same message, same duplicate protection, same audit trail.
 *
 * Discord itself is behind the `PanelPublisher` port (discord.js in production, a fake in tests). Nothing here can change what the
 * button does: the button id is a constant of the message model (`PANEL_BUTTON_ID`) and the click is handled by the existing ticket flow.
 */
import { panelFingerprint, resolvePanel, type PanelMessage } from '@aon/core';
import { audit, getGuildConfig, getPanel, recordPanelPublished, type Db } from '@aon/db';

export type PublishFailure = 'channel_unavailable' | 'missing_permissions' | 'discord_error';
export class PanelPublishError extends Error {
  constructor(readonly code: PublishFailure, readonly missing: string[] = []) { super(`panel publish failed: ${code}${missing.length ? ` (${missing.join(',')})` : ''}`); }
}

export interface PanelPublisher {
  /** Sends a NEW panel message. The channel must belong to `guildId` (a channel of another server is `channel_unavailable`). */
  post(guildId: string, channelId: string, message: PanelMessage): Promise<{ messageId: string }>;
  /** Edits a message this bot posted earlier. `false` = that message no longer exists (the caller posts a new one). */
  edit(guildId: string, channelId: string, messageId: string, message: PanelMessage): Promise<boolean>;
  /** Best-effort removal of an old panel message (only ever called for a message this bot posted). Never throws for "already gone". */
  remove(guildId: string, channelId: string, messageId: string): Promise<void>;
}

export type PublishMode = 'update' | 'new';
export type PublishSource = 'dashboard' | 'command';
export type PublishResult =
  | { ok: true; action: 'posted' | 'edited' | 'moved' | 'reposted'; channelId: string; messageId: string; fingerprint: string; removedOld: boolean }
  | { ok: false; code: 'no_channel' | 'publisher_unavailable' | 'busy' | PublishFailure; missing?: string[] };

const inFlight = new Set<string>();      // one publish per server at a time (a double click can never post two panels)

export async function publishVerificationPanel(
  deps: { db: Db; publisher: PanelPublisher | undefined; now?: () => Date; log?: (m: string) => void },
  a: { guildId: string; actorId: string | null; mode?: PublishMode; source: PublishSource },
): Promise<PublishResult> {
  if (!deps.publisher) return { ok: false, code: 'publisher_unavailable' };
  if (inFlight.has(a.guildId)) return { ok: false, code: 'busy' };
  inFlight.add(a.guildId);
  try {
    const cfg = await getGuildConfig(deps.db, a.guildId);
    const channelId = cfg?.verificationChannelId;
    if (!cfg || !channelId) return { ok: false, code: 'no_channel' };
    const rec = await getPanel(deps.db, a.guildId);
    const message = resolvePanel(rec.settings, cfg.language);
    const fingerprint = panelFingerprint(channelId, message);
    const prev = rec.published; const mode = a.mode ?? 'update';
    const fail = async (e: unknown): Promise<PublishResult> => {
      const code: PublishFailure = e instanceof PanelPublishError ? e.code : 'discord_error';
      deps.log?.(`panel publish failed in ${a.guildId}: ${code}${e instanceof Error && !(e instanceof PanelPublishError) ? ` (${e.message.slice(0, 80)})` : ''}`);
      await audit(deps.db, { guildId: a.guildId, actor: a.actorId, action: 'verification.panel_publish_failed', target: channelId, details: { source: a.source, code } }).catch(() => undefined);
      return { ok: false, code, ...(e instanceof PanelPublishError && e.missing.length ? { missing: e.missing } : {}) };
    };

    let action: 'posted' | 'edited' | 'moved' | 'reposted'; let messageId: string; let removedOld = false;
    try {
      let edited = false; messageId = prev?.messageId ?? '';
      if (mode === 'update' && prev && prev.channelId === channelId) edited = await deps.publisher.edit(a.guildId, channelId, prev.messageId, message);
      if (edited) action = 'edited';
      else {
        const posted = await deps.publisher.post(a.guildId, channelId, message); messageId = posted.messageId;
        try { await recordPanelPublished(deps.db, a.guildId, { channelId, messageId, fingerprint, actor: a.actorId, now: (deps.now ?? (() => new Date()))() }); }
        catch (e) { await deps.publisher.remove(a.guildId, channelId, messageId).catch(() => undefined); throw e; }   // never leave an unrecorded panel behind
        action = !prev ? 'posted' : prev.channelId !== channelId ? 'moved' : mode === 'new' ? 'reposted' : 'posted';
        // The new panel is live and recorded; only now is the old one removed, so there is never a moment without a working panel.
        if (prev && (prev.channelId !== channelId || prev.messageId !== messageId)) { try { await deps.publisher.remove(a.guildId, prev.channelId, prev.messageId); removedOld = true; } catch { /* the old panel stays; harmless, the admin can delete it */ } }
      }
      if (edited) await recordPanelPublished(deps.db, a.guildId, { channelId, messageId, fingerprint, actor: a.actorId, now: (deps.now ?? (() => new Date()))() });
    } catch (e) { return fail(e); }
    await audit(deps.db, { guildId: a.guildId, actor: a.actorId, action: 'verification.panel_posted', target: channelId, details: { source: a.source, action, messageId, removedOld } });
    return { ok: true, action, channelId, messageId, fingerprint, removedOld };
  } finally { inFlight.delete(a.guildId); }
}
