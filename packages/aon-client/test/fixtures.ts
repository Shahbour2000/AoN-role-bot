/**
 * Fixtures taken from the owner's handoff file (real API samples, 2026-10-17).
 * PARTIAL: the handoff abbreviated long arrays (roster members, citizens, profile history/badges), so
 *  - `rosterAbbreviated` keeps the REAL `count: 14` with only the 5 listed members  => it is a truncated roster,
 *  - `rosterComplete` is the same 5 members with a consistent count (used for the happy path),
 *  - citizens pages are SYNTHETIC filler built to the real shape (total 51, 50 + 1, hasMore true/false).
 */
const UCP = { id: 'pty_66rrvzjjnzub3gr7', name: 'Ummah Caliphate Party' };
export const rosterMembers = [
  { role: 'president', userId: 'usr_7e6aj715eztaq3jz', username: 'MidEastrnVonChudLand', avatarUrl: '/media/f688a29f75ff58cfb758d4b9.webp', level: 18, source: 'election', electionId: 'elc_presidential_eg_launch-202610091235', party: UCP },
  { role: 'vicePresident', userId: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana', level: 17, source: 'appointment', party: UCP },
  { role: 'ministerDefense', userId: 'usr_bpmua0ysyv5aiknr', username: 'Tayseere', party: UCP },
  { role: 'ministerEconomy', userId: 'usr_4ur0kk6eqgq5puqz', username: 'AhmedsMixes', party: { id: 'pty_ngnxi04pbn7v8jkr', name: 'The National Party Of EGYPT NPE' } },
  { role: 'congress', userId: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana', party: UCP },   // same player, second office
  { role: 'congress', userId: 'usr_x_null_party', username: 'Ryzen', party: null },        // party: null
];
export const rosterAbbreviated = { countryId: 'eg', countryName: 'Egypt', count: 14, members: rosterMembers };
export const rosterComplete = { countryId: 'eg', countryName: 'Egypt', count: rosterMembers.length, members: rosterMembers };

export const profileAbuDujana = {
  id: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana', staffBadge: null, avatarUrl: '/media/8d126155650a12155d333ec5.gif', bannerUrl: null, nameStyle: null,
  bio: 'x', deleted: false, isSelf: false, countryId: 'eg', homeRegionId: 'eg-center', regionId: null, level: 17, xp: 8284, prestige: 0,
  rank: { code: 'lieutenant', minDamage: 400000, attackBonusPercent: 4, index: 4, next: { code: 'captain', minDamage: 1500000, attackBonusPercent: 5 } },
  damage: { total: '649601', day: '76197', week: '625446', month: '649601' },
  offices: ['congress', 'vicePresident'],
  militaryUnit: { id: 'mu_bsgmbfr8vj8j930g', name: '<unit name>', role: 'commander' },
  party: { ...UCP, role: 'leader' },
  referrals: 6, premium: false, joinedAt: '2026-10-09T12:35:02.095Z', serverTime: '2026-10-17T12:26:19.514Z',
};
export const profileNoAffiliation = { ...profileAbuDujana, offices: [], militaryUnit: null, party: null };

export const statsAbuDujana = {
  id: 'usr_r9s8exrd8arivqrq', username: 'AbuDujana', countryId: 'eg', level: 17, xp: 8284, prestige: 0,
  rank: { code: 'lieutenant', minDamage: 400000, attackBonusPercent: 4, index: 4 },
  damage: { all: '649601', day: '76197', week: '625446', month: '649601' },
  work: { all: '79', day: '4', week: '53', month: '79' }, trade: { all: '7354', day: '644', week: '6930', month: '7354' },
  companies: { count: 2, investedMoney: '0', investedSteel: 150 }, joinedAt: '2026-10-09T12:35:02.095Z', serverTime: '2026-10-17T12:26:26.388Z',
};

/** SYNTHETIC citizens in the real shape. Index 0..50 => 51 citizens; the API returns 50 per page by default. */
export const citizen = (i: number) => ({
  id: `usr_cit_${i}`, username: `Citizen${i}`, avatarUrl: null, level: 21, countryId: 'eg', homeRegionId: 'eg-center', regionId: null,
  lastActiveAt: '2026-10-17T10:00:00.000Z', citizenshipChangedAt: '2026-10-09T12:00:00.000Z', active: i % 7 !== 0, offices: i === 3 ? ['congress'] : [],
});
export const citizensPages = (pageSize: number, total = 51) => (offset: number) => ({
  citizens: Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) }, (_, k) => citizen(offset + k)),
  total, hasMore: offset + pageSize < total, offset, limit: pageSize,
});

export const parties = {
  countryId: 'eg', createCost: '1500000', createCurrency: 'money',
  parties: [
    { id: 'pty_66rrvzjjnzub3gr7', name: 'Ummah Caliphate Party', leaderId: 'usr_r9s8exrd8arivqrq', leaderName: 'AbuDujana', members: 11, ruling: true, ethics: ['imperialist'] },
    { id: 'pty_ngnxi04pbn7v8jkr', name: 'The National Party Of EGYPT NPE', leaderName: 'AhmedsMixes', members: 4, ruling: false, ethics: [] },
  ],
};
export const units = [
  { id: 'mu_bsgmbfr8vj8j930g', name: 'ALQAHERA', countryId: 'eg', regionId: 'eg-center', joinPolicy: 'application', logoUrl: null, hqLevel: 0, hqStatus: 'active', dormLevel: 2, ownerId: 'usr_ummuuxjkb91g0wsk', ownerName: 'AHMEDER', members: 9, damage: '2309485', capacity: 10 },
  { id: 'mu_wn6dmwp2fegfstw3', name: 'Black Flags', countryId: 'eg', ownerName: 'MidEastrnVonChudLand', members: 10, damage: '1854757', capacity: 10 },
];
