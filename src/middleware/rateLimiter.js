import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getCacheClient, callWithTimeout } from '../lib/cache.js';

function makeStore(prefix) {
  const client = getCacheClient();
  if (!client) return undefined; // graceful fallback to in-memory when REDIS_URL is absent
  return new RedisStore({
    prefix,
    // Timeout-guarded: a zombie pooled connection (dead socket ioredis still
    // thinks is "ready") would otherwise hang this call — and therefore the
    // whole request — forever. See src/lib/cache.js withRedisTimeout.
    sendCommand: (...args) => callWithTimeout(client, ...args),
  });
}

// OTP send: 5 requests per phone per 10 minutes
export const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.phone || req.ip,
  store: makeStore('rl:otp-send:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many OTP requests. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Email login: 10 req / 15 min per IP
export const emailLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  store: makeStore('rl:email-login:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many login attempts. Please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Password reset: 3 req / hour per IP
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  store: makeStore('rl:pwd-reset:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many password reset requests. Please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP verify: 10 attempts per phone per 10 minutes
export const verifyOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  store: makeStore('rl:otp-verify:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many OTP verification attempts. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Email OTP send (register/resend-verification): 5 per email per 10 minutes
export const emailOtpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.email?.toLowerCase() || req.ip,
  store: makeStore('rl:email-otp-send:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many verification emails requested. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Email OTP verify: 10 attempts per email per 10 minutes — a 6-digit code is
// only ~900,000 combinations, so this must be throttled once verification
// actually gates access instead of being a fire-and-forget side effect.
export const emailOtpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body?.email?.toLowerCase() || req.ip,
  store: makeStore('rl:email-otp-verify:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many verification attempts. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Staff-invite accept: 10 attempts per email per 10 minutes — same 6-digit
// brute-force concern as emailOtpVerifyLimiter above, separate bucket since
// it's keyed off a different flow/OTP type.
export const staffInviteVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body?.email?.toLowerCase() || req.ip,
  store: makeStore('rl:staff-invite-verify:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many verification attempts. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const mechanicInviteVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body?.email?.toLowerCase() || req.ip,
  store: makeStore('rl:mechanic-invite-verify:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many verification attempts. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// General auth endpoints (login, refresh, firebase): 20 req / 15 min per IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  store: makeStore('rl:auth:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many requests. Please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// PDF extract: 5 uploads per 10 min per IP — CPU-heavy parse
export const pdfExtractLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  store: makeStore('rl:pdf:'),
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many PDF uploads. Please wait 10 minutes before trying again.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});
