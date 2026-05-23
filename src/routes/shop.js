/**
 * shop.js — Shop Profile Management
 *
 * Mounted at: /api/shop/profile
 *
 * GET  /            get shop profile (for the logged-in shop owner)
 * PUT  /            update shop profile (address, GST, bank details, etc.)
 * PUT  /bank        update bank/payout details only
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

// ─── GET /api/shop/profile ────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopId: req.shopId },
      include: {
        shopUsers: {
          where:  { isActive: true },
          include: { user: { select: { userId: true, name: true, phone: true, role: true } } },
        },
      },
    });
    if (!shop) return res.status(404).json({ success: false, error: { message: 'Shop not found' } });

    // Mask sensitive bank details — only return last 4 digits of account number
    const safeShop = {
      ...shop,
      bankAccountNumber: shop.bankAccountNumber
        ? `****${shop.bankAccountNumber.slice(-4)}`
        : null,
    };

    res.json({ success: true, shop: safeShop });
  } catch (err) { next(err); }
});

// ─── PUT /api/shop/profile ────────────────────────────────────────────────────
router.put('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      name, ownerName, email,
      address, city, state, pincode,
      latitude, longitude,
      gstin, panNumber, stateCode,
      deliveryRadiusKm,
      shopDescription, logoUrl,
    } = req.body;

    const data = {};
    if (name             !== undefined) data.name            = name.trim();
    if (ownerName        !== undefined) data.ownerName       = ownerName.trim();
    if (email            !== undefined) data.email           = email || null;
    if (address          !== undefined) data.address         = address || null;
    if (city             !== undefined) data.city            = city || null;
    if (state            !== undefined) data.state           = state || null;
    if (pincode          !== undefined) data.pincode         = pincode || null;
    if (latitude         !== undefined) data.latitude        = latitude  ? parseFloat(latitude)  : null;
    if (longitude        !== undefined) data.longitude       = longitude ? parseFloat(longitude) : null;
    if (gstin            !== undefined) data.gstin           = gstin || null;
    if (panNumber        !== undefined) data.panNumber       = panNumber || null;
    if (stateCode        !== undefined) data.stateCode       = stateCode || null;
    if (deliveryRadiusKm !== undefined) data.deliveryRadiusKm = parseInt(deliveryRadiusKm);
    if (shopDescription  !== undefined) data.shopDescription = shopDescription || null;
    if (logoUrl          !== undefined) data.logoUrl         = logoUrl || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No fields to update' } });
    }

    const shop = await prisma.shop.update({
      where: { shopId: req.shopId },
      data,
    });

    res.json({ success: true, shop });
  } catch (err) { next(err); }
});

// ─── PUT /api/shop/profile/bank — update bank / payout details ───────────────
// Separate endpoint so the regular profile update doesn't accidentally expose bank fields.
router.put('/bank', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { bankAccountNumber, bankIfsc, bankAccountName } = req.body;

    if (!bankAccountNumber || !bankIfsc || !bankAccountName) {
      return res.status(400).json({
        success: false,
        error: { message: 'bankAccountNumber, bankIfsc, and bankAccountName are required' },
      });
    }

    // Basic IFSC format check (11 chars, starts with 4 alpha)
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc.toUpperCase())) {
      return res.status(400).json({ success: false, error: { message: 'Invalid IFSC code format' } });
    }

    await prisma.shop.update({
      where: { shopId: req.shopId },
      data: {
        bankAccountNumber: bankAccountNumber.trim(),
        bankIfsc:          bankIfsc.toUpperCase().trim(),
        bankAccountName:   bankAccountName.trim(),
      },
    });

    res.json({ success: true, message: 'Bank details updated' });
  } catch (err) { next(err); }
});

export default router;
