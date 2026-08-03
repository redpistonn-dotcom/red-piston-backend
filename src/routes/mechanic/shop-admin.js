/**
 * mechanic/shop-admin.js — Owner-side mechanic management
 *
 * Mounted at: /api/shop/mechanics  (behind authenticate + requireSection('staff'))
 *
 * Routes:
 *   GET    /                        — list mechanics (active + inactive + pending approval)
 *   GET    /invites                 — list pending mechanic invites
 *   POST   /invite                  — owner invites mechanic by email
 *   POST   /invite/:id/resend       — resend invite OTP
 *   DELETE /invite/:id              — cancel invite
 *   PATCH  /:id/approve             — approve self-registered mechanic
 *   PATCH  /:id/reject              — reject self-register request
 *   PATCH  /:id/role                — change HEAD ↔ MEMBER
 *   PATCH  /:id/deactivate          — soft remove mechanic access
 *   PATCH  /:id/reactivate          — re-enable mechanic access
 *   GET    /join-code               — get (or generate) shop's mechanic join code
 *   POST   /join-code/rotate        — rotate the join code
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import prisma from '../../db/prisma.js';
import { authenticate, requireShopOwner } from '../../middleware/auth.js';
import { sendMechanicInviteOtp, sendMechanicWelcomeEmail } from '../../services/email.js';
import { generateResetToken, hashResetToken } from '../../services/password.js';
import { writeAudit, ET, ACT } from '../../lib/audit.js';

const router = Router();

const VALID_MECHANIC_ROLES = ['HEAD', 'MEMBER'];

function generateJoinCode() {
  return randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

async function getOrCreateJoinCode(shopId) {
  const shop = await prisma.$queryRaw`
    SELECT mechanic_join_code FROM shops WHERE shop_id = ${shopId}
  `;
  let code = shop[0]?.mechanic_join_code;
  if (!code) {
    code = generateJoinCode();
    await prisma.$executeRaw`
      UPDATE shops SET mechanic_join_code = ${code}
      WHERE shop_id = ${shopId} AND mechanic_join_code IS NULL
    `;
  }
  return code;
}

// GET / — list all mechanics for this shop
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        sm.id, sm.mechanic_role, sm.approval_status, sm.employee_id,
        sm.designation, sm.skills, sm.is_active, sm.joined_at,
        sm.head_mechanic_id,
        u.user_id, u.name, u.email, u.phone, u.avatar_url, u.last_login_at,
        hm_u.name AS head_mechanic_name
      FROM shop_mechanics sm
      JOIN users u ON u.user_id = sm.user_id
      LEFT JOIN shop_mechanics hm ON hm.id = sm.head_mechanic_id
      LEFT JOIN users hm_u ON hm_u.user_id = hm.user_id
      WHERE sm.shop_id = ${req.shopId}
      ORDER BY sm.is_active DESC, sm.mechanic_role ASC, sm.joined_at ASC
    `;
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /invites
router.get('/invites', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invites = await prisma.$queryRaw`
      SELECT id, email, mechanic_role, status, created_at
      FROM mechanic_invites
      WHERE shop_id = ${req.shopId} AND status IN ('PENDING', 'EXPIRED')
      ORDER BY created_at DESC
    `;
    res.json({ success: true, data: invites });
  } catch (err) {
    next(err);
  }
});

// GET /join-code
router.get('/join-code', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const code = await getOrCreateJoinCode(req.shopId);
    res.json({ success: true, data: { joinCode: code } });
  } catch (err) {
    next(err);
  }
});

// POST /join-code/rotate
router.post('/join-code/rotate', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const code = generateJoinCode();
    await prisma.$executeRaw`
      UPDATE shops SET mechanic_join_code = ${code} WHERE shop_id = ${req.shopId}
    `;
    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.UPDATE, newValue: { mechanicJoinCodeRotated: true } });
    res.json({ success: true, data: { joinCode: code } });
  } catch (err) {
    next(err);
  }
});

// POST /invite — owner invites mechanic by email
router.post('/invite', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { email: rawEmail, mechanicRole = 'MEMBER' } = req.body;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email is required' } });
    }
    if (!VALID_MECHANIC_ROLES.includes(mechanicRole)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ROLE', message: 'mechanicRole must be HEAD or MEMBER' } });
    }
    if (email === req.user.email?.toLowerCase()) {
      return res.status(400).json({ success: false, error: { code: 'SELF_INVITE', message: 'You cannot invite yourself' } });
    }

    // Guard: email already active mechanic at this shop
    const existingUser = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existingUser) {
      const existingMechanic = await prisma.$queryRaw`
        SELECT id, is_active FROM shop_mechanics WHERE shop_id = ${req.shopId} AND user_id = ${existingUser.userId}
      `;
      if (existingMechanic[0]?.is_active) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_MECHANIC', message: 'This person is already an active mechanic at your shop' } });
      }
    }

    await prisma.$executeRaw`
      INSERT INTO mechanic_invites (shop_id, email, mechanic_role, invited_by, status)
      VALUES (${req.shopId}, ${email}, ${mechanicRole}, ${req.user.userId}, 'PENDING')
      ON CONFLICT (shop_id, email) DO UPDATE
        SET mechanic_role = ${mechanicRole}, invited_by = ${req.user.userId},
            status = 'PENDING', verified_at = NULL, created_at = NOW()
    `;

    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { name: true } });
    try {
      await sendMechanicInviteOtp(email, { shopName: shop?.name || 'your shop', mechanicRole });
    } catch (emailErr) {
      console.error('[mechanic/invite] Email send failed', emailErr);
      return res.status(502).json({
        success: false,
        error: { code: emailErr.code || 'EMAIL_SEND_FAILED', message: `Invite saved but email could not be sent: ${emailErr.message}` },
      });
    }

    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.CREATE, newValue: { mechanicInvite: { email, mechanicRole } } });
    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /invite/:id/resend
router.post('/invite/:id/resend', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invites = await prisma.$queryRaw`
      SELECT id, email, mechanic_role FROM mechanic_invites
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId} AND status = 'PENDING'
    `;
    if (!invites[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending invite not found' } });
    }
    const invite = invites[0];
    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { name: true } });
    try {
      await sendMechanicInviteOtp(invite.email, { shopName: shop?.name || 'your shop', mechanicRole: invite.mechanic_role });
    } catch (emailErr) {
      return res.status(502).json({
        success: false,
        error: { code: emailErr.code || 'EMAIL_SEND_FAILED', message: `Could not send email: ${emailErr.message}` },
      });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /invite/:id
router.delete('/invite/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const result = await prisma.$executeRaw`
      UPDATE mechanic_invites SET status = 'CANCELLED'
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId} AND status = 'PENDING'
    `;
    if (!result) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending invite not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/approve — approve self-registered mechanic
router.patch('/:id/approve', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { mechanicRole = 'MEMBER' } = req.body;
    if (!VALID_MECHANIC_ROLES.includes(mechanicRole)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ROLE', message: 'mechanicRole must be HEAD or MEMBER' } });
    }

    // Fetch before updating — need user_id for the welcome email, and the row
    // must exist to know self-registration actually happened.
    const pending = await prisma.$queryRaw`
      SELECT sm.user_id, u.email, u.name
      FROM shop_mechanics sm
      JOIN users u ON u.user_id = sm.user_id
      WHERE sm.id = ${parseInt(req.params.id, 10)} AND sm.shop_id = ${req.shopId} AND sm.approval_status = 'PENDING'
    `;
    if (!pending[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending mechanic not found' } });
    }
    const { user_id: userId, email, name } = pending[0];

    await prisma.$executeRaw`
      UPDATE shop_mechanics
      SET approval_status = 'ACTIVE', mechanic_role = ${mechanicRole}, is_active = TRUE
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId} AND approval_status = 'PENDING'
    `;
    await prisma.user.update({ where: { userId }, data: { emailVerified: true } });

    writeAudit(req, { entityType: ET.SHOP, entityId: req.shopId, action: ACT.UPDATE, newValue: { mechanicApproved: req.params.id, mechanicRole } });
    res.json({ success: true });

    // Fire-and-forget: same welcome + set-password-link email as the
    // invite-accept path (mechanic/auth.js), so self-registered mechanics get
    // a way to set a password too — self-signup never collects one upfront.
    (async () => {
      try {
        const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { name: true } });
        await prisma.passwordResetToken.updateMany({ where: { userId, used: false }, data: { used: true } });
        const rawToken = generateResetToken();
        await prisma.passwordResetToken.create({
          data: { userId, tokenHash: hashResetToken(rawToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
        });
        await sendMechanicWelcomeEmail(email, name, shop?.name || 'your shop', rawToken);
      } catch (emailErr) {
        console.error('[mechanic/approve] welcome email failed:', emailErr);
      }
    })();
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/reject
router.patch('/:id/reject', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const result = await prisma.$executeRaw`
      UPDATE shop_mechanics
      SET approval_status = 'REJECTED', is_active = FALSE
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId} AND approval_status = 'PENDING'
    `;
    if (!result) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending mechanic not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/role
router.patch('/:id/role', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { mechanicRole } = req.body;
    if (!VALID_MECHANIC_ROLES.includes(mechanicRole)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ROLE', message: 'mechanicRole must be HEAD or MEMBER' } });
    }
    await prisma.$executeRaw`
      UPDATE shop_mechanics SET mechanic_role = ${mechanicRole}
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId}
    `;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/deactivate
router.patch('/:id/deactivate', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    await prisma.$executeRaw`
      UPDATE shop_mechanics SET is_active = FALSE
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId}
    `;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/reactivate
router.patch('/:id/reactivate', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    await prisma.$executeRaw`
      UPDATE shop_mechanics SET is_active = TRUE, approval_status = 'ACTIVE'
      WHERE id = ${parseInt(req.params.id, 10)} AND shop_id = ${req.shopId}
    `;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
