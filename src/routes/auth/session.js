import { Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../db/prisma.js';
import { generateTokens, hashToken, REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTIONS } from './helpers.js';
import { writeAudit, ET, ACT } from '../../lib/audit.js';
import { authenticate } from '../../middleware/auth.js';

const router = Router();

// GET /api/auth/sessions — list this user's active (non-revoked, non-expired)
// sessions. deviceInfo has been captured on every login/refresh since
// createSession() was written (see auth/helpers.js extractDeviceInfo) —
// this is the first thing that actually reads it back out.
router.get('/sessions', authenticate, async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;
    const currentHash = rawToken ? hashToken(rawToken) : null;

    const sessions = await prisma.refreshToken.findMany({
      where: { userId: req.user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });

    res.json({
      success: true,
      data: sessions.map(s => ({
        id: s.id,
        deviceInfo: s.deviceInfo,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        isCurrent: currentHash ? s.tokenHash === currentHash : false,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/sessions/:id — revoke one session (e.g. a lost/stolen
// device). Ownership-checked: a user can only revoke their own sessions.
router.delete('/sessions/:id', authenticate, async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const result = await prisma.refreshToken.updateMany({
      where: { id: sessionId, userId: req.user.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Session not found' } });
    }
    writeAudit(req, { entityType: ET.AUTH, entityId: sessionId, action: ACT.LOGOUT, metadata: { revokedByUser: true } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh — rotate refresh token (from cookie OR body)
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;

    if (!rawToken) {
      return res.status(401).json({
        success: false,
        error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token provided' },
      });
    }

    const tokenHash = hashToken(rawToken);

    // Find by hash, not by raw token. Also filter out revoked/expired rows.
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    // Rotation grace window: when two tabs refresh concurrently, the first one
    // rotates (revokes) the token before the second one's request lands. A token
    // revoked < 60s ago is a race, not a replay — allow it so the losing tab
    // isn't force-logged-out. Genuinely old revoked tokens are still rejected.
    const ROTATION_GRACE_MS = 60 * 1000;
    const revokedOutsideGrace = stored?.revokedAt
      && (Date.now() - new Date(stored.revokedAt).getTime()) > ROTATION_GRACE_MS;

    if (!stored || revokedOutsideGrace || stored.expiresAt < new Date()) {
      res.clearCookie(REFRESH_COOKIE_NAME, { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_REFRESH', message: 'Invalid or expired refresh token' },
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(rawToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      // JWT signature invalid — soft-revoke and reject
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }).catch(() => {});
      res.clearCookie(REFRESH_COOKIE_NAME, { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_REFRESH', message: 'Refresh token signature invalid' },
      });
    }

    const user = await prisma.user.findUnique({
      where: { userId: decoded.userId },
      include: { shop: true, userType: true },
    });
    if (!user || !user.isActive) {
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }).catch(() => {});
      return res.status(401).json({
        success: false,
        error: { code: 'USER_INACTIVE', message: 'Account is inactive' },
      });
    }

    // Pending/rejected shop owners must not refresh into a live session —
    // login already blocks them; refresh must not be a backdoor.
    if (user.role === 'SHOP_OWNER' && ['PENDING', 'REJECTED'].includes(user.verificationStatus)) {
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }).catch(() => {});
      return res.status(403).json({
        success: false,
        error: {
          code: `SHOP_OWNER_${user.verificationStatus}`,
          message: user.verificationStatus === 'PENDING'
            ? 'Your account is pending verification by our team.'
            : 'Your shop owner application was not approved. Contact support for details.',
        },
      });
    }

    const { accessToken, refreshToken: newRawRT } = generateTokens(
      user.userId,
      user.shopId,
      user.role
    );
    const newTokenHash = hashToken(newRawRT);
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const newIp = req.ip || stored.ipAddress || null;

    // Token rotation: soft-revoke the old, create the new — both in one transaction.
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), lastUsedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: user.userId,
          shopId: user.shopId || null,
          tokenHash: newTokenHash,
          deviceInfo: stored.deviceInfo || {},
          ipAddress: newIp,
          expiresAt: newExpiresAt,
        },
      }),
    ]);

    res.cookie(REFRESH_COOKIE_NAME, newRawRT, REFRESH_COOKIE_OPTIONS);

    // Also return the rotated refresh token in the body. The httpOnly cookie is a
    // THIRD-PARTY cookie in production (Vercel frontend ↔ Render backend are
    // different sites), so Safari/modern-Chrome block it — the cookie can't be
    // relied on for the next refresh. Returning it here lets the client persist
    // the fresh token in its localStorage fallback so the session self-heals.
    res.json({
      success: true,
      data: { accessToken, refreshToken: newRawRT, expiresIn: 28800 },
      accessToken,
      refreshToken: newRawRT,
      user: {
        userId: user.userId,
        role: user.role,
        shopId: user.shopId,
        name: user.name,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — soft-revoke refresh token
router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;

    let logoutUserId = null;
    if (rawToken) {
      const tokenHash = hashToken(rawToken);
      // Soft-revoke: set revokedAt so we keep an audit trail
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }).catch(() => {});
      // Best-effort: decode userId for the audit log (no signature check needed here)
      try { logoutUserId = jwt.decode(rawToken)?.userId || null; } catch {}
    }

    writeAudit(req, {
      entityType: ET.AUTH,
      entityId:   logoutUserId,
      action:     ACT.LOGOUT,
    });

    res.clearCookie(REFRESH_COOKIE_NAME, { ...REFRESH_COOKIE_OPTIONS, maxAge: 0 });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
