/**
 * Company-name ownership verification: pure logic (no I/O).
 *
 * The player renames one of THEIR OWN companies in the game so that the name contains a one-time code. The bot then reads the
 * company names from the game API and looks for that code. Only a SHA-256 hash of the code is ever stored: the bot finds the code by
 * extracting every code-shaped token from the real company names and comparing hashes, so no plaintext code needs to be kept.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** Unambiguous alphabet: no 0/1/O/I/L (they look alike in game fonts). 31 symbols x 10 characters = about 49.5 bits. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_BODY_LENGTH = 10;
export const CODE_PREFIX = 'AON';
/** Rules (product decision, see docs/VERIFICATION.md). */
export const VERIFICATION = {
  ttlMs: 30 * 60_000,
  maxChecks: 10,                 // checks per attempt; the attempt is closed afterwards
  minCheckIntervalMs: 20_000,    // between two checks (the game API caches responses for 30 s)
  maxAttemptsPerDay: 8,          // new attempts per Discord user per rolling 24 h
} as const;

/** Display form of the code, e.g. `AON-7K3QX9MPD2`. This is exactly what the player puts in the company name. */
export function generateVerificationCode(rand: (max: number) => number = (m) => randomInt(m)): string {
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i++) body += CODE_ALPHABET[rand(CODE_ALPHABET.length)]!;   // randomInt is uniform: no modulo bias
  return `${CODE_PREFIX}-${body}`;
}

/** Hash bound to the attempt, so the same code string can never be replayed against another attempt. */
export const hashVerificationCode = (attemptId: string, code: string): string =>
  createHash('sha256').update(`aon-verify:v1:${attemptId}:${normalizeCode(code)}`).digest('hex');

/** Upper-case and keep letters/digits only: tolerates case, spaces and dashes the game may add or strip. */
export const normalizeCode = (s: string): string => s.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Every code-shaped token (AON + 10 alphabet characters) present in a text, normalised to display form. */
export function extractCodeCandidates(text: string): string[] {
  const flat = normalizeCode(text);
  const out = new Set<string>();
  const re = new RegExp(`${CODE_PREFIX}([${CODE_ALPHABET}]{${CODE_BODY_LENGTH}})`, 'g');
  for (let m = re.exec(flat); m; m = re.exec(flat)) { out.add(`${CODE_PREFIX}-${m[1]}`); re.lastIndex = m.index + 1; }   // overlapping tokens are all tried
  return [...out];
}

const safeEqualHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export interface CompanyNameRef { id: string | null; name: string }
export type CodeMatch = { found: true; companyId: string | null; companyName: string } | { found: false };
/** Is the attempt's code present in the name of any of these (real, API-supplied) companies? */
export function findCodeInCompanies(attemptId: string, expectedHash: string, companies: readonly CompanyNameRef[]): CodeMatch {
  for (const c of companies) {
    for (const cand of extractCodeCandidates(c.name)) {
      if (safeEqualHex(hashVerificationCode(attemptId, cand), expectedHash)) return { found: true, companyId: c.id, companyName: c.name };
    }
  }
  return { found: false };
}
