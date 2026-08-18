import rateLimit from 'express-rate-limit';

// Global per-request throttle. Runs on EVERY request, so a Redis-backed store
// here means one Redis round-trip per request just for a rough global cap.
// Render free tier runs a single instance, so an in-memory store enforces the
// exact same limit with zero Redis cost — only move this back to Redis if the
// deploy becomes multi-instance and cross-instance accuracy is required.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  skip: (req) => req.path === '/health',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down and try again in a minute.',
      },
    });
  },
});

// Applied to all POST / PATCH / PUT / DELETE routes. Same reasoning as
// apiLimiter above — in-memory, single instance, no Redis round-trip needed.
export const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down and try again in a minute.',
      },
    });
  },
});
