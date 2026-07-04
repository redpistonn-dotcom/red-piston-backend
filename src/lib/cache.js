import Redis from "ioredis";

let client = null;
let clientFailed = false;

function getOrCreateClient() {
  if (clientFailed) return null;
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 8000,
      retryStrategy(times) {
        if (times >= 3) {
          clientFailed = true;
          return null; // stop retrying
        }
        return Math.min(times * 100, 1000);
      },
    });

    client.on("error", () => {
      // Silently absorb connection errors
    });
  } catch {
    clientFailed = true;
    client = null;
  }

  return client;
}

/**
 * Returns the ioredis client instance, or null if unavailable.
 */
export function getCacheClient() {
  return getOrCreateClient();
}

// ioredis has no built-in per-command timeout. `enableOfflineQueue`/
// `maxRetriesPerRequest` only kick in when the client's own state is
// disconnected/reconnecting — if the TCP connection died silently (a NAT/LB
// or Redis provider dropping an idle connection without a FIN/RST, which is
// exactly what a multi-day-idle deploy runs into), ioredis still thinks the
// socket is "ready" and will wait forever for a reply that's never coming.
// Every command call MUST race against a manual deadline so a dead
// connection degrades to "treat Redis as unavailable" instead of hanging
// the caller (and, for the rate limiter, hanging every single request).
const REDIS_CMD_TIMEOUT_MS = 3000;

export function withRedisTimeout(promise, ms = REDIS_CMD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('REDIS_TIMEOUT')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Timeout-guarded raw command call, for use as rate-limit-redis's
 * sendCommand. Throws (never hangs) if Redis doesn't reply within the
 * deadline — callers (express-rate-limit) already fail open on store errors.
 */
export function callWithTimeout(redisClient, ...args) {
  return withRedisTimeout(redisClient.call(...args));
}

/**
 * Returns the cached value for key, or calls fn() to compute and cache it.
 * Falls back to calling fn() directly if Redis is unavailable.
 *
 * @param {string} key
 * @param {number} ttlSeconds
 * @param {() => Promise<any>} fn
 */
export async function getOrSet(key, ttlSeconds, fn) {
  const redis = getOrCreateClient();

  if (redis) {
    try {
      const cached = await withRedisTimeout(redis.get(key));
      if (cached !== null) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis unavailable, timed out, or parse error — fall through to fn()
    }
  }

  const value = await fn();

  if (redis && value !== undefined) {
    try {
      await withRedisTimeout(redis.set(key, JSON.stringify(value), "EX", ttlSeconds));
    } catch {
      // Silently skip caching if Redis is unavailable
    }
  }

  return value;
}

/**
 * Deletes a single cache key.
 *
 * @param {string} key
 */
export async function invalidate(key) {
  const redis = getOrCreateClient();
  if (!redis) return;

  try {
    await withRedisTimeout(redis.del(key));
  } catch {
    // Silently ignore
  }
}

/**
 * Deletes all keys matching a glob pattern using the KEYS command.
 * Note: KEYS blocks the Redis server — use only in low-traffic scenarios
 * or consider SCAN for production use at scale.
 *
 * @param {string} pattern
 */
export async function invalidatePattern(pattern) {
  const redis = getOrCreateClient();
  if (!redis) return;

  try {
    const keys = await withRedisTimeout(redis.keys(pattern));
    if (keys.length > 0) {
      await withRedisTimeout(redis.del(...keys));
    }
  } catch {
    // Silently ignore
  }
}
