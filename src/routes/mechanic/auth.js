/**
 * mechanic/auth.js — Public + authenticated mechanic auth flows
 *
 * Public router (export publicMechanicAuthRouter):
 *   POST /api/mechanic-auth/accept    — verify OTP, create account, log in
 *   POST /api/mechanic-auth/register  — mechanic self-registers (pending owner approval)
 *
 * Authenticated router (default export, behind requireMechanic):
 *   POST /api/mechanic/team/invite    — HEAD mechanic invites a MEMBER (no owner approval)
 *   GET  /api/mechanic/profile        — own mechanic profile + stats
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import prisma from '../../db/prisma.js';
import { authenticate, requireMechanic } from '../../middleware/auth.js';
import { mechanicInviteVerifyLimiter, emailOtpSendLimiter, authLimiter } from '../../middleware/rateLimiter.js';
import {
  sendMechanicInviteOtp,
  verifyMechanicInviteOtp,
  sendMechanicWelcomeEmail,
  sendEmailOtp,
} from '../../services/email.js';
import { createSession, ensureAuthProvider } from '../auth/helpers.js';
import { generateResetToken, hashResetToken, hashPassword, validatePasswordStrength } from '../../services/password.js';
import { writeAudit, ET, ACT } from '../../lib/audit.js';

// ─── Public router ────────────────────────────────────────────────────────────
export const publicMechanicAuthRouter = Router();

/**
 * POST /api/mechanic-auth/accept
 * Accepts an invite from owner OR head mechanic.
 * Verifies the OTP sent to the invitee's email, creates (or upgrades) the User
 * account to MECHANIC, creates the shop_mechanics row, logs them in.
 */
