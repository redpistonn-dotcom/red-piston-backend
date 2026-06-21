/**
 * flags.js — feature flag system backed by the FeatureFlag DB model.
 * Flags are cached in Redis for 30 seconds to reduce DB load.
 */

import { getOrSet } from './cache.js';
import prisma from '../db/prisma.js';

const FLAG_TTL_SECONDS = 30;

/**
 * Check whether a feature flag is enabled, optionally scoped to a shop.
 *
 * A flag is considered enabled when:
 *   1. The FeatureFlag row exists and isActive = true, AND
 *   2. Either enabledForAll = true OR shopId is in enabledShopIds.
 *
 * Results are cached in Redis under "flag:{key}:{shopId}" for 30 seconds.
 * Returns false on any error (missing flag, DB failure, cache failure).
 *
 * @param {string} key - The feature flag identifier.
 * @param {string|number|null} shopId - Optional shop scope; pass null for global checks.
 * @returns {Promise<boolean>}
 */
export async function isEnabled(key, shopId = null) {
  const cacheKey = `flag:${key}:${shopId}`;

  try {
    const result = await getOrSet(
      cacheKey,
      async () => {
        const flag = await prisma.featureFlag.findUnique({
          where: { key },
        });

        if (!flag || !flag.isActive) return false;
        if (flag.enabledForAll) return true;
        if (shopId !== null && Array.isArray(flag.enabledShopIds)) {
          // Normalize both sides to strings for a safe comparison.
          return flag.enabledShopIds.map(String).includes(String(shopId));
        }
        return false;
      },
      FLAG_TTL_SECONDS
    );

    // getOrSet may return a cached boolean or a freshly computed one.
    return Boolean(result);
  } catch (err) {
    console.error('[flags.isEnabled]', err);
    return false;
  }
}

/**
 * Express middleware that attaches a scoped flag helper to the request.
 *
 * After this middleware runs, handlers can call:
 *   const allowed = await req.flag('some-feature');
 *
 * req.shopId must be set by earlier auth/session middleware for shop-scoped checks.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function flagMiddleware(req, res, next) {
  req.flag = (key) => isEnabled(key, req.shopId ?? null);
  next();
}
