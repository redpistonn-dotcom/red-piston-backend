import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { hashPassword, validatePasswordStrength, generateResetToken, hashResetToken } from '../../services/password.js';
import { sendPasswordResetEmail, sendPasswordChangedEmail } from '../../services/email.js';
import { passwordResetLimiter } from '../../middleware/rateLimiter.js';
import { findUserByEmailInsensitive, normalizeEmail } from './helpers.js';

const router = Router();

// POST /api/auth/set-password
// Used for accounts created via social login that do not have a password yet.
router.post('/set-password', async (req, res, next) => {
  try {
    const { email, newPassword } = req.body;
    const emailNormalized = normalizeEmail(email);

    if (!emailNormalized || !newPassword) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Email and new password are required' },
      });
    }

    const { valid, errors } = validatePasswordStrength(newPassword);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: { code: 'WEAK_PASSWORD', message: errors.join('. ') },
      });
    }

    const user = await findUserByEmailInsensitive(emailNormalized);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'No account found for this email' },
      });
    }

    if (user.passwordHash) {
      return res.status(400).json({
        success: false,
        error: { code: 'PASSWORD_ALREADY_SET', message: 'Password is already set. Please log in normally or reset your password.' },
      });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { userId: user.userId },
      data: { passwordHash, failedLogins: 0, lockedUntil: null },
    });

    if (user.email) {
      sendPasswordChangedEmail(user.email).catch(() => {});
    }

    return res.json({ success: true, message: 'Password set successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', passwordResetLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    const emailNormalized = normalizeEmail(email);
    console.log(`[RESET] Password reset requested for: ${email}`);
    if (!emailNormalized) {
      console.log('[RESET] Missing email in request');
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_EMAIL', message: 'Email is required' },
      });
    }
    // Always return success to avoid leaking email existence
    const user = await findUserByEmailInsensitive(emailNormalized);
    if (!user || !user.passwordHash) {
      console.log(`[RESET] No user found or no password hash for: ${email}`);
      return res.json({ success: true, message: 'If the email is registered, a reset link has been sent' });
    }
    // Invalidate previous unused tokens for this user
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.userId, used: false },
      data: { used: true },
    });
    const rawToken = generateResetToken();
    const tokenHash = hashResetToken(rawToken);
    await prisma.passwordResetToken.create({
      data: {
        userId: user.userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });
    console.log(`[RESET] Sending password reset email to: ${email}`);
    await sendPasswordResetEmail(emailNormalized, rawToken);
    res.json({ success: true, message: 'If the email is registered, a reset link has been sent' });
    console.log(`[RESET] Password reset flow completed for: ${email}`);
  } catch (err) {
    console.error('[RESET] Error in password reset flow:', err);
    next(err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Token and new password are required' },
      });
    }

    const { valid, errors } = validatePasswordStrength(newPassword);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: { code: 'WEAK_PASSWORD', message: errors.join('. ') },
      });
    }

    const tokenHash = hashResetToken(token);
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!resetToken || resetToken.used || resetToken.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired reset token' },
      });
    }

    const passwordHash = await hashPassword(newPassword);

    // Update password + mark token used + clear lockout
    await prisma.$transaction([
      prisma.user.update({
        where: { userId: resetToken.userId },
        data: { passwordHash, failedLogins: 0, lockedUntil: null },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true },
      }),
      // Revoke all refresh tokens (force re-login on all devices)
      prisma.refreshToken.deleteMany({
        where: { userId: resetToken.userId },
      }),
    ]);

    // Send security notification (fire & forget)
    const user = await prisma.user.findUnique({ where: { userId: resetToken.userId }, select: { email: true } });
    if (user?.email) {
      sendPasswordChangedEmail(user.email).catch(() => {});
    }

    res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    next(err);
  }
});

export default router;
