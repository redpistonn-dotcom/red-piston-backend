import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { verifyFirebaseToken } from '../../services/firebase.js';
import { ensureAuthProvider } from './helpers.js';

const router = Router();

// GET /api/auth/me/providers — list linked auth providers
router.get('/me/providers', authenticate, async (req, res, next) => {
  try {
    const providers = await prisma.authProvider.findMany({
      where: { userId: req.user.userId },
      select: { provider: true, providerId: true, linkedAt: true },
    });
    res.json({ success: true, data: providers });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/me/providers/link — link a new auth provider
router.post('/me/providers/link', authenticate, async (req, res, next) => {
  try {
    const { provider, firebaseToken } = req.body;

    if (!provider || !['GOOGLE', 'PHONE'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PROVIDER', message: 'Provider must be GOOGLE or PHONE' },
      });
    }

    if (provider === 'GOOGLE') {
      if (!firebaseToken) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_TOKEN', message: 'Firebase token is required to link Google' },
        });
      }

      const decoded = await verifyFirebaseToken(firebaseToken);
      await ensureAuthProvider(req.user.userId, 'GOOGLE', decoded.uid);

      // Also update user's firebaseUid and email if not set
      const updateData = {};
      if (!req.user.firebaseUid) updateData.firebaseUid = decoded.uid;
      if (!req.user.email && decoded.email) {
        updateData.email = decoded.email;
        updateData.emailVerified = true;
      }
      if (!req.user.avatarUrl && decoded.picture) updateData.avatarUrl = decoded.picture;
      if (!req.user.name && decoded.name) updateData.name = decoded.name;

      if (Object.keys(updateData).length > 0) {
        await prisma.user.update({ where: { userId: req.user.userId }, data: updateData });
      }
    }

    if (provider === 'PHONE') {
      if (!req.user.phone) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_PHONE', message: 'Verify your phone number first before linking' },
        });
      }
      await ensureAuthProvider(req.user.userId, 'PHONE', req.user.phone);
    }

    const providers = await prisma.authProvider.findMany({
      where: { userId: req.user.userId },
      select: { provider: true, providerId: true, linkedAt: true },
    });

    res.json({ success: true, data: providers });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/me/providers/:provider — unlink a provider
router.delete('/me/providers/:provider', authenticate, async (req, res, next) => {
  try {
    const { provider } = req.params;

    // Count current providers to prevent unlinking the last one
    const count = await prisma.authProvider.count({ where: { userId: req.user.userId } });
    if (count <= 1) {
      return res.status(400).json({
        success: false,
        error: { code: 'LAST_PROVIDER', message: 'Cannot unlink your only login method' },
      });
    }

    await prisma.authProvider.deleteMany({
      where: { userId: req.user.userId, provider: provider.toUpperCase() },
    });

    const providers = await prisma.authProvider.findMany({
      where: { userId: req.user.userId },
      select: { provider: true, providerId: true, linkedAt: true },
    });

    res.json({ success: true, data: providers });
  } catch (err) {
    next(err);
  }
});

export default router;
