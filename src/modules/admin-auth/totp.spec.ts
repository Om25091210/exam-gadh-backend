import { base32Decode, base32Encode, hotp, newTotpSecret, totp, verifyTotp } from './totp';

const rfcSecret = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 4226 / 6238 vectors)', () => {
  it('HOTP matches the RFC 4226 test values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((e, i) => expect(hotp(rfcSecret, i)).toBe(e));
  });

  it('TOTP matches the RFC 6238 SHA-1 vectors (6-digit tail)', () => {
    const at = (s: number) => totp(rfcSecret, s * 1000);
    expect(at(59)).toBe('287082');
    expect(at(1111111109)).toBe('081804');
    expect(at(1111111111)).toBe('050471');
    expect(at(1234567890)).toBe('005924');
    expect(at(2000000000)).toBe('279037');
  });

  it('base32 round-trips', () => {
    const b = Buffer.from('hello world, secret!');
    expect(base32Decode(base32Encode(b)).toString()).toBe(b.toString());
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(() => base32Decode('1!')).toThrow();
  });

  it('verifies within one step of drift and refuses anything else', () => {
    const secret = base32Encode(rfcSecret);
    const now = 1234567890_000;
    const code = totp(rfcSecret, now);
    expect(verifyTotp(secret, code, now)).not.toBeNull();
    expect(verifyTotp(secret, code, now + 30_000)).not.toBeNull(); // one step later
    expect(verifyTotp(secret, code, now + 90_000)).toBeNull(); // three steps later
    expect(verifyTotp(secret, '000000', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
  });

  it('refuses a code whose step was already used (replay)', () => {
    const secret = base32Encode(rfcSecret);
    const now = 1234567890_000;
    const code = totp(rfcSecret, now);
    const step = verifyTotp(secret, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, now, step)).toBeNull();
  });

  it('generates fresh 160-bit secrets', () => {
    const a = newTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(a);
  });
});
