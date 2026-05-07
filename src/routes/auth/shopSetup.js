import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { sendShopOwnerVerificationAlert } from '../../services/email.js';
import { findUserByEmailInsensitive } from './helpers.js';

const router = Router();

/**
 * POST /api/auth/shop-setup
 *
 * Called after a new shop owner verifies their phone/email but BEFORE
 * we set their account to PENDING. Collects the shop details, creates
 * the Shop record, then sets verificationStatus = PENDING and alerts admins.
 *
 * No auth token required — the userId returned during registration is proof enough.
 * We also enforce that the user must be a SHOP_OWNER in NOT_REQUIRED status
 * (i.e., they have not already submitted their details).
 */
router.post('/shop-setup', async (req, res, next) => {
  try {
    const { ownerName, shopName, city, contactPhone, gstin, address } = req.body;
    // userId from body may be a string (JSON) or number — normalise to Int
    const userId = req.body.userId != null ? parseInt(req.body.userId) : NaN;

    // ── Validate required fields ─────────────────────────────────────────────
    if (!userId || isNaN(userId)) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_USER_ID', message: 'A valid userId (integer) is required' },
      });
    }
    if (!ownerName?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_OWNER_NAME', message: 'Owner name is required' },
      });
    }
    if (!shopName?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_SHOP_NAME', message: 'Shop name is required' },
      });
    }
    if (!city?.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_CITY', message: 'City is required' },
      });
    }
    if (!contactPhone || !/^\d{10}$/.test(contactPhone.replace(/\s/g, ''))) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'A valid 10-digit contact phone number is required' },
      });
    }

    // ── Find user ────────────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' },
      });
    }
    if (user.role !== 'SHOP_OWNER') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_SHOP_OWNER', message: 'This endpoint is for shop owners only' },
      });
    }
    // Prevent double-submit (already gone through setup)
    if (user.verificationStatus === 'PENDING' || user.verificationStatus === 'APPROVED') {
      return res.status(409).json({
        success: false,
        error: { code: 'ALREADY_SUBMITTED', message: 'Shop details have already been submitted for this account' },
      });
    }

    // ── Check phone uniqueness for the shop ─────────────────────────────────
    const cleanPhone = contactPhone.replace(/\s/g, '');
    const existingShop = await prisma.shop.findUnique({ where: { phone: cleanPhone } }).catch(() => null);
    if (existingShop) {
      return res.status(409).json({
        success: false,
        error: { code: 'PHONE_TAKEN', message: 'A shop with this phone number already exists. Use a different number.' },
      });
    }

    // ── Create shop + update user in a single transaction ───────────────────
    const [shop, updatedUser] = await prisma.$transaction([
      prisma.shop.create({
        data: {
          name: shopName.trim(),
          ownerName: ownerName.trim(),
          phone: cleanPhone,
          city: city.trim(),
          gstin: gstin?.trim() || null,
          address: address?.trim() || null,
          state: 'Telangana',
        },
      }),
      prisma.user.update({
        where: { userId },
        data: {
          name: ownerName.trim(),
          verificationStatus: 'PENDING',
        },
      }),
    ]);

    // Link shop to user
    await prisma.user.update({
      where: { userId },
      data: { shopId: shop.shopId },
    });

    // ── Alert all platform admins ────────────────────────────────────────────
    const admins = await prisma.user.findMany({
      where: { role: 'PLATFORM_ADMIN', isActive: true, email: { not: null } },
      select: { email: true },
    });
    sendShopOwnerVerificationAlert(
      { ...updatedUser, shop },
      admins.map(a => a.email)
    ).catch(e => console.error('[EMAIL] Admin alert failed:', e));

    res.json({
      success: true,
      pending: true,
      message: 'Your shop details have been submitted. You will receive an email once approved by our team — usually within 24 hours.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
