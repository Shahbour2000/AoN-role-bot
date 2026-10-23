import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

const key = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'aon-roles-salt', 'aon-seal-v1', 32));

/** AES-256-GCM: output = base64url(iv | tag | ciphertext). Used for OAuth tokens at rest and the short-lived OAuth state cookie. */
export function seal(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
export function open(secret: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', key(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }     // tampered / wrong key
}
