import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import prisma from '../../db/prisma.js';

// ─── Cookie config for refresh tokens ────────────────────────────────────────
export const REFRESH_COOKIE_NAME = 'refresh_token';
export const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  // Cross-domain (Vercel frontend → Render backend) requires 'none' in production.
  // 'none' requires secure:true, which is already set above for production.
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: '/api/auth',
};

/**
 * Hash a refresh token for safe storage.
 * We store SHA-256(rawToken) so a DB breach can't replay sessions.
 * SHA-256 is appropriate here (unlike passwords) because refresh tokens
 * are already high-entropy random JWTs — bcrypt's slow hash is unnecessary.
 */
export function hashToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function generateTokens(userId, shopId, role) {
  const accessToken = jwt.sign(
    { userId, shopId: shopId || null, role: role || 'CUSTOMER' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  const refreshToken = jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
  return { accessToken, refreshToken };
}

export function formatUserResponse(user) {
  return {
    userId: user.userId,
    phone: user.phone,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    userType: user.userType
      ? { id: user.userType.id, name: user.userType.name, slug: user.userType.slug }
      : null,
    shopId: user.shopId,
    shop: user.shop || null,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    isVerified: user.isVerified || user.emailVerified || user.phoneVerified || false,
    loginCount: user.loginCount || 0,
  };
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized || null;
}

export async function findUserByEmailInsensitive(email, options = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { include, select } = options;
  const users = await prisma.user.findMany({
    where: {
      email: {
        equals: normalized,
        mode: 'insensitive',
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 2,
    ...(include ? { include } : {}),
    ...(select ? { select } : {}),
  });

  if (users.length > 1) {
    const err = new Error('Multiple accounts found for this email. Please contact support to merge your account.');
    err.status = 409;
    err.code = 'ACCOUNT_CONFLICT';
    throw err;
  }

  return users[0] || null;
}

/**
 * Extract lightweight device fingerprint from the request.
 * Stored in device_info JSONB for session management UI ("Active sessions").
 */
function extractDeviceInfo(req) {
  const ua = req.headers['user-agent'] || '';
  const platform = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /chrome/i.test(ua) ? 'Chrome'
    : /firefox/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari'
    : /edge/i.test(ua) ? 'Edge'
    : 'Unknown';
  return { ua: ua.slice(0, 200), platform, browser };
}

/**
 * Create a session: generate tokens, store hashed refresh token in DB,
 * set httpOnly cookie. Returns the JSON payload for the response.
 */
export async function createSession(res, user, { isNewUser = false, req = null } = {}) {
  const { accessToken, refreshToken } = generateTokens(user.userId, user.shopId, user.role);
  const tokenHash = hashToken(refreshToken);

  const deviceInfo = req ? extractDeviceInfo(req) : {};
  const ipAddress = req ? (req.ip || req.connection?.remoteAddress || null) : null;
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Single active session — revoke all previous sessions for this user
  await prisma.refreshToken.deleteMany({ where: { userId: user.userId } });

  await prisma.refreshToken.create({
    data: {
      userId: user.userId,
      shopId: user.shopId || null,
      tokenHash,
      deviceInfo,
      ipAddress,
      expiresAt,
    },
  });

  // Update last login + increment login counter + set isVerified
  await prisma.user.update({
    where: { userId: user.userId },
    data: {
      lastLoginAt: new Date(),
      loginCount: { increment: 1 },
      isVerified: user.emailVerified || user.phoneVerified || false,
    },
  });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);

  return {
    success: true,
    accessToken,
    refreshToken,
    isNewUser,
    user: formatUserResponse(user),
  };
}

/**
 * Block login for shop owners whose account is not yet approved.
 * Returns false and sends the 403 response if blocked; returns true to continue.
 */
export function checkShopOwnerVerification(user, res) {
  if (user.role !== 'SHOP_OWNER') return true;
  if (user.verificationStatus === 'PENDING') {
    res.status(403).json({
      success: false,
      error: {
        code: 'SHOP_OWNER_PENDING',
        message: 'Your account is pending verification by our team. You will receive an email once approved.',
      },
    });
    return false;
  }
  if (user.verificationStatus === 'REJECTED') {
    res.status(403).json({
      success: false,
      error: {
        code: 'SHOP_OWNER_REJECTED',
        message: user.verificationNote || 'Your shop owner application was not approved. Contact support for details.',
      },
    });
    return false;
  }
  return true;
}

/**
 * Look up UserType.id for a given role slug (e.g. "SHOP_OWNER" → 3).
 * Returns null if the UserType row doesn't exist yet.
 * Results are cached in-process so we only hit the DB once per slug per restart.
 */
const _userTypeCache = {};
export async function getUserTypeId(roleSlug) {
  if (!roleSlug) return null;
  if (_userTypeCache[roleSlug] !== undefined) return _userTypeCache[roleSlug];
  const ut = await prisma.userType.findUnique({ where: { slug: roleSlug } });
  _userTypeCache[roleSlug] = ut?.id ?? null;
  return _userTypeCache[roleSlug];
}

/**
 * Ensure an AuthProvider record exists for the given user + provider combo.
 * Uses upsert to avoid duplicates.
 */
export async function ensureAuthProvider(userId, provider, providerId) {
  if (!providerId) return;

  const existing = await prisma.authProvider.findUnique({
    where: { provider_providerId: { provider, providerId } },
  });

  if (existing && existing.userId !== userId) {
    const err = new Error('This login method is already linked to another account.');
    err.status = 409;
    err.code = 'ACCOUNT_CONFLICT';
    throw err;
  }

  if (!existing) {
    await prisma.authProvider.create({
      data: { userId, provider, providerId },
    });
  }
}
