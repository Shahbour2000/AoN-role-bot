import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, extractCodeCandidates, findCodeInCompanies, generateVerificationCode, hashVerificationCode, normalizeCode } from '../src/verification.js';

describe('verification codes', () => {
  it('are AON-<10 unambiguous characters> and effectively unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) { const c = generateVerificationCode(); expect(c).toMatch(/^AON-[2-9A-HJKMNP-Z]{10}$/); expect(/[01OIL]/.test(c.slice(4))).toBe(false); seen.add(c); }
    expect(seen.size).toBe(2000);
  });
  it('use every alphabet symbol (no stuck generator) and the injected randomness', () => {
    expect(generateVerificationCode(() => 0)).toBe('AON-2222222222');
    expect(generateVerificationCode(() => CODE_ALPHABET.length - 1)).toBe('AON-ZZZZZZZZZZ');
  });
  it('hash is bound to the attempt and to the code, and ignores case/spacing only', () => {
    const h = hashVerificationCode('a1', 'AON-7K3QX9MPD2');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVerificationCode('a1', ' aon 7k3qx9mpd2 ')).toBe(h);
    expect(hashVerificationCode('a2', 'AON-7K3QX9MPD2')).not.toBe(h);
    expect(hashVerificationCode('a1', 'AON-7K3QX9MPD3')).not.toBe(h);
  });
  it('extracts tokens from realistic company names', () => {
    expect(extractCodeCandidates('Cairo Steel AON-7K3QX9MPD2')).toEqual(['AON-7K3QX9MPD2']);
    expect(extractCodeCandidates('aon 7k3q x9mpd2 Ltd')).toEqual(['AON-7K3QX9MPD2']);
    expect(extractCodeCandidates('My Company')).toEqual([]);
    expect(extractCodeCandidates('AON-7K3QX9MP')).toEqual([]);        // too short
    expect(normalizeCode('a-b c')).toBe('ABC');
  });
});

describe('findCodeInCompanies', () => {
  const id = 'att-1'; const code = 'AON-7K3QX9MPD2'; const hash = hashVerificationCode(id, code);
  it('finds the code only in a real company name', () => {
    expect(findCodeInCompanies(id, hash, [{ id: 'c1', name: 'Alpha' }, { id: 'c2', name: `Beta ${code}` }])).toEqual({ found: true, companyId: 'c2', companyName: `Beta ${code}` });
  });
  it('rejects: no companies, other code, other attempt', () => {
    expect(findCodeInCompanies(id, hash, []).found).toBe(false);
    expect(findCodeInCompanies(id, hash, [{ id: null, name: 'Beta AON-7K3QX9MPD3' }]).found).toBe(false);
    expect(findCodeInCompanies('att-2', hash, [{ id: null, name: code }]).found).toBe(false);
  });
});
