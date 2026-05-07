/**
 * staff.js — Layer 2 Shop Staff Management Routes
 *
 * Mounted at: /api/shop/staff
 *
 * Routes:
 *   GET    /api/shop/staff                 — list all staff for current shop
 *   POST   /api/shop/staff/invite          — add staff member by phone (user must exist)
 *   PATCH  /api/shop/staff/:id/role        — change role / permissions
 *   PATCH  /api/shop/staff/:id/deactivate  — soft-remove staff access
 *   PATCH  /api/shop/staff/:id/reactivate  — re-enable staff access
 *   DELETE /api/shop/staff/:id             — hard-remove staff member
 *
 * Permission model (stored in permissions JSONB):
 *   { billing, inventory, reports, parties, workshop, staff }
 *   Each key is a boolean. OWNER gets all true by default.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Default permissions matrix per role
const ROLE_DEFAULT_PERMISSIONS = {
  OWNER:    { billing: true,  inventory: true,  reports: true,  parties: true,  workshop: true,  staff: true  },
  MANAGER:  { billing: true,  inventory: true,  reports: true,  parties: true,  workshop: true,  staff: false },
  CASHIER:  { billing: true,  inventory: false, reports: false, parties: false, workshop: false, staff: false },
  MECHANIC: { billing: false, inventory: false, reports: false, parties: false, workshop: true,  staff: false },
  DELIVERY: { billing: false, inventory: false, reports: false, parties: false, workshop: false, staff: false },
};

const VALID_ROLES = Object.keys(ROLE_DEFAULT_PERMISSIONS);

// Guard: user must be a SHOP_OWNER (or SHOP_STAFF with staff permission in future)
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

// POST /api/shop/staff/invite — invite a user by phone number
router.post('/invite', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { phone, role, permissions } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PHONE', message: 'Phone number is required' },
      });
    }

    const staffRole = role && VALID_ROLES.includes(role) ? role : 'CASHIER';
    if (staffRole === 'OWNER') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ROLE', message: 'Cannot invite another OWNER. Use role MANAGER or below.' },
      });
    }

    // Find the user by phone
    const invitee = await prisma.user.findUnique({ where: { phone } });
    if (!invitee) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'No account found with this phone number. Ask them to sign up first.' },
      });
    }

    // Prevent inviting yourself
    if (invitee.userId === req.user.userId) {
      return res.status(400).json({
        success: false,
        error: { code: 'SELF_INVITE', message: 'You cannot invite yourself' },
      });
    }

    // Check if already a staff member
    const existing = await prisma.shopUser.findUnique({
      where: { shopId_userId: { shopId: req.user.shopId, userId: invitee.userId } },
    });
    if (existing) {
      if (existing.isActive) {
        return res.status(409).json({
          success: false,
          error: { code: 'ALREADY_STAFF', message: 'This user is already a staff member' },
        });
      }
      // Reactivate if previously deactivated
      const reactivated = await prisma.shopUser.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          role: staffRole,
          permissions: permissions || ROLE_DEFAULT_PERMISSIONS[staffRole],
          invitedBy: req.user.userId,
        },
        include: { user: { select: { userId: true, name: true, phone: true, email: true } } },
      });
      return res.json({ success: true, data: reactivated, message: 'Staff member reactivated' });
    }

    const staffMember = await prisma.shopUser.create({
      data: {
        shopId: req.user.shopId,
        userId: invitee.userId,
        role: staffRole,
        permissions: permissions || ROLE_DEFAULT_PERMISSIONS[staffRole],
        invitedBy: req.user.userId,
      },
      include: { user: { select: { userId: true, name: true, phone: true, email: true } } },
    });

    res.status(201).json({ success: true, data: staffMember });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/staff/:id/role — update role and/or permissions
router.patch('/:id/role', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const staffMember = await prisma.shopUser.findFirst({
      where: { id: req.params.id, shopId: req.user.shopId },
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

    const { role, permissions } = req.body;
    const data = {};

    if (role) {
      if (!VALID_ROLES.includes(role) || role === 'OWNER') {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_ROLE', message: `Role must be one of: ${VALID_ROLES.filter(r => r !== 'OWNER').join(', ')}` },
        });
      }
      data.role = role;
      // Reset to role defaults unless explicit permissions provided
      data.permissions = permissions || ROLE_DEFAULT_PERMISSIONS[role];
    } else if (permissions) {
      data.permissions = permissions;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: { code: 'NO_CHANGES', message: 'No changes provided' } });
    }

    const updated = await prisma.shopUser.update({
      where: { id: req.params.id },
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
      where: { id: req.params.id, shopId: req.user.shopId },
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
      where: { id: req.params.id },
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
      where: { id: req.params.id, shopId: req.user.shopId },
    });
    if (!staffMember) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Staff member not found' } });
    }

    const updated = await prisma.shopUser.update({
      where: { id: req.params.id },
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
      where: { id: req.params.id, shopId: req.user.shopId },
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

    await prisma.shopUser.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
