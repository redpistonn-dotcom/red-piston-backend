import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { sendOtp, verifyOtp } from '../../services/otp.js';
import { otpSendLimiter } from '../../middleware/rateLimiter.js';
import { createSession, ensureAuthProvider, checkShopOwnerVerification, getUserTypeId } from './helpers.js';
import { sendShopOwnerVerificationAlert } from '../../services/email.js';

const router = Router();

const OTP_MAX_FAILURES = 5;
const OTP_LOCK_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if a phone is currently locked due to too many OTP failures.
 * Uses DB so failure counts survive server restarts (unlike the previous Map).
 */
async function isOtpLocked(phone) {
  // Count recent failed (used=false, not expired) OTP codes with high attempt counts
  const recentLocked = await prisma.otpCode.findFirst({
    where: {
      phone,
      used: false,
      attempts: { gte: OTP_MAX_FAILURES },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  return !!recentLocked;
}

// POST /api/auth/request-otp
router.post('/request-otp', otpSendLimiter, async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'A valid 10-digit phone number is required' },
      });
    }

    if (await isOtpLocked(phone)) {
      return res.status(429).json({
        success: false,
        error: { code: 'OTP_LOCKED', message: 'Too many failed attempts. Please wait 15 minutes before trying again.' },
      });
    }

    await sendOtp(phone);
    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, otp, role, name, vehicle } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'A valid 10-digit phone number is required' },
      });
    }
    if (!otp || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OTP', message: 'OTP must be 6 digits' },
      });
    }

    if (await isOtpLocked(phone)) {
      return res.status(429).json({
        success: false,
        error: { code: 'OTP_LOCKED', message: 'Too many failed attempts. Please wait 15 minutes.' },
      });
    }

    const ipAddress = req.ip || req.connection?.remoteAddress || null;
    const { valid, otpRecord } = await verifyOtp(phone, otp);

    if (!valid) {
      // Increment the failure counter on the latest OTP record for this phone
      if (otpRecord?.id) {
        await prisma.otpCode.update({
          where: { id: otpRecord.id },
          data: { attempts: { increment: 1 } },
        }).catch(() => {});
      }

      // Count remaining attempts
      const latest = await prisma.otpCode.findFirst({
        where: { phone, used: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      const remaining = Math.max(0, OTP_MAX_FAILURES - (latest?.attempts || 0));

      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_OTP',
          message: remaining > 0
            ? `Invalid or expired OTP. ${remaining} attempt(s) remaining.`
            : 'Account locked due to too many failed attempts. Try again in 15 minutes.',
        },
      });
    }

    // Mark OTP as verified
    if (otpRecord?.id) {
      await prisma.otpCode.update({
        where: { id: otpRecord.id },
        data: { used: true, verifiedAt: new Date() },
      }).catch(() => {});
    }

    // Upsert user by phone
    let isNewUser = false;
    let user = await prisma.user.findUnique({ where: { phone }, include: { shop: true, userType: true } });
    if (!user) {
      const initialRole = role === 'shop' ? 'SHOP_OWNER' : 'CUSTOMER';
      const userTypeId = await getUserTypeId(initialRole);
      user = await prisma.user.create({
        data: { phone, role: initialRole, userTypeId, phoneVerified: true, isVerified: true, name: name?.trim() || null },
        include: { shop: true, userType: true },
      });
      isNewUser = true;
      // Save first vehicle for new customers
      if (user.role === 'CUSTOMER' && vehicle?.make && vehicle?.model && vehicle?.year) {
        await prisma.customerVehicle.create({
          data: {
            userId: user.userId,
            make: vehicle.make.trim(),
            model: vehicle.model.trim(),
            year: parseInt(vehicle.year),
            variant: vehicle.variant?.trim() || null,
            fuelType: vehicle.fuelType?.trim() || null,
            registrationNo: vehicle.registrationNo?.trim() || null,
            isDefault: true,
          },
        }).catch(e => console.error('[verify-otp] vehicle save failed:', e));
      }
    } else if (!user.phoneVerified) {
      user = await prisma.user.update({
        where: { userId: user.userId },
        data: { phoneVerified: true, isVerified: true },
        include: { shop: true, userType: true },
      });
    }

    await ensureAuthProvider(user.userId, 'PHONE', phone);

    // New shop owner via phone → collect shop details first (frontend shows SHOP_DETAILS form).
    // We do NOT set PENDING yet — that happens after shop-setup is submitted.
    if (isNewUser && user.role === 'SHOP_OWNER') {
      return res.json({
        success: true,
        needsShopDetails: true,
        userId: user.userId,
        phone: user.phone,
        message: 'Please provide your shop details to complete registration.',
      });
    }

    // Block pending/rejected shop owners from logging in
    if (!checkShopOwnerVerification(user, res)) return;

    const payload = await createSession(res, user, { isNewUser, req });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export default router;
