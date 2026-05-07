import rateLimit from 'express-rate-limit';

// OTP send: max 5 requests per phone per 10 minutes (keyed by phone number)
export const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.phone || req.ip,
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
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many password reset requests. Please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// General auth endpoints (login, refresh, firebase): 20 req / 15 min per IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many requests. Please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});
