import { Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { formatUserResponse } from './auth/helpers.js';
import { sendShopOwnerApprovedEmail, sendShopOwnerRejectedEmail } from '../services/email.js';

const router = Router();

// GET /api/admin/stats
router.get('/stats', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const [totalUsers, totalShops, activeUsers, shopOwners, customers, admins] = await Promise.all([
      prisma.user.count(),
      prisma.shop.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: 'SHOP_OWNER' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.user.count({ where: { role: 'PLATFORM_ADMIN' } }),
    ]);
    res.json({ success: true, data: { totalUsers, totalShops, activeUsers, shopOwners, customers, admins } });
  } catch (err) { next(err); }
});

// GET /api/admin/users
router.get('/users', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { q, role, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (role && role !== 'ALL') where.role = role;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          userId: true, name: true, email: true, phone: true,
          role: true, isActive: true, shopId: true,
          createdAt: true, lastLoginAt: true, loginCount: true,
          shop: { select: { name: true, city: true } },
          userType: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ success: true, data: users, total });
  } catch (err) { next(err); }
});

// POST /api/admin/impersonate/:userId
router.post('/impersonate/:userId', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    // Prevent admins from impersonating other admins
    if (userId === req.user.userId) {
      return res.status(400).json({ success: false, error: { code: 'SELF_IMPERSONATION', message: 'Cannot impersonate yourself' } });
    }

    const target = await prisma.user.findUnique({
      where: { userId },
      include: { shop: true },
    });

    if (!target) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    }
    if (!target.isActive) {
      return res.status(400).json({ success: false, error: { code: 'USER_INACTIVE', message: 'Cannot impersonate inactive user' } });
    }
    if (target.role === 'PLATFORM_ADMIN') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot impersonate another admin' } });
    }

    // Short-lived access token with impersonation claim (no refresh token)
    const accessToken = jwt.sign(
      { userId: target.userId, shopId: target.shopId || null, role: target.role, impersonatedBy: req.user.userId },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      success: true,
      data: { accessToken, user: formatUserResponse(target), impersonatedBy: { userId: req.user.userId, name: req.user.name } },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/verifications — pending shop owner verifications
router.get('/verifications', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const pending = await prisma.user.findMany({
      where: { role: 'SHOP_OWNER', verificationStatus: { in: ['PENDING', 'REJECTED'] } },
      select: {
        userId: true, name: true, email: true, phone: true, avatarUrl: true,
        verificationStatus: true, verificationNote: true, verifiedAt: true,
        createdAt: true, isActive: true,
        userType: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: pending });
  } catch (err) { next(err); }
});

// POST /api/admin/users/create — admin creates a user directly
router.post('/users/create', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!email || !password || !role) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'name, email, password and role are required' } });
    }
    const allowedRoles = ['PLATFORM_ADMIN', 'SHOP_OWNER', 'CUSTOMER'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ROLE', message: `role must be one of: ${allowedRoles.join(', ')}` } });
    }

    // Check email not already taken
    const existing = await prisma.user.findFirst({ where: { email: { equals: email.trim().toLowerCase(), mode: 'insensitive' } } });
    if (existing) return res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists' } });

    // Find the matching UserType
    const userType = await prisma.userType.findUnique({ where: { slug: role } });

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.default.hash(password, 12);

    const newUser = await prisma.user.create({
      data: {
        name: name?.trim() || null,
        email: email.trim().toLowerCase(),
        passwordHash,
        role,
        userTypeId: userType?.id || null,
        emailVerified: true, // admin-created accounts are pre-verified
        isVerified: true,
        isActive: true,
        // Shop owners created by admin are pre-approved
        verificationStatus: role === 'SHOP_OWNER' ? 'APPROVED' : 'NOT_REQUIRED',
      },
      include: { userType: true },
    });

    // Link email auth provider
    await prisma.authProvider.create({ data: { userId: newUser.userId, provider: 'EMAIL', providerId: newUser.email } });

    res.status(201).json({ success: true, data: { userId: newUser.userId, name: newUser.name, email: newUser.email, role: newUser.role, userType: newUser.userType } });
  } catch (err) { next(err); }
});

// POST /api/admin/users/:userId/verify — approve or reject a shop owner
router.post('/users/:userId/verify', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    const { action, reason } = req.body; // action: 'APPROVE' | 'REJECT'
    if (!['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: 'action must be APPROVE or REJECT' } });
    }
    if (action === 'REJECT' && !reason?.trim()) {
      return res.status(400).json({ success: false, error: { code: 'REASON_REQUIRED', message: 'A rejection reason is required' } });
    }

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (user.role !== 'SHOP_OWNER') return res.status(400).json({ success: false, error: { code: 'NOT_SHOP_OWNER', message: 'Only shop owner accounts can be verified' } });

    const updateData = {
      verificationStatus: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      verificationNote: action === 'REJECT' ? reason.trim() : null,
      verifiedAt: new Date(),
      verifiedBy: String(req.user.userId), // verifiedBy is String? in schema
      isActive: action === 'APPROVE' ? true : user.isActive,
    };

    const updated = await prisma.user.update({
      where: { userId },
      data: updateData,
    });

    // Send email notification
    if (action === 'APPROVE') {
      sendShopOwnerApprovedEmail(updated).catch(e => console.error('[EMAIL] Approval email failed:', e));
    } else {
      sendShopOwnerRejectedEmail(updated, reason).catch(e => console.error('[EMAIL] Rejection email failed:', e));
    }

    res.json({ success: true, data: { userId: updated.userId, verificationStatus: updated.verificationStatus } });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:userId/toggle-active
router.patch('/users/:userId/toggle-active', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    if (user.role === 'PLATFORM_ADMIN') return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot deactivate an admin' } });

    const updated = await prisma.user.update({
      where: { userId },
      data: { isActive: !user.isActive },
      select: { userId: true, isActive: true, name: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// GET /api/admin/usertypes — list all user types
router.get('/usertypes', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const types = await prisma.userType.findMany({ orderBy: { id: 'asc' } });
    res.json({ success: true, data: types });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:userId/usertype — change a user's type (syncs role cache)
router.patch('/users/:userId/usertype', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid userId' } });

    const userTypeId = parseInt(req.body.userTypeId);
    if (!userTypeId || isNaN(userTypeId)) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELD', message: 'userTypeId (integer) is required' } });
    }

    const userType = await prisma.userType.findUnique({ where: { id: userTypeId } });
    if (!userType) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'UserType not found' } });
    }

    const targetUser = await prisma.user.findUnique({ where: { userId } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }
    if (targetUser.userId === req.user.userId) {
      return res.status(400).json({ success: false, error: { code: 'SELF_MODIFY', message: 'Cannot change your own user type' } });
    }

    const updated = await prisma.user.update({
      where: { userId },
      data: { userTypeId, role: userType.slug },  // sync role cache
      include: { userType: true },
    });

    res.json({
      success: true,
      data: {
        userId: updated.userId,
        name: updated.name,
        role: updated.role,
        userType: { id: updated.userType.id, name: updated.userType.name, slug: updated.userType.slug },
      },
    });
  } catch (err) { next(err); }
});

export default router;
