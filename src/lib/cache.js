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
      const cached = await redis.get(key);
      if (cached !== null) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis unavailable or parse error — fall through to fn()
    }
  }

  const value = await fn();

  if (redis && value !== undefined) {
    try {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
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
    await redis.del(key);
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
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Silently ignore
  }
}
