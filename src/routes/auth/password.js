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
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_EMAIL', message: 'Email is required' },
      });
    }

    const user = await findUserByEmailInsensitive(emailNormalized);

    // No account at all — tell the user clearly
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'No account found with this email. Please create an account first.' },
      });
    }

    // Account found — allow password set/reset regardless of how they originally signed up.
    // Google/phone users can use this flow to ADD a password to their account
    // so they can also sign in with email + password going forward.

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

    // In dev mode — log the reset URL to console so you can test without email
    if (process.env.NODE_ENV === 'development') {
      const devUrl = `${process.env.RESET_PASSWORD_URL || 'http://localhost:5173/reset-password'}?token=${rawToken}`;
      console.log(`\n[RESET] ✉  DEV MODE — reset link for ${email}:\n${devUrl}\n`);
    }

    // If no password exists yet (Google/phone user), send a "set password" email
    const isFirstPassword = !user.passwordHash;
    console.log(`[RESET] Sending ${isFirstPassword ? 'set-password' : 'reset'} email to: ${email}`);
    await sendPasswordResetEmail(emailNormalized, rawToken, isFirstPassword);
    res.json({ success: true, message: 'Reset link sent! Check your inbox and spam folder.' });
    console.log(`[RESET] Email sent successfully for: ${email}`);
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
