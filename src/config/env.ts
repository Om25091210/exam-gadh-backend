export interface Env {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  accessTtlSec: number;
  refreshTtlDays: number;
  googleClientIds: string[];
  /** 'dev' accepts `dev:<sub>:<email>:<name>` tokens so browser tests can sign in without Google. Never allowed in production. */
  googleVerifier: 'google' | 'dev';
  corsOrigins: string[];
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  logLevel: string;
  adminTotpKey: Buffer;
  adminCookieSecure: boolean;
  mediaBucket: string;
  awsRegion: string;
  mediaCdnDomain: string;
}

export const ENV = Symbol('ENV');

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads and validates configuration once at startup; fails fast with a readable message. */
export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = src.NODE_ENV ?? 'development';
  const prod = nodeEnv === 'production';
  const problems: string[] = [];
  const need = (key: string): string => {
    const v = src[key];
    if (!v) problems.push(`${key} is required`);
    return v ?? '';
  };

  const jwtSecret = need('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  const databaseUrl = need('DATABASE_URL');
  const googleClientIds = list(src.GOOGLE_CLIENT_IDS);
  const googleVerifier = src.GOOGLE_VERIFIER === 'dev' ? 'dev' : 'google';
  if (googleVerifier === 'dev' && prod) problems.push('GOOGLE_VERIFIER=dev is not allowed in production');
  if (googleVerifier === 'google' && googleClientIds.length === 0) problems.push('GOOGLE_CLIENT_IDS is required (comma separated)');

  const razorpayKeyId = src.RAZORPAY_KEY_ID ?? '';
  const razorpayKeySecret = src.RAZORPAY_KEY_SECRET ?? '';
  const razorpayWebhookSecret = src.RAZORPAY_WEBHOOK_SECRET ?? '';
  if (prod && (!razorpayKeyId || !razorpayKeySecret || !razorpayWebhookSecret)) {
    problems.push('RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required in production');
  }
  const totpKeyRaw = src.ADMIN_TOTP_KEY ?? '';
  const adminTotpKey = Buffer.from(totpKeyRaw, 'base64');
  if (adminTotpKey.length !== 32) problems.push('ADMIN_TOTP_KEY is required: 32 random bytes, base64 (openssl rand -base64 32)');
  const corsOrigins = list(src.CORS_ORIGINS);
  if (prod && corsOrigins.length === 0) problems.push('CORS_ORIGINS is required in production');

  if (problems.length) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
  return {
    nodeEnv,
    port: Number(src.PORT ?? 3000),
    databaseUrl,
    jwtSecret,
    accessTtlSec: Number(src.ACCESS_TTL_SEC ?? 900),
    refreshTtlDays: Number(src.REFRESH_TTL_DAYS ?? 30),
    googleClientIds,
    googleVerifier,
    corsOrigins,
    razorpayKeyId,
    razorpayKeySecret,
    razorpayWebhookSecret,
    logLevel: src.LOG_LEVEL ?? (prod ? 'info' : 'debug'),
    adminTotpKey,
    mediaBucket: src.MEDIA_BUCKET ?? '',
    awsRegion: src.AWS_REGION ?? 'ap-south-1',
    mediaCdnDomain: src.MEDIA_CDN_DOMAIN ?? '',
    // The admin cookie is Secure in production (HTTPS only); set ADMIN_COOKIE_SECURE=false only for local http.
    adminCookieSecure: src.ADMIN_COOKIE_SECURE ? src.ADMIN_COOKIE_SECURE === 'true' : prod,
  };
}
