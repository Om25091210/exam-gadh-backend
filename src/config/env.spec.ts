import { loadEnv } from './env';

const base = {
  JWT_SECRET: 'x'.repeat(40),
  DATABASE_URL: 'postgresql://x',
  GOOGLE_CLIENT_IDS: 'abc.apps.googleusercontent.com',
  ADMIN_TOTP_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadEnv', () => {
  it('uses real Google verification by default', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).googleVerifier).toBe('google');
  });
  it('allows the dev verifier outside production, without client ids', () => {
    const { GOOGLE_CLIENT_IDS: _drop, ...rest } = base;
    void _drop;
    expect(loadEnv({ ...rest, NODE_ENV: 'development', GOOGLE_VERIFIER: 'dev' }).googleVerifier).toBe('dev');
  });
  it('refuses the dev verifier in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', GOOGLE_VERIFIER: 'dev', CORS_ORIGINS: 'https://x', RAZORPAY_KEY_ID: 'a', RAZORPAY_KEY_SECRET: 'b', RAZORPAY_WEBHOOK_SECRET: 'c' })).toThrow(/GOOGLE_VERIFIER=dev is not allowed in production/);
  });
  it('requires client ids when using real Google', () => {
    expect(() => loadEnv({ ...base, GOOGLE_CLIENT_IDS: '', NODE_ENV: 'development' })).toThrow(/GOOGLE_CLIENT_IDS/);
  });

  describe('razorpay credentials', () => {
    const rz = (o: Record<string, string>) => loadEnv({ ...base, NODE_ENV: 'development', ...o });
    it('is off when nothing is set', () => {
      expect(rz({}).razorpayMode).toBe('off');
      expect(rz({}).paymentsEnabled).toBe(false);
    });
    it('never treats a placeholder secret as configured (it would make signatures forgeable)', () => {
      const e = rz({ RAZORPAY_KEY_ID: 'unset', RAZORPAY_KEY_SECRET: 'unset', RAZORPAY_WEBHOOK_SECRET: 'unset' });
      expect(e.paymentsEnabled).toBe(false);
      expect(e.webhookEnabled).toBe(false);
      expect(rz({ RAZORPAY_KEY_ID: 'rzp_live_AbC123xyz', RAZORPAY_KEY_SECRET: 'unset' }).paymentsEnabled).toBe(false);
    });
    it('detects live and test mode from the key id', () => {
      expect(rz({ RAZORPAY_KEY_ID: 'rzp_live_AbC123xyz', RAZORPAY_KEY_SECRET: 'a-long-real-secret' }).razorpayMode).toBe('live');
      expect(rz({ RAZORPAY_KEY_ID: 'rzp_test_AbC123xyz', RAZORPAY_KEY_SECRET: 'a-long-real-secret' }).razorpayMode).toBe('test');
    });
    it('needs a separate real webhook secret for webhooks', () => {
      expect(rz({ RAZORPAY_WEBHOOK_SECRET: 'whsec_long_enough' }).webhookEnabled).toBe(true);
      expect(rz({ RAZORPAY_WEBHOOK_SECRET: 'short' }).webhookEnabled).toBe(false);
    });
  });
});
