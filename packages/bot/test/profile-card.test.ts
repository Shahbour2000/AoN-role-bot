import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKS } from '@aon/core';
import { extractProfileCard, extractStatsCard, type ProfileCard, type StatsCard } from '@aon/client';
import { EMBED_LIMITS, PROFILE_LABEL_KEYS, avatarUrl, buildProfileEmbed, clip, esc, validateEmbed, type EmbedJson } from '../src/index.js';
import { profileAbuDujana, statsAbuDujana } from '../../aon-client/test/fixtures.js';

const ok = (data: unknown) => ({ status: 'ok' as const, data });
const card = (over: Record<string, unknown> = {}): ProfileCard => { const r = extractProfileCard(ok({ ...profileAbuDujana, ...over })); if (r.status !== 'ok') throw new Error('x'); return r.data; };
const stats = (): StatsCard => { const r = extractStatsCard(ok(statsAbuDujana)); if (r.status !== 'ok') throw new Error('x'); return r.data; };
const NOW = new Date('2026-10-19T12:00:00Z');
const build = (o: Partial<Parameters<typeof buildProfileEmbed>[0]> = {}) => buildProfileEmbed({ lang: 'en', profile: card(), stats: stats(), ladder: DEFAULT_RANKS, ranksEnabled: false, mediaBaseUrl: 'https://app.ageofnations.world', now: NOW, ...o });
const field = (e: EmbedJson, part: string) => e.fields!.find((f) => f.name.includes(part));

describe('Discord embed validity', () => {
  it('the standard card is valid, branded, timestamped and under every limit', () => {
    const e = build({ ranksEnabled: true });
    expect(validateEmbed(e)).toEqual([]); expect(e.color).toBe(0xe9b949); expect(e.timestamp).toBe(NOW.toISOString()); expect(e.footer!.text).toContain('AoN Role Bot');
    expect(e.fields!.length).toBeLessThanOrEqual(EMBED_LIMITS.fields);
  });
  it('hostile / enormous game data can never produce an invalid embed (every length clipped, total ≤ 6000)', () => {
    const huge = 'ж'.repeat(5000);
    const e = build({ ranksEnabled: true, ladder: DEFAULT_RANKS.map((r) => ({ ...r, nameEn: huge, nameAr: huge })), profile: card({
      username: huge, countryId: huge, offices: Array.from({ length: 80 }, (_, i) => `office${i}${huge}`), party: { id: 'p', name: huge, role: huge }, militaryUnit: { id: 'm', name: huge, role: huge } }) });
    expect(validateEmbed(e)).toEqual([]);
    expect(JSON.stringify(e).length).toBeGreaterThan(0); expect(e.title!.length).toBeLessThanOrEqual(EMBED_LIMITS.title);
    for (const f of e.fields!) { expect([...f.name].length).toBeLessThanOrEqual(256); expect([...f.value].length).toBeLessThanOrEqual(1024); }
  });
  it('when the embed would be too big the LOWEST-priority fields are dropped first, never the core ones', () => {
    const huge = 'x'.repeat(900);
    const e = build({ ranksEnabled: true, ladder: DEFAULT_RANKS.map((r) => ({ ...r, nameEn: huge })), profile: card({ offices: [huge], party: { id: 'p', name: huge, role: huge }, militaryUnit: { id: 'm', name: huge, role: huge } }) });
    expect(validateEmbed(e)).toEqual([]);
    expect(e.fields![0]!.name).toContain('Country');                                  // the first (highest-priority) fields survive
  });
  it('the validator itself flags violations', () => {
    expect(validateEmbed({ title: 'x'.repeat(257) })).toContain('title too long');
    expect(validateEmbed({ fields: Array.from({ length: 26 }, () => ({ name: 'a', value: 'b' })) })).toContain('too many fields');
    expect(validateEmbed({ fields: [{ name: 'a', value: ' ' }] })).toContain('empty field name/value');
    expect(validateEmbed({ fields: [{ name: 'a', value: 'b'.repeat(1025) }] })).toContain('field value too long');
    expect(validateEmbed({ footer: { text: 'f'.repeat(2049) } })).toContain('footer too long');
    expect(validateEmbed({ thumbnail: { url: 'http://x/y.png' } })).toContain('thumbnail must be an https URL');
    expect(validateEmbed({ color: -1 })).toContain('bad colour'); expect(validateEmbed({ timestamp: 'nope' })).toContain('bad timestamp');
    expect(validateEmbed({ description: 'd'.repeat(4097) })).toContain('description too long');
    expect(validateEmbed({ title: 't'.repeat(256), description: 'd'.repeat(4000), fields: [{ name: 'a', value: 'b'.repeat(1000) }, { name: 'a', value: 'b'.repeat(1000) }] }).some((x) => x.startsWith('embed total'))).toBe(true);
  });
});

