import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../../services/password.js';
import { sendEmailOtp, verifyEmailOtp, sendWelcomeEmail, sendShopOwnerVerificationAlert } from '../../services/email.js';
import { createSession, ensureAuthProvider, findUserByEmailInsensitive, normalizeEmail, checkShopOwnerVerification, getUserTypeId } from './helpers.js';
import { emailLoginLimiter } from '../../middleware/rateLimiter.js';

const router = Router();

// ─── Account lockout constants ───
const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// POST /api/auth/register — email + password signup
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, role, name, vehicle } = req.body;
    const emailNormalized = normalizeEmail(email);

    // Validate email
    if (!emailNormalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_EMAIL', message: 'A valid email address is required' },
      });
    }

    // Validate password strength
    const { valid, errors } = validatePasswordStrength(password);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: { code: 'WEAK_PASSWORD', message: errors.join('. ') },
      });
    }

    // Check if email already exists
    const existing = await findUserByEmailInsensitive(emailNormalized);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists' },
      });
    }

    const passwordHash = await hashPassword(password);
    const initialRole = role === 'shop' ? 'SHOP_OWNER' : 'CUSTOMER';
    const userTypeId = await getUserTypeId(initialRole);

    const user = await prisma.user.create({
      data: {
        email: emailNormalized,
        passwordHash,
        role: initialRole,
        userTypeId,
        emailVerified: false,
        name: name?.trim() || null,
      },
      include: { shop: true, userType: true },
    });

    // Create EMAIL auth provider
    await ensureAuthProvider(user.userId, 'EMAIL', emailNormalized);

    // New shop owner via email → collect shop details first.
    // We do NOT set PENDING yet — that happens after /api/auth/shop-setup is called.
    if (user.role === 'SHOP_OWNER') {
      return res.status(201).json({
        success: true,
        needsShopDetails: true,
        userId: user.userId,
        message: 'Please provide your shop details to complete registration.',
      });
    }

    // Save first vehicle if provided
    if (vehicle?.make && vehicle?.model && vehicle?.year) {
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
      }).catch(e => console.error('[register] vehicle save failed:', e));
    }

    // Send verification OTP + welcome email (fire & forget)
    await sendEmailOtp(emailNormalized);
    sendWelcomeEmail(emailNormalized, user.name).catch(() => {});

    const payload = await createSession(res, user, { isNewUser: true, req });
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login — email + password login
router.post('/login', emailLoginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const emailNormalized = normalizeEmail(email);

    if (!emailNormalized || !password) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Email and password are required' },
      });
    }

    const user = await findUserByEmailInsensitive(emailNormalized, { include: { shop: true, userType: true } });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    if (!user.passwordHash) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_PASSWORD', message: 'This account uses social login and has no password yet' },
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_INACTIVE', message: 'Account is deactivated' },
      });
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil - new Date()) / 60000);
      return res.status(429).json({
        success: false,
        error: {
          code: 'ACCOUNT_LOCKED',
          message: `Account locked due to too many failed attempts. Try again in ${minutesLeft} minute(s).`,
        },
      });
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      const newFailedCount = user.failedLogins + 1;
      const updateData = { failedLogins: newFailedCount };
      if (newFailedCount >= MAX_FAILED_LOGINS) {
        updateData.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      }
      await prisma.user.update({ where: { userId: user.userId }, data: updateData });

      const remaining = MAX_FAILED_LOGINS - newFailedCount;
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_CREDENTIALS',
          message: remaining > 0
            ? `Invalid email or password. ${remaining} attempt(s) remaining.`
            : 'Account locked due to too many failed attempts. Try again in 30 minutes.',
        },
      });
    }

    // Clear failed login counter on success
    if (user.failedLogins > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { userId: user.userId },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    if (user.email) {
      await ensureAuthProvider(user.userId, 'EMAIL', normalizeEmail(user.email));
    }

    if (!checkShopOwnerVerification(user, res)) return;

    const payload = await createSession(res, user, { isNewUser: false, req });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email — verify email OTP
router.post('/verify-email', async (req, res, next) => {
  try {
    const { email, code } = req.body;
    const emailNormalized = normalizeEmail(email);

    if (!emailNormalized || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Email and 6-digit code are required' },
      });
    }

    const { valid } = await verifyEmailOtp(emailNormalized, code);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_OTP', message: 'Invalid or expired verification code' },
      });
    }

    const existingUser = await findUserByEmailInsensitive(emailNormalized);
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'No account found for this email' },
      });
    }

    await prisma.user.update({
      where: { userId: existingUser.userId },
      data: { emailVerified: true },
    });

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/resend-verification — resend email verification OTP
router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    const emailNormalized = normalizeEmail(email);

    if (!emailNormalized) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_EMAIL', message: 'Email is required' },
      });
    }

    const user = await findUserByEmailInsensitive(emailNormalized);
    if (!user) {
      // Don't leak whether the email exists
      return res.json({ success: true, message: 'If the email is registered, a verification code has been sent' });
    }

    if (user.emailVerified) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_VERIFIED', message: 'Email is already verified' },
      });
    }

    await sendEmailOtp(emailNormalized);
    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    next(err);
  }
});

export default router;
