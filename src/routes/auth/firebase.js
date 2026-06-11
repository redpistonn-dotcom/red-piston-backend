import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { verifyFirebaseToken } from '../../services/firebase.js';
import { createSession, ensureAuthProvider, findUserByEmailInsensitive, normalizeEmail, checkShopOwnerVerification, getUserTypeId, needsShopSetup, shopSetupResponse } from './helpers.js';
import { sendShopOwnerVerificationAlert } from '../../services/email.js';

const router = Router();

/**
 * POST /api/auth/firebase
 *
 * Flow:
 *  1. Verify Firebase token → extract uid, phone, email, name, picture
 *  2. Check AuthProvider table for existing Google link (provider=GOOGLE, providerId=uid)
 *  3. If found      → existing user, update stale profile fields
 *  4. If not found  → try match by phone, then by email
 *  5. Still no match → create brand-new user (isNewUser = true)
 *  6. Link Google provider to user (upsert AuthProvider)
 *  7. Issue JWT session and return
 */
router.post('/firebase', async (req, res, next) => {
  try {
    const { firebaseToken, role, mode } = req.body;
    // mode = "signin" → never create a new user; return noAccount if not found

    if (!firebaseToken) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TOKEN', message: 'firebaseToken is required' },
      });
    }

    const decoded = await verifyFirebaseToken(firebaseToken);
    const { uid, phone_number, email, name, picture } = decoded;
    const emailNormalized = normalizeEmail(email);
    const phoneClean = phone_number
      ? phone_number.replace(/^\+91/, '').replace(/^\+/, '')
      : null;

    let isNewUser = false;
    let user = null;

    // ── Step 1: Look up by AuthProvider (GOOGLE uid) ──────────────────────────
    const existingProvider = await prisma.authProvider.findUnique({
      where: { provider_providerId: { provider: 'GOOGLE', providerId: uid } },
    });

    if (existingProvider) {
      user = await prisma.user.findUnique({
        where: { userId: existingProvider.userId },
        include: { shop: true, userType: true },
      });
    }

    // ── Step 2: Fall back to phone / email match ───────────────────────────────
    if (!user && phoneClean) {
      user = await prisma.user
        .findUnique({ where: { phone: phoneClean }, include: { shop: true, userType: true } })
        .catch(() => null);
    }

    if (!user && emailNormalized) {
      user = await findUserByEmailInsensitive(emailNormalized, { include: { shop: true, userType: true } })
        .catch(() => null);
    }

    // ── Step 3: Sign-in mode — never auto-create, return noAccount instead ──────
    if (!user && mode === 'signin') {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_ACCOUNT', message: 'No account found with these credentials. Please create an account first.' },
      });
    }

    // ── Step 3b: Create new user if still not found ────────────────────────────
    if (!user) {
      const initialRole = role === 'shop' ? 'SHOP_OWNER' : 'CUSTOMER';
      const userTypeId = await getUserTypeId(initialRole);
      user = await prisma.user.create({
        data: {
          phone: phoneClean || null,
          email: emailNormalized || null,
          name: name || null,
          avatarUrl: picture || null,
          role: initialRole,
          userTypeId,
          phoneVerified: !!phoneClean,
          emailVerified: !!emailNormalized,
          isVerified: !!(phoneClean || emailNormalized),
        },
        include: { shop: true, userType: true },
      });
      isNewUser = true;
    } else {
      // ── Step 4: Update stale profile fields on existing user ─────────────────
      const updateData = {};

      if (emailNormalized && emailNormalized !== user.email) {
        updateData.email = emailNormalized;
        updateData.emailVerified = true;
      } else if (emailNormalized && !user.emailVerified) {
        updateData.emailVerified = true;
      }

      if (name && name !== user.name) updateData.name = name;
      if (picture && picture !== user.avatarUrl) updateData.avatarUrl = picture;

      if (Object.keys(updateData).length > 0) {
        user = await prisma.user.update({
          where: { userId: user.userId },
          data: updateData,
          include: { shop: true, userType: true },
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_INACTIVE', message: 'This account has been deactivated. Contact support.' },
      });
    }

    // ── Step 5: Ensure auth providers are linked ──────────────────────────────
    await ensureAuthProvider(user.userId, 'GOOGLE', uid);
    if (phoneClean) await ensureAuthProvider(user.userId, 'PHONE', phoneClean);
    if (emailNormalized) await ensureAuthProvider(user.userId, 'EMAIL', emailNormalized);

    // ── Step 6: Shop owner needing shop setup → collect shop details first ────
    // Covers brand-new shop owners AND returning ones who abandoned the
    // shop-details step (no shop, verification never started). Tokens included:
    // /shop-setup requires a Bearer token.
    if (needsShopSetup(user)) {
      const payload = await shopSetupResponse(res, user, { req, isNewUser });
      return res.json(payload);
    }

    // Block pending/rejected shop owners from logging in via Google
    if (!checkShopOwnerVerification(user, res)) return;

    // ── Step 7: Create session and respond ────────────────────────────────────
    const payload = await createSession(res, user, { isNewUser, req });

    res.json({
      ...payload,
      data: {
        accessToken: payload.accessToken,
        expiresIn: 28800,
        isNewUser,
        user: payload.user,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