publicMechanicAuthRouter.post('/accept', mechanicInviteVerifyLimiter, async (req, res, next) => {
  try {
    const rawEmail = req.body?.email;
    const code = req.body?.code;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Email and 6-digit code are required' } });
    }

    // Find the invite — could be from owner or from a head mechanic
    const invites = await prisma.$queryRaw`
      SELECT mi.id, mi.shop_id, mi.mechanic_role, mi.head_mechanic_id, mi.invited_by, mi.sections
      FROM mechanic_invites mi
      WHERE mi.email = ${email} AND mi.status = 'PENDING'
      ORDER BY mi.created_at DESC
      LIMIT 1
    `;
    if (!invites[0]) {
      return res.status(404).json({ success: false, error: { code: 'INVITE_NOT_FOUND', message: 'No pending mechanic invite found for this email' } });
    }
    const invite = invites[0];

    const existingForCheck = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { name: true, phone: true },
    });

    if (!existingForCheck?.name && !name) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Your name is required' } });
    }
    if (!existingForCheck?.phone && !phone) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_PHONE', message: 'Your mobile number is required' } });
    }
    if (!existingForCheck?.phone && phone) {
      const phoneOwner = await prisma.user.findFirst({ where: { phone }, select: { email: true } });
      if (phoneOwner && phoneOwner.email?.toLowerCase() !== email) {
        return res.status(409).json({ success: false, error: { code: 'PHONE_IN_USE', message: 'This mobile number is already linked to another account.' } });
      }
    }

    const { valid } = await verifyMechanicInviteOtp(email, code);
    if (!valid) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or expired verification code' } });
    }

    // Lookup MECHANIC user type id
    const mechanicUserType = await prisma.userType.findUnique({ where: { slug: 'MECHANIC' } });
    if (!mechanicUserType) {
      return res.status(500).json({ success: false, error: { code: 'SETUP_INCOMPLETE', message: 'Mechanic user type not configured' } });
    }

    const user = await prisma.$transaction(async (tx) => {
      let u = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (u) {
        u = await tx.user.update({
          where: { userId: u.userId },
          data: {
            role: 'MECHANIC',
            shopId: Number(invite.shop_id),
            userTypeId: mechanicUserType.id,
            emailVerified: true,
            name: u.name || name,
            phone: u.phone || phone,
          },
          include: { userType: { select: { id: true, name: true, slug: true } } },
        });
      } else {
        u = await tx.user.create({
          data: {
            email,
            name,
            phone: phone || null,
            role: 'MECHANIC',
            shopId: Number(invite.shop_id),
            userTypeId: mechanicUserType.id,
            emailVerified: true,
          },
          include: { userType: { select: { id: true, name: true, slug: true } } },
        });
      }

      // Create or reactivate shop_mechanics row
      await tx.$executeRaw`
        INSERT INTO shop_mechanics (user_id, shop_id, mechanic_role, head_mechanic_id, invited_by, is_active, approval_status, sections)
        VALUES (${u.userId}, ${Number(invite.shop_id)}, ${invite.mechanic_role}, ${invite.head_mechanic_id}, ${Number(invite.invited_by)}, TRUE, 'ACTIVE', ${invite.sections || []})
        ON CONFLICT (shop_id, user_id) DO UPDATE
          SET mechanic_role = ${invite.mechanic_role},
              head_mechanic_id = ${invite.head_mechanic_id},
              is_active = TRUE,
              approval_status = 'ACTIVE',
              invited_by = ${Number(invite.invited_by)},
              sections = ${invite.sections || []}
      `;

      await tx.$executeRaw`
        UPDATE mechanic_invites
        SET status = 'VERIFIED', verified_at = NOW()
        WHERE id = ${Number(invite.id)}
      `;

      return u;
    });

    const payload = await createSession(res, user, { isNewUser: !user.lastLoginAt, req });
    writeAudit(req, { entityType: ET.SHOP, entityId: invite.shop_id, action: ACT.CREATE, newValue: { mechanicInviteAccepted: email } });

    // Fire-and-forget welcome email + password-set link
    (async () => {
      try {
        const shop = await prisma.shop.findUnique({ where: { shopId: Number(invite.shop_id) }, select: { name: true } });
        await prisma.passwordResetToken.updateMany({ where: { userId: user.userId, used: false }, data: { used: true } });
        const rawToken = generateResetToken();
        await prisma.passwordResetToken.create({
          data: { userId: user.userId, tokenHash: hashResetToken(rawToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
        });
        await sendMechanicWelcomeEmail(email, user.name, shop?.name || 'your shop', rawToken);
      } catch (emailErr) {
        console.error('[mechanic/accept] welcome email failed:', emailErr);
      }
    })();

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mechanic-auth/register
 * Mechanic self-registers using the shop's join code.
 * Creates a PENDING shop_mechanics row — owner must approve before active.
 */
publicMechanicAuthRouter.post('/register', mechanicInviteVerifyLimiter, async (req, res, next) => {
  try {
    const rawEmail = req.body?.email;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const joinCode = typeof req.body?.joinCode === 'string' ? req.body.joinCode.trim().toUpperCase() : '';
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email is required' } });
    }
    if (!name) return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Name is required' } });
    if (!phone) return res.status(400).json({ success: false, error: { code: 'MISSING_PHONE', message: 'Phone is required' } });
    if (!joinCode || joinCode.length < 4) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_JOIN_CODE', message: 'Shop join code is required' } });
    }

    // Resolve shop from join code
    const shops = await prisma.$queryRaw`
      SELECT shop_id, name FROM shops
      WHERE mechanic_join_code = ${joinCode} AND is_active = TRUE
    `;
    if (!shops[0]) {
      return res.status(404).json({ success: false, error: { code: 'INVALID_JOIN_CODE', message: 'Invalid or expired shop join code' } });
    }
    const shop = shops[0];

    // Check phone uniqueness
    const phoneOwner = await prisma.user.findFirst({ where: { phone }, select: { email: true } });
    if (phoneOwner && phoneOwner.email?.toLowerCase() !== email) {
      return res.status(409).json({ success: false, error: { code: 'PHONE_IN_USE', message: 'This mobile number is already linked to another account.' } });
    }

    // Check not already active mechanic at this shop
    const existingUser = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existingUser) {
      const existingMechanic = await prisma.$queryRaw`
        SELECT id, is_active, approval_status FROM shop_mechanics
        WHERE shop_id = ${Number(shop.shop_id)} AND user_id = ${existingUser.userId}
      `;
      const em = existingMechanic[0];
      if (em?.is_active && em?.approval_status === 'ACTIVE') {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_MECHANIC', message: 'You are already an active mechanic at this shop' } });
      }
      if (em?.approval_status === 'PENDING') {
        return res.status(409).json({ success: false, error: { code: 'APPROVAL_PENDING', message: 'Your registration is already pending approval' } });
      }
    }

    const mechanicUserType = await prisma.userType.findUnique({ where: { slug: 'MECHANIC' } });
    if (!mechanicUserType) {
      return res.status(500).json({ success: false, error: { code: 'SETUP_INCOMPLETE', message: 'Mechanic user type not configured' } });
    }

    await prisma.$transaction(async (tx) => {
      let u = existingUser;
      if (!u) {
        u = await tx.user.create({
          data: {
            email, name, phone,
            role: 'MECHANIC',
            shopId: Number(shop.shop_id),
            userTypeId: mechanicUserType.id,
            emailVerified: false,
          },
        });
      }

      await tx.$executeRaw`
        INSERT INTO shop_mechanics (user_id, shop_id, mechanic_role, is_active, approval_status)
        VALUES (${u.userId}, ${Number(shop.shop_id)}, 'MEMBER', FALSE, 'PENDING')
        ON CONFLICT (shop_id, user_id) DO UPDATE
          SET approval_status = 'PENDING', is_active = FALSE
      `;
    });

    res.status(201).json({
      success: true,
      message: `Registration submitted to ${shop.name}. You will receive an email once approved by the shop owner.`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mechanic-auth/register-independent
 * Independent mechanic registers without a shop join code.
 * Creates MECHANIC account, sends email OTP, issues tokens immediately.
 * After OTP verify, caller should PATCH /api/mechanic/profile/setup to save details.
 */
publicMechanicAuthRouter.post('/register-independent', authLimiter, async (req, res, next) => {
  try {
    const rawEmail = req.body?.email;
    const password = req.body?.password;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const shopName = typeof req.body?.shopName === 'string' ? req.body.shopName.trim() : null;
    const shopLocation = typeof req.body?.shopLocation === 'string' ? req.body.shopLocation.trim() : null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email is required' } });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'MISSING_PASSWORD', message: 'Password is required' } });
    }
    const { valid, errors } = validatePasswordStrength(password);
    if (!valid) {
      return res.status(400).json({ success: false, error: { code: 'WEAK_PASSWORD', message: errors.join('. ') } });
    }
    if (!name) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Full name is required' } });
    }

    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) {
      return res.status(409).json({ success: false, error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists. Please sign in instead.' } });
    }

    const mechanicUserType = await prisma.userType.findUnique({ where: { slug: 'MECHANIC' } });
    if (!mechanicUserType) {
      return res.status(500).json({ success: false, error: { code: 'SETUP_INCOMPLETE', message: 'Mechanic user type not configured' } });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, name, phone: phone || null, passwordHash, role: 'MECHANIC', userTypeId: mechanicUserType.id, emailVerified: false },
      include: { userType: true },
    });

    await ensureAuthProvider(user.userId, 'EMAIL', email);

    if (shopName || shopLocation) {
      await prisma.$executeRawUnsafe(
        'UPDATE users SET mechanic_shop_name = $1, mechanic_shop_location = $2 WHERE user_id = $3',
        shopName, shopLocation, user.userId
      );
    }

    await sendEmailOtp(email);

    const payload = await createSession(res, user, { isNewUser: true, req });
    return res.status(201).json({ ...payload });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mechanic-auth/send-otp
 * Force-sends an email OTP for mechanic onboarding verification.
 * Works even if the email is already marked verified (Google accounts).
 * Resets emailVerified=false so /api/auth/verify-email can flip it back.
 */
publicMechanicAuthRouter.post('/send-otp', authenticate, emailOtpSendLimiter, async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    const email = req.user?.email;
    if (!userId || !email) return res.status(400).json({ success: false, error: { code: 'NO_EMAIL', message: 'Account has no email address' } });

    await prisma.user.update({ where: { userId }, data: { emailVerified: false } });
    await sendEmailOtp(email);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mechanic-auth/convert-to-mechanic
 * Converts an existing CUSTOMER account to MECHANIC role.
 * Caller must be authenticated (tokens already issued at Google sign-in).
 */
publicMechanicAuthRouter.post('/convert-to-mechanic', authenticate, async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } });

    const existing = await prisma.user.findUnique({ where: { userId }, include: { userType: true } });
    if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (existing.role === 'MECHANIC') return res.status(200).json({ success: true, user: existing });

    const mechanicUserType = await prisma.userType.findUnique({ where: { slug: 'MECHANIC' } });
    if (!mechanicUserType) return res.status(500).json({ success: false, error: { code: 'SETUP_INCOMPLETE', message: 'Mechanic user type not configured' } });

    const user = await prisma.user.update({
      where: { userId },
      data: { role: 'MECHANIC', userTypeId: mechanicUserType.id, shopId: null },
      include: { userType: true },
    });

    return res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// ─── Authenticated mechanic router ────────────────────────────────────────────
const router = Router();

/**
 * GET /api/mechanic/dashboard — summary counts for mechanic dashboard
 */
router.get('/dashboard', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'RECEIVED')                              AS pending,
        COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')                           AS in_progress,
        COUNT(*) FILTER (WHERE status = 'WAITING_PARTS')                         AS waiting_parts,
        COUNT(*) FILTER (WHERE status = 'READY')                                 AS ready_for_qc,
        COUNT(*) FILTER (WHERE status = 'QC_REWORK')                             AS rework,
        COUNT(*) FILTER (WHERE status = 'DELIVERED' AND DATE(delivered_at) = CURRENT_DATE) AS completed_today,
        COUNT(*) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED'))           AS active,
        COALESCE(SUM(mechanic_commission) FILTER (WHERE status = 'DELIVERED'), 0)         AS commission_earned,
        COALESCE(SUM(mechanic_commission) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED')), 0) AS commission_pending
      FROM job_cards
      WHERE assigned_to_user_id = $1
    `, userId);

    const ratingRows = await prisma.$queryRawUnsafe(`
      SELECT AVG(f.rating)::FLOAT AS avg_rating, COUNT(*) AS rating_count
      FROM job_card_feedback f
      JOIN job_cards jc ON jc.job_id = f.job_id
      WHERE jc.assigned_to_user_id = $1
    `, userId);

    const r = rows[0] || {};
    const rr = ratingRows[0] || {};
    const n = (v) => Number(v || 0);
    res.json({
      success: true,
      data: {
        pending:        n(r.pending),
        in_progress:    n(r.in_progress),
        waiting_parts:  n(r.waiting_parts),
        ready_for_qc:   n(r.ready_for_qc),
        rework:         n(r.rework),
        completed_today: n(r.completed_today),
        active:         n(r.active),
        commission_earned:  n(r.commission_earned),
        commission_pending: n(r.commission_pending),
        avg_rating:    rr.avg_rating != null ? Number(rr.avg_rating.toFixed(1)) : null,
        rating_count:  n(rr.rating_count),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/mechanic/profile
 */
router.get('/profile', authenticate, requireMechanic, async (req, res, next) => {
  try {
    let profile;
    if (req.shopId) {
      const rows = await prisma.$queryRaw`
        SELECT
          sm.id, sm.mechanic_role, sm.employee_id, sm.designation, sm.skills,
          sm.joined_at, u.name, u.email, u.phone, u.avatar_url,
          COUNT(DISTINCT jc.job_id) FILTER (WHERE jc.status = 'DELIVERED') AS jobs_completed,
          COUNT(DISTINCT jc.job_id) FILTER (WHERE jc.status NOT IN ('DELIVERED','CANCELLED') AND jc.assigned_to_user_id = ${req.user.userId}) AS jobs_active
        FROM shop_mechanics sm
        JOIN users u ON u.user_id = sm.user_id
        LEFT JOIN job_cards jc ON jc.assigned_to_user_id = sm.user_id AND jc.shop_id = sm.shop_id
        WHERE sm.user_id = ${req.user.userId} AND sm.shop_id = ${req.shopId}
        GROUP BY sm.id, u.user_id
      `;
      profile = rows[0] || null;
    } else {
      // Independent mechanic — no shop_mechanics row; count jobs across all shops
      const rows = await prisma.$queryRaw`
        SELECT
          u.name, u.email, u.phone, u.avatar_url,
          u.mechanic_shop_name, u.mechanic_shop_location,
          'INDEPENDENT' AS mechanic_role, NULL AS employee_id,
          NULL AS designation, ARRAY[]::text[] AS skills, NULL AS joined_at,
          COUNT(DISTINCT jc.job_id) FILTER (WHERE jc.status = 'DELIVERED') AS jobs_completed,
          COUNT(DISTINCT jc.job_id) FILTER (WHERE jc.status NOT IN ('DELIVERED','CANCELLED')) AS jobs_active
        FROM users u
        LEFT JOIN job_cards jc ON jc.assigned_to_user_id = u.user_id
        WHERE u.user_id = ${req.user.userId}
        GROUP BY u.user_id
      `;
      profile = rows[0] || null;
    }
    if (profile) {
      profile.jobs_completed = Number(profile.jobs_completed);
      profile.jobs_active    = Number(profile.jobs_active);

      const ratingRows = await prisma.$queryRaw`
        SELECT AVG(f.rating)::FLOAT AS avg_rating, COUNT(*) AS rating_count
        FROM job_card_feedback f
        JOIN job_cards jc ON jc.job_id = f.job_id
        WHERE jc.assigned_to_user_id = ${req.user.userId}
      `;
      const rr = ratingRows[0] || {};
      profile.avg_rating   = rr.avg_rating != null ? Number(rr.avg_rating.toFixed(1)) : null;
      profile.rating_count = Number(rr.rating_count || 0);
    }
    res.json({ success: true, data: profile });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/mechanic/profile/setup
 * Save name, phone, shopName, shopLocation after independent mechanic registration.
 */
router.patch('/profile/setup', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.replace(/\D/g, '').slice(0, 15) : '';
    const shopName = typeof req.body?.shopName === 'string' ? req.body.shopName.trim() : '';
    const shopLocation = typeof req.body?.shopLocation === 'string' ? req.body.shopLocation.trim() : '';

    if (!name) return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Name is required' } });

    if (phone) {
      const phoneOwner = await prisma.user.findFirst({
        where: { phone, NOT: { userId: req.user.userId } },
        select: { userId: true },
      });
      if (phoneOwner) {
        return res.status(409).json({ success: false, error: { code: 'PHONE_IN_USE', message: 'This mobile number is linked to another account.' } });
      }
    }

    const updated = await prisma.$queryRaw`
      UPDATE users
      SET name = ${name},
          phone = ${phone || null},
          mechanic_shop_name = ${shopName || null},
          mechanic_shop_location = ${shopLocation || null}
      WHERE user_id = ${req.user.userId}
      RETURNING user_id AS "userId", name, email, phone, role, avatar_url AS "avatarUrl",
                mechanic_shop_name AS "mechanicShopName", mechanic_shop_location AS "mechanicShopLocation"
    `;

    res.json({ success: true, data: updated[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/mechanic/profile/skills
 * Mechanic updates their own skills list.
 */
router.patch('/profile/skills', authenticate, requireMechanic, async (req, res, next) => {
  try {
    const skills = Array.isArray(req.body?.skills)
      ? req.body.skills.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
      : [];

    await prisma.$executeRaw`
      UPDATE shop_mechanics SET skills = ${skills}
      WHERE user_id = ${req.user.userId} AND shop_id = ${req.shopId}
    `;

    res.json({ success: true, data: { skills } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mechanic/team/invite
 * HEAD mechanic invites a MEMBER — no owner approval required.
 */
router.post('/team/invite', authenticate, requireMechanic, async (req, res, next) => {
  try {
    // Only HEAD mechanics can invite
    const myRecord = await prisma.$queryRaw`
      SELECT id, mechanic_role FROM shop_mechanics
      WHERE user_id = ${req.user.userId} AND shop_id = ${req.shopId} AND is_active = TRUE
    `;
    if (!myRecord[0]) {
      return res.status(403).json({ success: false, error: { code: 'NOT_MECHANIC', message: 'No active mechanic record found' } });
    }
    if (myRecord[0].mechanic_role !== 'HEAD') {
      return res.status(403).json({ success: false, error: { code: 'NOT_HEAD', message: 'Only HEAD mechanics can invite team members' } });
    }

    const rawEmail = req.body?.email;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email is required' } });
    }
    if (email === req.user.email?.toLowerCase()) {
      return res.status(400).json({ success: false, error: { code: 'SELF_INVITE', message: 'You cannot invite yourself' } });
    }

    await prisma.$executeRaw`
      INSERT INTO mechanic_invites (shop_id, email, mechanic_role, head_mechanic_id, invited_by, status)
      VALUES (${req.shopId}, ${email}, 'MEMBER', ${Number(myRecord[0].id)}, ${req.user.userId}, 'PENDING')
      ON CONFLICT (shop_id, email) DO UPDATE
        SET mechanic_role = 'MEMBER',
            head_mechanic_id = ${Number(myRecord[0].id)},
            invited_by = ${req.user.userId},
            status = 'PENDING',
            verified_at = NULL,
            created_at = NOW()
    `;

    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { name: true } });
    try {
      await sendMechanicInviteOtp(email, { shopName: shop?.name || 'your shop', mechanicRole: 'MEMBER' });
    } catch (emailErr) {
      return res.status(502).json({
        success: false,
        error: { code: emailErr.code || 'EMAIL_SEND_FAILED', message: `Invite saved but email could not be sent: ${emailErr.message}` },
      });
    }

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
