import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../../db/prisma.js';
import { createSession, ensureAuthProvider, findUserByEmailInsensitive, normalizeEmail, checkShopOwnerVerification, getUserTypeId, needsShopSetup, shopSetupResponse } from './helpers.js';

const router = Router();
const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function getGoogleUserInfo(accessToken) {
  // Reject tokens minted for a different OAuth client before trusting them.
  const tokenInfo = await oauthClient.getTokenInfo(accessToken)
    .catch(() => { throw Object.assign(new Error('Failed to verify Google token'), { status: 401 }); });
  if (tokenInfo.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw Object.assign(new Error('Token audience mismatch'), { status: 401 });
  }

  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw Object.assign(new Error('Failed to verify Google token'), { status: 401 });
  return res.json(); // { sub, email, name, picture, email_verified }
}

router.post('/google', async (req, res, next) => {
  try {
    const { accessToken, role } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TOKEN', message: 'accessToken is required' },
      });
    }

    let googleUser;
    try {
      googleUser = await getGoogleUserInfo(accessToken);
    } catch {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Sign-in failed. Please try again.' },
      });
    }

    const { sub: uid, email, name, picture } = googleUser;
    const emailNormalized = normalizeEmail(email);

    let isNewUser = false;
    let user = null;

    // Look up by Google provider uid
    const existingProvider = await prisma.authProvider.findUnique({
      where: { provider_providerId: { provider: 'GOOGLE', providerId: uid } },
    });

    if (existingProvider) {
      user = await prisma.user.findUnique({
        where: { userId: existingProvider.userId },
        include: { shop: true, userType: true },
      });
    }

    // Fall back to email match
    if (!user && emailNormalized) {
      user = await findUserByEmailInsensitive(emailNormalized, { include: { shop: true, userType: true } })
        .catch(() => null);
    }

    // Create new user if not found
    if (!user) {
      const initialRole = role === 'shop' ? 'SHOP_OWNER' : 'CUSTOMER';
      const userTypeId = await getUserTypeId(initialRole);
      user = await prisma.user.create({
        data: {
          email: emailNormalized || null,
          name: name || null,
          avatarUrl: picture || null,
          role: initialRole,
          userTypeId,
          emailVerified: !!emailNormalized,
          isVerified: !!emailNormalized,
        },
        include: { shop: true, userType: true },
      });
      isNewUser = true;
    } else {
      // Update stale profile fields
      const updateData = {};
      if (emailNormalized && emailNormalized !== user.email) { updateData.email = emailNormalized; updateData.emailVerified = true; }
      else if (emailNormalized && !user.emailVerified) { updateData.emailVerified = true; }
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

    await ensureAuthProvider(user.userId, 'GOOGLE', uid);
    if (emailNormalized) await ensureAuthProvider(user.userId, 'EMAIL', emailNormalized);

    if (needsShopSetup(user)) {
      const payload = await shopSetupResponse(res, user, { req, isNewUser });
      return res.json(payload);
    }

    if (!checkShopOwnerVerification(user, res)) return;

    const payload = await createSession(res, user, { isNewUser, req });
    res.json({
      ...payload,
      data: { accessToken: payload.accessToken, expiresIn: 28800, isNewUser, user: payload.user },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
