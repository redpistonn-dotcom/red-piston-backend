import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getCacheClient, callWithTimeout } from '../lib/cache.js';

// apiLimiter runs globally, in front of EVERY route (see index.js
// `app.use(apiLimiter)`) — if sendCommand ever hangs on a dead pooled
// connection, it hangs the entire API, not just rate-limiting. Must be
// timeout-guarded so a stale Redis connection degrades to "rate limiting
// briefly unavailable" instead of taking the whole backend down with it.
function makeStore(prefix) {
  const client = getCacheClient();
  if (!client) return undefined; // falls back to in-memory when Redis is unavailable
  return new RedisStore({
    prefix,
    sendCommand: (...args) => callWithTimeout(client, ...args),
  });
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  skip: (req) => req.path === '/health',
  store: makeStore('rl:api:'),
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

// Applied to all POST / PATCH / PUT / DELETE routes
export const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  store: makeStore('rl:mut:'),
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