describe('content', () => {
  it('only fields with real data are present; nothing is invented', () => {
    const e = build({ profile: card({ countryId: null, level: undefined, xp: undefined, prestige: undefined, damage: { total: undefined, day: undefined, week: '12', month: undefined }, offices: [], party: null, militaryUnit: null }), stats: null });
    expect(e.fields!.map((f) => f.name)).toEqual(['📅 Recent damage']); expect(field(e, 'Recent')!.value).toBe('Week: 12');
  });
  it('total damage prefers stats (damage.all) and falls back to the profile (damage.total); never to day/week/month', () => {
    expect(field(build(), 'Total damage')!.value).toBe('649,601');
    expect(field(build({ stats: null }), 'Total damage')!.value).toBe('649,601');
    expect(field(build({ stats: null, profile: card({ damage: { total: undefined, day: '5', week: '6', month: '7' } }) }), 'Total damage')).toBeUndefined();
  });
  it('government offices use friendly names; unknown offices are shown as the game reports them, escaped', () => {
    const e = build({ profile: card({ offices: ['president', 'ministerDefense', 'ministerForeign_x'] }) });
    expect(field(e, 'Government')!.value).toBe('President · Minister of Defense · ministerForeign\\_x');
    expect(field(build({ lang: 'ar', profile: card({ offices: ['vicePresident'] }) }), 'الحكومة')!.value).toBe('نائب الرئيس');
  });
  it('party leader / unit commander are labelled; other roles are shown as reported', () => {
    expect(field(build(), 'Party')!.value).toContain('Leader'); expect(field(build(), 'Military unit')!.value).toContain('Commander');
    expect(field(build({ profile: card({ party: { id: 'p', name: 'P', role: 'treasurer' } }) }), 'Party')!.value).toContain('treasurer');
  });
  it('uses latin digits in Arabic and Arabic labels', () => {
    const e = build({ lang: 'ar' });
    expect(field(e, 'إجمالي الضرر')!.value).toMatch(/^[0-9٬,.\s]+$/); expect(field(e, 'الدولة')).toBeDefined();
  });
  it('Arabic and English label sets are identical', () => { expect(PROFILE_LABEL_KEYS.ar.sort()).toEqual(PROFILE_LABEL_KEYS.en.sort()); });
});

describe('military rank section (only when the server enabled the system)', () => {
  it('shows the highest qualifying rank and exact progress to the next: 649,601 is 83% of the way from Warrant Officer (400,000) to Chief Warrant Officer (700,000)', () => {
    const v = field(build({ ranksEnabled: true }), 'Military rank')!.value;
    expect(v).toContain('**Warrant Officer**'); expect(v).toContain('▰▰▰▰▰▰▰▰▱▱ 83%'); expect(v).toContain('Next: Chief Warrant Officer'); expect(v).toContain('remaining 50,399');
  });
  it('rank system off, or no enabled ranks => no rank field', () => {
    expect(field(build({ ranksEnabled: false }), 'Military rank')).toBeUndefined();
    expect(field(build({ ranksEnabled: true, ladder: DEFAULT_RANKS.map((r) => ({ ...r, enabled: false })) }), 'Military rank')).toBeUndefined();
    expect(field(build({ ranksEnabled: true, ladder: [] }), 'Military rank')).toBeUndefined();
  });
  it('below the first rank, at the top rank, and with disabled ranks skipped', () => {
    const low = field(build({ ranksEnabled: true, stats: null, profile: card({ damage: { total: '5000' } }) }), 'Military rank')!.value;
    expect(low).toContain('No rank yet'); expect(low).toContain('Next: Soldier');
    const top = field(build({ ranksEnabled: true, stats: null, profile: card({ damage: { total: '999999999' } }) }), 'Military rank')!.value;
    expect(top).toContain('**Field Marshal**'); expect(top).toContain('Highest rank reached'); expect(top).not.toContain('▰');
    const skipped = field(build({ ranksEnabled: true, ladder: DEFAULT_RANKS.map((r) => (r.key === 'warrant_officer_first_class' ? { ...r, enabled: false } : r)) }), 'Military rank')!.value;
    expect(skipped).toContain('Next: Lieutenant');                                       // the disabled rank is skipped
  });
  it('uses the server\'s own rank names (renamed / custom ranks)', () => {
    const v = field(build({ ranksEnabled: true, ladder: DEFAULT_RANKS.map((r) => (r.key === 'warrant_officer' ? { ...r, nameEn: 'Veteran' } : r)) }), 'Military rank')!.value;
    expect(v).toContain('**Veteran**');
  });
});

describe('helpers', () => {
  it('avatarUrl accepts https URLs and relative media paths with an https base; rejects everything else', () => {
    expect(avatarUrl('/media/a.gif', 'https://app.ageofnations.world/')).toBe('https://app.ageofnations.world/media/a.gif');
    expect(avatarUrl('https://cdn.example/a.png', 'https://x')).toBe('https://cdn.example/a.png');
    for (const bad of ['http://x/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'media/a.gif', '', null]) expect(avatarUrl(bad as string | null, 'https://x')).toBeNull();
    expect(avatarUrl('/media/a.gif', 'http://insecure')).toBeNull(); expect(avatarUrl('/m/' + 'a'.repeat(3000), 'https://x')).toBeNull();
  });
  it('esc neutralises markdown and mentions; clip counts characters (not UTF-16 units)', () => {
    expect(esc('**bold** _it_ `c` ~s~ |sp| > q [l](u) # h - d')).not.toMatch(/(^|[^\\])[*_`~|>]/);
    expect(esc('@everyone <@123>')).toBe('@\u200beveryone <@\u200b123\\>');                 // every '@' is split, so it can never ping
    expect(esc('@everyone')).not.toMatch(/@everyone/);
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…'); expect(clip('abc', 3)).toBe('abc');
  });
});
