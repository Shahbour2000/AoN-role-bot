import { computeRank, type RankDefinition } from '@aon/core';
import type { ProfileCard, StatsCard } from '@aon/client';
import type { Lang } from './messages.js';

/** Plain Discord embed JSON (what the REST API accepts). Kept library-free so it can be validated and tested without Discord. */
export interface EmbedField { name: string; value: string; inline?: boolean }
export interface EmbedJson {
  title?: string; description?: string; color?: number; url?: string;
  thumbnail?: { url: string }; footer?: { text: string }; timestamp?: string; fields?: EmbedField[];
}

export const BRAND_GOLD = 0xe9b949;

/** Discord's documented embed limits. */
export const EMBED_LIMITS = { title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, footer: 2048, total: 6000, url: 2048 } as const;

/** Returns a list of violations (empty = valid). Used by the tests and as a last-resort guard before sending. */
export function validateEmbed(e: EmbedJson): string[] {
  const bad: string[] = []; let total = 0;
  const len = (s: string | undefined) => [...(s ?? '')].length;
  if (len(e.title) > EMBED_LIMITS.title) bad.push('title too long'); total += len(e.title);
  if (len(e.description) > EMBED_LIMITS.description) bad.push('description too long'); total += len(e.description);
  if ((e.fields?.length ?? 0) > EMBED_LIMITS.fields) bad.push('too many fields');
  for (const f of e.fields ?? []) {
    if (!f.name.trim() || !f.value.trim()) bad.push('empty field name/value');
    if (len(f.name) > EMBED_LIMITS.fieldName) bad.push('field name too long'); if (len(f.value) > EMBED_LIMITS.fieldValue) bad.push('field value too long');
    total += len(f.name) + len(f.value);
  }
  if (len(e.footer?.text) > EMBED_LIMITS.footer) bad.push('footer too long'); total += len(e.footer?.text);
  if (total > EMBED_LIMITS.total) bad.push(`embed total ${total} > ${EMBED_LIMITS.total}`);
  if (e.thumbnail && (!/^https:\/\//.test(e.thumbnail.url) || e.thumbnail.url.length > EMBED_LIMITS.url)) bad.push('thumbnail must be an https URL');
  if (e.color !== undefined && !(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff)) bad.push('bad colour');
  if (e.timestamp && Number.isNaN(Date.parse(e.timestamp))) bad.push('bad timestamp');
  return bad;
}

// ------------------------------------------------------------------ text helpers
/** Escapes Markdown and breaks @mentions in text that comes from the game (names can contain anything). */
export function esc(s: string): string { return s.replace(/[\\*_~`|>[\]()#-]/g, (c) => `\\${c}`).replace(/@/g, '@\u200b'); }
export function clip(s: string, max: number): string { const a = [...s]; return a.length <= max ? s : `${a.slice(0, max - 1).join('')}…`; }
const nf = (lang: Lang) => new Intl.NumberFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US');

// ------------------------------------------------------------------ labels (kept apart from the bot messages; parity is tested)
const L = {
  en: {
    country: 'Country', level: 'Level', xp: 'XP', prestige: 'Prestige', rank: 'Military rank', damage: 'Total damage', damagePeriods: 'Recent damage',
    today: 'Today', week: 'Week', month: 'Month', offices: 'Government', party: 'Party', unit: 'Military unit', activity: 'Activity', work: 'Work', trade: 'Trade', companies: 'Companies',
    next: 'Next', remaining: 'remaining', topRank: 'Highest rank reached', noRank: 'No rank yet', needs: 'needs', leader: 'Leader', commander: 'Commander', unavailable: 'Not available',
    footer: 'AoN Role Bot · data from Age of Nations', noData: 'No further data is available for this player right now.',
    office_president: 'President', office_vicePresident: 'Vice President', office_ministerDefense: 'Minister of Defense', office_ministerEconomy: 'Minister of Economy', office_congress: 'Congress member',
  },
  ar: {
    country: 'الدولة', level: 'المستوى', xp: 'الخبرة', prestige: 'الهيبة', rank: 'الرتبة العسكرية', damage: 'إجمالي الضرر', damagePeriods: 'الضرر الأخير',
    today: 'اليوم', week: 'الأسبوع', month: 'الشهر', offices: 'الحكومة', party: 'الحزب', unit: 'الوحدة العسكرية', activity: 'النشاط', work: 'العمل', trade: 'التجارة', companies: 'الشركات',
    next: 'التالية', remaining: 'متبقٍّ', topRank: 'أعلى رتبة', noRank: 'بلا رتبة بعد', needs: 'تتطلب', leader: 'رئيس الحزب', commander: 'قائد الوحدة', unavailable: 'غير متوفر',
    footer: 'AoN Role Bot · بيانات من Age of Nations', noData: 'لا توجد بيانات إضافية لهذا اللاعب حالياً.',
    office_president: 'رئيس الدولة', office_vicePresident: 'نائب الرئيس', office_ministerDefense: 'وزير الدفاع', office_ministerEconomy: 'وزير الاقتصاد', office_congress: 'عضو كونغرس',
  },
} as const;
export const PROFILE_LABEL_KEYS = { ar: Object.keys(L.ar), en: Object.keys(L.en) };

export interface ProfileCardInput {
  lang: Lang;
  profile: ProfileCard;
  /** null when the stats request failed: those fields are simply left out. */
  stats: StatsCard | null;
  /** The guild's rank ladder; only used when `ranksEnabled`. */
  ladder: readonly RankDefinition[]; ranksEnabled: boolean;
  /** Where relative avatar paths (`/media/...`) live. UNVERIFIED assumption, configurable (AON_MEDIA_BASE_URL). */
  mediaBaseUrl: string;
  now?: Date;
}

export function avatarUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  let u: string;
  if (/^https:\/\//i.test(raw)) u = raw; else if (raw.startsWith('/') && /^https:\/\//i.test(base)) u = base.replace(/\/+$/, '') + raw; else return null;
  return u.length <= EMBED_LIMITS.url ? u : null;
}

function bar(done: number, total: number, width = 10): string {
  const f = Math.max(0, Math.min(width, Math.floor((done / total) * width)));
  return `${'▰'.repeat(f)}${'▱'.repeat(width - f)} ${Math.min(100, Math.floor((done / total) * 100))}%`;
}

/**
 * Builds the player card. Every group is optional: a field is only present when its data really exists. Order = priority; if the
 * embed would exceed Discord's total size, the lowest-priority fields are dropped first. Extend by adding another `Section`.
 */
export function buildProfileEmbed(i: ProfileCardInput): EmbedJson {
  const t = L[i.lang]; const n = nf(i.lang); const p = i.profile; const st = i.stats;
  const fields: EmbedField[] = [];
  const add = (name: string, value: string, inline = true) => { if (value.trim()) fields.push({ name: clip(name, EMBED_LIMITS.fieldName), value: clip(value, EMBED_LIMITS.fieldValue), inline }); };

  if (p.countryId) add(`🌍 ${t.country}`, `\`${clip(p.countryId, 40).replace(/`/g, '')}\``);
  if (p.level !== null) add(`⭐ ${t.level}`, `${n.format(p.level)}${p.xp !== null ? ` · ${t.xp} ${n.format(p.xp)}` : ''}${p.prestige ? ` · ✨ ${t.prestige} ${n.format(p.prestige)}` : ''}`);

  const total = st?.damage.all ?? p.damage.total;                          // all-time damage: stats first, profile as the documented alternative
  if (i.ranksEnabled && total !== null) {
    const active = i.ladder.filter((r) => r.enabled).sort((a, b) => a.order - b.order);
    if (active.length) {
      const cur = computeRank(total, active);
      const name = (r: RankDefinition) => esc(i.lang === 'ar' ? r.nameAr : r.nameEn);
      const idx = cur.status === 'ranked' ? active.findIndex((r) => r.key === cur.rank.key) : -1;
      const next = active[idx + 1];
      const head = cur.status === 'ranked' ? `**${name(cur.rank)}**` : t.noRank;
      const floor = cur.status === 'ranked' ? cur.rank.minDamage : 0;
      const tail = next ? `\n${bar(total - floor, next.minDamage - floor)}\n${t.next}: ${name(next)} (${t.needs} ${n.format(next.minDamage)} · ${t.remaining} ${n.format(Math.max(0, next.minDamage - total))})` : `\n${t.topRank}`;
      add(`🏅 ${t.rank}`, head + tail, false);
    }
  }
  if (total !== null) add(`⚔️ ${t.damage}`, n.format(total));
  const periods = [[t.today, p.damage.day ?? st?.damage.day ?? null], [t.week, p.damage.week ?? st?.damage.week ?? null], [t.month, p.damage.month ?? st?.damage.month ?? null]] as const;
  const have = periods.filter(([, v]) => v !== null) as [string, number][];
  if (have.length) add(`📅 ${t.damagePeriods}`, have.map(([k, v]) => `${k}: ${n.format(v)}`).join('\n'));

  if (p.offices?.length) add(`🏛️ ${t.offices}`, p.offices.map((o) => esc((t as Record<string, string>)[`office_${o}`] ?? o)).join(' · '));
  if (p.party.state === 'member') add(`🎖️ ${t.party}`, `${esc(p.party.value.name ?? p.party.value.id)}${p.party.value.role ? ` — ${esc(p.party.value.role === 'leader' ? t.leader : p.party.value.role)}` : ''}`);
  if (p.unit.state === 'member') add(`🛡️ ${t.unit}`, `${esc(p.unit.value.name ?? p.unit.value.id)}${p.unit.value.role ? ` — ${esc(p.unit.value.role === 'commander' ? t.commander : p.unit.value.role)}` : ''}`);

  const act: string[] = [];
  if (st?.work.all != null) act.push(`💼 ${t.work}: ${n.format(st.work.all)}`);
  if (st?.trade.all != null) act.push(`🛒 ${t.trade}: ${n.format(st.trade.all)}`);
  if (st?.companies != null) act.push(`🏢 ${t.companies}: ${n.format(st.companies)}`);
  if (act.length) add(`📊 ${t.activity}`, act.join('\n'));

  const embed: EmbedJson = {
    title: `🪪 ${clip(esc(p.username ?? p.id), EMBED_LIMITS.title - 4)}`, color: BRAND_GOLD,
    ...(fields.length ? { fields } : { description: t.noData }),
    footer: { text: t.footer }, timestamp: (i.now ?? new Date()).toISOString(),
  };
  const thumb = avatarUrl(p.avatarUrl, i.mediaBaseUrl); if (thumb) embed.thumbnail = { url: thumb };
  while (validateEmbed(embed).length && embed.fields && embed.fields.length > 1) embed.fields.pop();         // lowest priority first
  return embed;
}
