import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, hashPassword, passwordProblems, recoveryCodes, temporaryPassword, verifyPassword } from './secrets';

describe('admin secrets', () => {
  it('hashes and verifies passwords with a per-password salt', async () => {
    const a = await hashPassword('correct horse battery 9');
    const b = await hashPassword('correct horse battery 9');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery 9', a)).toBe(true);
    expect(await verifyPassword('correct horse battery 8', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(passwordProblems('short1', 'a@b.in')).toContain('must be at least 12 characters');
    expect(passwordProblems('onlyletterspassword', 'a@b.in')).toContain('must contain letters and digits');
    expect(passwordProblems('rajesh-super-secret-1', 'rajesh@x.in')).toContain('must not contain your e-mail name');
    expect(passwordProblems('password123', 'a@b.in').length).toBeGreaterThan(0);
    expect(passwordProblems('Tr1cky-and-long-enough', 'a@b.in')).toEqual([]);
  });

  it('encrypts the TOTP secret with AES-GCM and detects tampering or the wrong key', () => {
    const key = randomBytes(32);
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('generates usable temporary passwords and unique recovery codes', () => {
    const pw = temporaryPassword();
    expect(pw).toHaveLength(16);
    expect(passwordProblems(pw, 'someone@x.in')).toEqual([]);
    const codes = recoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });
});
