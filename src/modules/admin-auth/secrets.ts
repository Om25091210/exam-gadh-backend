import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** scrypt$N$r$p$salt$hash (no native dependency; parameters travel with the hash so they can be raised later). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Hash used to spend the same time when the e-mail does not exist, so login timing does not reveal accounts. */
export const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password-for-timing-only');

const COMMON = new Set(['password', 'password123', 'qwerty123456', '123456789012', 'examgadh1234', 'admin1234567', 'letmein12345']);

export function passwordProblems(password: string, email: string): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push('must be at least 12 characters');
  if (password.length > 128) out.push('must be at most 128 characters');
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) out.push('must not contain your e-mail name');
  if (COMMON.has(password.toLowerCase())) out.push('is too common');
  if (/^(.)\1+$/.test(password)) out.push('must not be a single repeated character');
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) out.push('must contain letters and digits');
  return out;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Temporary password for new staff: 16 chars, letters + digits, shown once. */
export function temporaryPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const pw = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  return /[0-9]/.test(pw) && /[a-z]/.test(pw) ? pw : temporaryPassword();
}

export function recoveryCodes(count = 10): string[] {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => chars[x % chars.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** AES-256-GCM for the TOTP secret at rest. key = 32 bytes (base64 in ADMIN_TOTP_KEY). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, key: Buffer): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
