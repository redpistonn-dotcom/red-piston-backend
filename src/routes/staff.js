/**
 * staff.js — Shop Staff Management + Invite Routes
 *
 * Mounted at: /api/shop/staff
 *
 * Routes:
 *   GET    /api/shop/staff                    — list active/inactive staff for current shop
 *   GET    /api/shop/staff/invites            — list pending/expired invites for current shop
 *   POST   /api/shop/staff/invite             — create a pending invite + email a verification code
 *   POST   /api/shop/staff/invite/:id/resend  — resend the code for a pending invite
 *   DELETE /api/shop/staff/invite/:id         — cancel a pending invite
 *   POST   /api/shop/staff/accept-invite      — PUBLIC: verify the code, create/activate the account
 *   PATCH  /api/shop/staff/:id/role           — change role label / sections
 *   PATCH  /api/shop/staff/:id/deactivate     — soft-remove staff access
 *   PATCH  /api/shop/staff/:id/reactivate     — re-enable staff access
 *   DELETE /api/shop/staff/:id                — hard-remove staff member
 *
 * Access model: a shop owner picks SECTIONS (sidebar keys) when inviting —
 * `ShopUser.sections` is authoritative for nav visibility + frontend route
 * access. `ShopUser.permissions` (dot-namespace strings, see lib/permissions.js)
 * is derived from those sections via lib/section-permissions.js so the
 * existing requirePermission() API gates keep working unchanged.
 *
 * The legacy fixed-role invite (OWNER/MANAGER/CASHIER/MECHANIC/DELIVERY with a
 * flat-boolean permissions object) is gone — that permissions shape never
 * actually matched what hasPermission() checks (dot-namespace strings), so it
 * was silently ignored in practice. `role` is now just "STAFF" for anyone
 * invited through this flow (intentionally absent from ROLE_DEFAULTS, so any
 * gap in the sections->permissions map denies by default instead of quietly
 * falling back to an unrelated legacy role's grants).
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { staffInviteVerifyLimiter } from '../middleware/rateLimiter.js';
import { sendStaffInviteOtp, verifyStaffInviteOtp, sendStaffWelcomeEmail } from '../services/email.js';
import { generateResetToken, hashResetToken } from '../services/password.js';
import { createSession } from './auth/helpers.js';
import { SECTION_KEYS, isValidSection, permissionsFromSections } from '../lib/section-permissions.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

// Guard: user must be a SHOP_OWNER
function requireShopOwner(req, res, next) {
  if (!req.user.shopId) {
    return res.status(403).json({
      success: false,
      error: { code: 'NO_SHOP', message: 'You do not have a shop' },
    });
  }
  if (req.user.role !== 'SHOP_OWNER') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only shop owners can manage staff' },
    });
  }
  next();
}

function validateSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return 'At least one section is required';
  if (!sections.every(isValidSection)) return `sections must be a subset of: ${SECTION_KEYS.join(', ')}`;
  return null;
}

// GET /api/shop/staff — list all staff with user details
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const staff = await prisma.shopUser.findMany({
      where: { shopId: req.user.shopId },
      include: {
        user: {
          select: { userId: true, name: true, phone: true, email: true, avatarUrl: true, lastLoginAt: true },
        },
      },
      orderBy: [{ isActive: 'desc' }, { joinedAt: 'asc' }],
    });

    const result = staff.map(s => ({
      id: s.id,
      role: s.role,
      roleLabel: s.roleLabel,
      sections: s.sections,
      permissions: s.permissions,
      isActive: s.isActive,
      joinedAt: s.joinedAt,
      lastActiveAt: s.lastActiveAt,
      invitedBy: s.invitedBy,
      user: s.user,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/staff/invites — pending/expired invites for this shop
router.get('/invites', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invites = await prisma.staffInvite.findMany({
      where: { shopId: req.user.shopId, status: { in: ['PENDING', 'EXPIRED'] } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: invites });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/staff/invite — create a pending invite + email a verification code.
// Works for a brand-new email (no account yet) or an existing account — either way,
// nothing is granted until they verify via POST /accept-invite.
router.post('/invite', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { email: rawEmail, roleLabel, sections } = req.body;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email is required' } });
    }
    if (!roleLabel?.trim()) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_ROLE_LABEL', message: 'A role label (e.g. "Mechanic") is required' } });
    }
    const sectionsError = validateSections(sections);
    if (sectionsError) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_SECTIONS', message: sectionsError } });
    }
    if (email === req.user.email?.toLowerCase()) {
      return res.status(400).json({ success: false, error: { code: 'SELF_INVITE', message: 'You cannot invite yourself' } });
    }

    // If this email already belongs to an account, make sure inviting them here
    // wouldn't silently move them out from under another shop — every request
    // scopes strictly by User.shopId, so one account can only ever belong to one shop.
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (existingUser.shopId && existingUser.shopId !== req.user.shopId) {
        return res.status(409).json({
          success: false,
          error: { code: 'ALREADY_AT_ANOTHER_SHOP', message: 'This person already has an account tied to a different shop.' },
        });
      }
      const existingMembership = await prisma.shopUser.findUnique({
        where: { shopId_userId: { shopId: req.user.shopId, userId: existingUser.userId } },
      });
      if (existingMembership?.isActive) {
        return res.status(409).json({ success: false, error: { code: 'ALREADY_STAFF', message: 'This person is already staff at your shop' } });
      }
    }

    const invite = await prisma.staffInvite.upsert({
      where: { shopId_email: { shopId: req.user.shopId, email } },
      create: {
        shopId: req.user.shopId, email,
        roleLabel: roleLabel.trim(), sections, invitedBy: req.user.userId, status: 'PENDING',
      },
      update: {
        roleLabel: roleLabel.trim(), sections, invitedBy: req.user.userId, status: 'PENDING', verifiedAt: null,
      },
    });

    const shop = await prisma.shop.findUnique({ where: { shopId: req.user.shopId }, select: { name: true } });
    try {
      await sendStaffInviteOtp(email, { shopName: shop?.name || 'your shop', roleLabel: roleLabel.trim() });
    } catch (emailErr) {
      console.error('[staff/invite] Email send failed', emailErr);
      // The invite row stays PENDING so "Resend" can retry — but tell the
      // owner right away instead of showing a false "invite sent" success.
      return res.status(502).json({
        success: false,
        error: { code: emailErr.code || 'EMAIL_SEND_FAILED', message: `Invite was saved, but the email could not be sent: ${emailErr.message}` },
      });
    }

    writeAudit(req, { entityType: ET.SHOP, entityId: req.user.shopId, action: ACT.CREATE, newValue: { staffInvite: { email, roleLabel, sections } } });

    res.status(201).json({ success: true, data: invite });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/staff/invite/:id/resend — resend the code for a pending invite
router.post('/invite/:id/resend', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invite = await prisma.staffInvite.findFirst({
      where: { id: parseInt(req.params.id, 10), shopId: req.user.shopId, status: 'PENDING' },
    });
    if (!invite) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending invite not found' } });
    }
    const shop = await prisma.shop.findUnique({ where: { shopId: req.user.shopId }, select: { name: true } });
    try {
      await sendStaffInviteOtp(invite.email, { shopName: shop?.name || 'your shop', roleLabel: invite.roleLabel });
    } catch (emailErr) {
      console.error('[staff/invite/resend] Email send failed', emailErr);
      return res.status(502).json({
        success: false,
        error: { code: emailErr.code || 'EMAIL_SEND_FAILED', message: `Could not send the email: ${emailErr.message}` },
      });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shop/staff/invite/:id — cancel a pending invite
router.delete('/invite/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const result = await prisma.staffInvite.updateMany({
      where: { id: parseInt(req.params.id, 10), shopId: req.user.shopId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (result.count === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending invite not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Deliberately a SEPARATE router mounted on its OWN unguarded path (see
// index.js) — everything else in this file sits behind `authenticate,
// requireSection('staff')` applied at the /api/shop/staff mount point, which
// would 401 an invitee who has no account/token yet before this route ever ran.
export const publicStaffInviteRouter = Router();

// POST /api/shop/staff-invite/accept — PUBLIC (no auth: the invitee may have no
// account yet). Verifies the emailed code, creates/upgrades the User to
// SHOP_STAFF pinned to the inviting shop, activates the ShopUser row, and logs
// them straight in (same session shape as a normal login).
publicStaffInviteRouter.post('/accept', staffInviteVerifyLimiter, async (req, res, next) => {
  try {
    const rawEmail = req.body?.email;
    const code = req.body?.code;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    // The shop owner no longer supplies these — the invitee provides their own
    // name + mobile number right here, at verification time.
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';

    if (!email || !code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Email and 6-digit code are required' } });
    }

    const invite = await prisma.staffInvite.findFirst({ where: { email, status: 'PENDING' } });
    if (!invite) {
      return res.status(404).json({ success: false, error: { code: 'INVITE_NOT_FOUND', message: 'No pending invite found for this email' } });
    }

    // Only required for a brand-new account — an existing account already has
    // these, so don't force the invitee to re-enter (or overwrite) them.
    const existingForCheck = await prisma.user.findUnique({ where: { email }, select: { name: true, phone: true } });
    if (!existingForCheck?.name && !name) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_NAME', message: 'Your name is required' } });
    }
    if (!existingForCheck?.phone && !phone) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_PHONE', message: 'Your mobile number is required' } });
    }
    // User.phone is unique — check up front for a friendly error instead of
    // letting a raw Prisma constraint violation reach the client.
    if (!existingForCheck?.phone && phone) {
      const phoneOwner = await prisma.user.findUnique({ where: { phone }, select: { email: true } });
      if (phoneOwner && phoneOwner.email !== email) {
        return res.status(409).json({ success: false, error: { code: 'PHONE_IN_USE', message: 'This mobile number is already linked to another account.' } });
      }
    }

    const { valid } = await verifyStaffInviteOtp(email, code);
    if (!valid) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or expired verification code' } });
    }

    const permissions = permissionsFromSections(invite.sections);

    const user = await prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email } });

      if (user) {
        // Re-check under the transaction — the account could have joined another
        // shop in the time between the invite being sent and being accepted.
        if (user.shopId && user.shopId !== invite.shopId) {
          throw { status: 409, message: 'This account is already tied to a different shop.' };
        }
        user = await tx.user.update({
          where: { userId: user.userId },
          data: { role: 'SHOP_STAFF', shopId: invite.shopId, emailVerified: true, name: user.name || name, phone: user.phone || phone },
          include: { userType: { select: { id: true, name: true, slug: true } } },
        });
      } else {
        user = await tx.user.create({
          data: {
            email, name, phone: phone || null,
            role: 'SHOP_STAFF', shopId: invite.shopId, emailVerified: true,
          },
          include: { userType: { select: { id: true, name: true, slug: true } } },
        });
      }

      await tx.shopUser.upsert({
        where: { shopId_userId: { shopId: invite.shopId, userId: user.userId } },
        create: {
          shopId: invite.shopId, userId: user.userId, role: 'STAFF', roleLabel: invite.roleLabel,
          sections: invite.sections, permissions, invitedBy: invite.invitedBy, isActive: true,
        },
        update: {
          roleLabel: invite.roleLabel, sections: invite.sections, permissions,
          isActive: true, invitedBy: invite.invitedBy,
        },
      });

      await tx.staffInvite.update({ where: { id: invite.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });

      return user;
    });

    const payload = await createSession(res, user, { isNewUser: !user.lastLoginAt, req });

    writeAudit(req, { entityType: ET.SHOP, entityId: invite.shopId, action: ACT.CREATE, newValue: { staffInviteAccepted: email } });

    // Fire-and-forget welcome email — reuses the exact forgot-password token
    // mechanism so "Set my password" in the email lands on the same
    // /reset-password flow already used everywhere else. Never blocks the
    // response: the invite is fully accepted and the user is logged in
    // (via OTP) regardless of whether this email goes out.
    (async () => {
      try {
        const shop = await prisma.shop.findUnique({ where: { shopId: invite.shopId }, select: { name: true } });
        await prisma.passwordResetToken.updateMany({ where: { userId: user.userId, used: false }, data: { used: true } });
        const rawToken = generateResetToken();
        await prisma.passwordResetToken.create({
          data: { userId: user.userId, tokenHash: hashResetToken(rawToken), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
        });
        await sendStaffWelcomeEmail(email, user.name, shop?.name || 'your shop', rawToken);
      } catch (emailErr) {
        console.error('[staff/accept-invite] welcome email failed:', emailErr);
      }
    })();

    res.json(payload);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: { message: err.message } });
    next(err);
  }
});

// PATCH /api/shop/staff/:id/role — update role label and/or sections
router.patch('/:id/role', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const staffMember = await prisma.shopUser.findFirst({
      where: { id: parseInt(req.params.id, 10), shopId: req.user.shopId },
    });
    if (!staffMember) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff member not found' } });
    }
    if (staffMember.role === 'OWNER') {
      return res.status(400).json({
        success: false,
        error: { code: 'CANNOT_MODIFY_OWNER', message: 'Cannot change the role of the shop owner' },
      });
    }

    const { roleLabel, sections } = req.body;
    const data = {};

    if (sections !== undefined) {
      const sectionsError = validateSections(sections);
      if (sectionsError) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_SECTIONS', message: sectionsError } });
      }
      data.sections = sections;
      data.permissions = permissionsFromSections(sections);
    }
    if (roleLabel !== undefined) {
      if (!roleLabel?.trim()) {
        return res.status(400).json({ success: false, error: { code: 'MISSING_ROLE_LABEL', message: 'Role label cannot be empty' } });
      }
      data.roleLabel = roleLabel.trim();
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHANGES', message: 'No changes provided' } });
    }

    const updated = await prisma.shopUser.update({
      where: { id: parseInt(req.params.id, 10) },
      data,
      include: { user: { select: { userId: true, name: true, phone: true, email: true } } },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/staff/:id/deactivate — soft-remove (keeps audit trail)
router.patch('/:id/deactivate', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const staffMember = await prisma.shopUser.findFirst({
      where: { id: parseInt(req.params.id, 10), shopId: req.user.shopId },
    });
    if (!staffMember) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff member not found' } });
    }
    if (staffMember.role === 'OWNER') {
      return res.status(400).json({
        success: false,
        error: { code: 'CANNOT_REMOVE_OWNER', message: 'Cannot deactivate the shop owner' },
      });
    }

    const updated = await prisma.shopUser.update({
      where: { id: parseInt(req.params.id, 10) },
      data: { isActive: false },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/staff/:id/reactivate
router.patch('/:id/reactivate', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const staffMember = await prisma.shopUser.findFirst({
      where: { id: parseInt(req.params.id, 10), shopId: req.user.shopId },
    });
    if (!staffMember) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff member not found' } });
    }

    const updated = await prisma.shopUser.update({
      where: { id: parseInt(req.params.id, 10) },
      data: { isActive: true },
      include: { user: { select: { userId: true, name: true, phone: true, email: true } } },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shop/staff/:id — hard delete (for compliance / GDPR)
router.delete('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const staffMember = await prisma.shopUser.findFirst({
      where: { id: parseInt(req.params.id, 10), shopId: req.user.shopId },
    });
    if (!staffMember) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff member not found' } });
    }
    if (staffMember.role === 'OWNER') {
      return res.status(400).json({
        success: false,
        error: { code: 'CANNOT_DELETE_OWNER', message: 'Cannot delete the shop owner from staff' },
      });
    }

    await prisma.shopUser.delete({ where: { id: parseInt(req.params.id, 10) } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
