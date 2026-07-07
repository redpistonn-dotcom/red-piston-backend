import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { verifyFirebaseToken } from '../../services/firebase.js';
import { ensureAuthProvider, formatUserResponse, attachStaffSections } from './helpers.js';

const router = Router();

/**
 * POST /api/auth/link-phone
 *
 * Links a verified phone number to an existing email-based account.
 * Called after the user completes Firebase Phone OTP during/after email login.
 *
 * Body: { firebaseToken }
 * Auth: Bearer access token (user must already be logged in)
 */
router.post('/link-phone', authenticate, async (req, res, next) => {
  try {
    const { firebaseToken } = req.body;

    if (!firebaseToken) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TOKEN', message: 'firebaseToken is required' },
      });
    }

    // Verify Firebase token and extract phone number
    const decoded = await verifyFirebaseToken(firebaseToken);
    const rawPhone = decoded.phone_number;

    if (!rawPhone) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_PHONE_IN_TOKEN', message: 'Firebase token does not contain a phone number' },
      });
    }

    // Normalise: strip +91 or any country code prefix, keep 10 digits
    const phone = rawPhone.replace(/^\+91/, '').replace(/^\+\d{1,3}/, '').replace(/\D/g, '').slice(-10);

    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'Could not extract a valid 10-digit phone number from token' },
      });
    }

    // Check phone not already used by a DIFFERENT user
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing && existing.userId !== req.userId) {
      return res.status(409).json({
        success: false,
        error: { code: 'PHONE_IN_USE', message: 'This phone number is already linked to another account' },
      });
    }

    // Update the current user's phone
    const updatedUser = await prisma.user.update({
      where:   { userId: req.userId },
      data:    { phone, phoneVerified: true, isVerified: true },
      include: { shop: true, userType: true },
    });

    // Register PHONE as an auth provider for this user
    await ensureAuthProvider(req.userId, 'PHONE', phone);

    return res.json({
      success: true,
      message: 'Phone number linked successfully',
      user: await attachStaffSections(formatUserResponse(updatedUser), updatedUser),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
