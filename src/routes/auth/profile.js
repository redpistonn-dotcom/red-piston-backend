import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../../services/password.js';
import { sendPasswordChangedEmail } from '../../services/email.js';
import { findUserByEmailInsensitive, formatUserResponse, normalizeEmail } from './helpers.js';
import { writeAudit, ET, ACT } from '../../lib/audit.js';

const router = Router();

// GET /api/auth/me — get full profile with settings, providers, and role-specific data
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { userId: req.user.userId },
      include: {
        shop: true,
        userType: true,
        profile: true,
        settings: true,
        authProviders: { select: { provider: true, providerId: true, linkedAt: true } },
      },
    });

    const base = {
      ...formatUserResponse(user),
      profile: user.profile,
      settings: user.settings,
      providers: user.authProviders,
    };

    // ── Role-specific enrichment ──────────────────────────────────────────────
    if (user.role === 'CUSTOMER') {
      // Ensure CustomerProfile exists (created on first login)
      const customerProfile = await prisma.customerProfile.upsert({
        where: { userId: user.userId },
        update: {},
        create: { userId: user.userId },
      });
      const addresses = await prisma.customerAddress.findMany({
        where: { userId: user.userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
      const garageVehicles = await prisma.customerVehicle.findMany({
        where: { userId: user.userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
      base.customerProfile = customerProfile;
      base.addresses = addresses;
      base.garageVehicles = garageVehicles;
    }

    if (user.role === 'SHOP_OWNER' && user.shopId) {
      const [shopStaff, inventoryCount, invoiceCount] = await Promise.all([
        prisma.shopUser.findMany({
          where: { shopId: user.shopId },
          include: {
            user: { select: { userId: true, name: true, phone: true, email: true, avatarUrl: true, lastLoginAt: true } },
          },
          orderBy: [{ isActive: 'desc' }, { joinedAt: 'asc' }],
        }),
        prisma.shopInventory.count({ where: { shopId: user.shopId } }),
        prisma.invoice.count({ where: { shopId: user.shopId } }),
      ]);
      base.shopStaff = shopStaff;
      base.shopMetrics = {
        inventoryCount,
        invoiceCount,
        activeStaffCount: shopStaff.filter(s => s.isActive).length,
      };
    }

    if (user.role === 'PLATFORM_ADMIN') {
      const adminProfile = await prisma.adminProfile.findUnique({
        where: { userId: user.userId },
      });
      base.adminProfile = adminProfile;
    }

    res.json({ success: true, data: base });
  } catch (err) {
    next(err);
  }
});

const VALID_PROFILE_TYPES = ['INDIVIDUAL', 'MECHANIC', 'FLEET_MANAGER'];

// PATCH /api/auth/me — update basic user info
router.patch('/me', authenticate, async (req, res, next) => {
  try {
    const { name, email, avatarUrl, profileType } = req.body;
    const updateData = {};

    if (name !== undefined) {
      if (!name.trim() || name.trim().length < 2 || name.trim().length > 100) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_NAME', message: 'Name must be between 2 and 100 characters' },
        });
      }
      updateData.name = name.trim();
    }

    if (email !== undefined) {
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_EMAIL', message: 'Invalid email address' },
        });
      }
      const existing = await findUserByEmailInsensitive(normalizedEmail);
      if (existing && existing.userId !== req.user.userId) {
        return res.status(409).json({
          success: false,
          error: { code: 'EMAIL_EXISTS', message: 'This email is already in use' },
        });
      }
      updateData.email = normalizedEmail;
      updateData.emailVerified = false; // Re-verify on email change
    }

    if (avatarUrl !== undefined) {
      updateData.avatarUrl = avatarUrl;
    }

    // profileType is stored in customer_profiles, not on the user record itself
    const shouldUpsertProfile =
      profileType &&
      VALID_PROFILE_TYPES.includes(profileType) &&
      req.user.role === 'CUSTOMER';

    if (Object.keys(updateData).length === 0 && !shouldUpsertProfile) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_CHANGES', message: 'No fields to update' },
      });
    }

    const [updated] = await Promise.all([
      Object.keys(updateData).length > 0
        ? prisma.user.update({ where: { userId: req.user.userId }, data: updateData, include: { shop: true, userType: true } })
        : prisma.user.findUnique({ where: { userId: req.user.userId }, include: { shop: true, userType: true } }),
      shouldUpsertProfile
        ? prisma.customerProfile.upsert({
            where:  { userId: req.user.userId },
            update: { profileType },
            create: { userId: req.user.userId, profileType },
          })
        : Promise.resolve(),
    ]);

    writeAudit(req, {
      entityType: ET.PROFILE,
      entityId:   req.user.userId,
      action:     ACT.UPDATE,
      oldValue: { name: req.user.name, email: req.user.email },
      newValue: updateData,
    });

    res.json({ success: true, data: formatUserResponse(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register-shop
router.post('/register-shop', authenticate, async (req, res, next) => {
  try {
    const { name, ownerName, gstin, address, city, pincode, latitude, longitude } = req.body;
    if (!name) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_SHOP_NAME', message: 'Shop name is required' },
      });
    }
    if (req.user.shopId) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_HAS_SHOP', message: 'User already has a shop' },
      });
    }

    const shop = await prisma.shop.create({
      data: {
        name,
        ownerName: ownerName || req.user.name,
        // Use the user's phone if available; otherwise generate a unique placeholder so the
        // unique constraint on Shop.phone never collides for email-only accounts.
        phone: req.user.phone || `nophone-${String(req.user.userId).slice(0, 16)}`,
        gstin,
        address,
        city,
        pincode,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      },
    });

    await prisma.user.update({
      where: { userId: req.user.userId },
      data: {
        shopId: shop.shopId,
        role: 'SHOP_OWNER',
        name: ownerName || req.user.name,
      },
    });

    res.json({ success: true, shop });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me/profile — get user profile details
router.get('/me/profile', authenticate, async (req, res, next) => {
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { userId: req.user.userId },
    });
    res.json({ success: true, data: profile });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/me/profile — create or update user profile
router.put('/me/profile', authenticate, async (req, res, next) => {
  try {
    const { gender, dateOfBirth } = req.body;
    const data = {};

    if (gender !== undefined) data.gender = gender;
    if (dateOfBirth !== undefined) data.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;

    const profile = await prisma.userProfile.upsert({
      where: { userId: req.user.userId },
      update: data,
      create: { userId: req.user.userId, ...data },
    });

    res.json({ success: true, data: profile });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me/settings — get user settings
router.get('/me/settings', authenticate, async (req, res, next) => {
  try {
    let settings = await prisma.userSettings.findUnique({
      where: { userId: req.user.userId },
    });
    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId: req.user.userId },
      });
    }
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/me/settings — update user settings
router.put('/me/settings', authenticate, async (req, res, next) => {
  try {
    const { notificationsEnabled, emailNotifications, smsNotifications, darkMode } = req.body;
    const data = {};

    if (notificationsEnabled !== undefined) data.notificationsEnabled = notificationsEnabled;
    if (emailNotifications !== undefined) data.emailNotifications = emailNotifications;
    if (smsNotifications !== undefined) data.smsNotifications = smsNotifications;
    if (darkMode !== undefined) data.darkMode = darkMode;

    const settings = await prisma.userSettings.upsert({
      where: { userId: req.user.userId },
      update: data,
      create: { userId: req.user.userId, ...data },
    });

    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/me/shop — update shop details (for shop owners)
router.patch('/me/shop', authenticate, async (req, res, next) => {
  try {
    if (!req.user.shopId) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_SHOP', message: 'User does not have a shop' },
      });
    }

    const { name, ownerName, gstin, address, city, pincode, shopDescription, logoUrl, photoUrl, shopCategory, whatsappNumber } = req.body;
    const data = {};

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_SHOP_NAME', message: 'Shop name cannot be empty' },
        });
      }
      data.name = name.trim();
    }
    if (ownerName !== undefined) data.ownerName = ownerName?.trim() || null;
    if (gstin !== undefined) data.gstin = gstin?.trim() || null;
    if (address !== undefined) data.address = address;
    if (city !== undefined) data.city = city?.trim() || null;
    if (pincode !== undefined) data.pincode = pincode?.trim() || null;
    if (shopDescription !== undefined) data.shopDescription = shopDescription;
    if (logoUrl !== undefined) data.logoUrl = logoUrl;
    if (photoUrl !== undefined) data.photoUrl = photoUrl;
    if (shopCategory !== undefined) data.shopCategory = shopCategory;
    if (whatsappNumber !== undefined) data.whatsappNumber = whatsappNumber;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_CHANGES', message: 'No fields to update' },
      });
    }

    const shop = await prisma.shop.update({
      where: { shopId: req.user.shopId },
      data,
    });

    writeAudit(req, {
      entityType: ET.SHOP,
      entityId:   req.user.shopId,
      action:     ACT.UPDATE,
      newValue:   data,
    });

    res.json({ success: true, data: shop });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password — change password (authenticated)
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'Current password and new password are required' },
      });
    }

    const user = await prisma.user.findUnique({ where: { userId: req.user.userId } });

    if (!user.passwordHash) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_PASSWORD', message: 'Your account does not use password authentication. Set a password first.' },
      });
    }

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' },
      });
    }

    const { valid: strongEnough, errors } = validatePasswordStrength(newPassword);
    if (!strongEnough) {
      return res.status(400).json({
        success: false,
        error: { code: 'WEAK_PASSWORD', message: errors.join('. ') },
      });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { userId: user.userId },
      data: { passwordHash },
    });

    // Security notification (fire & forget)
    if (user.email) {
      sendPasswordChangedEmail(user.email).catch(() => {});
    }

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout-all — revoke all refresh tokens (logout all devices)
router.post('/logout-all', authenticate, async (req, res, next) => {
  try {
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.userId } });
    res.json({ success: true, message: 'Logged out from all devices' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me/sessions — list all active sessions for current user
router.get('/me/sessions', authenticate, async (req, res, next) => {
  try {
    const sessions = await prisma.refreshToken.findMany({
      where: { userId: req.user.userId, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: sessions });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/me/sessions/:id — revoke a specific session by ID
router.delete('/me/sessions/:id', authenticate, async (req, res, next) => {
  try {
    await prisma.refreshToken.deleteMany({
      where: { id: req.params.id, userId: req.user.userId },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/me — soft-delete account (anonymise PII, revoke all sessions)
router.delete('/me', authenticate, async (req, res, next) => {
  try {
    // Revoke all active sessions first
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.userId } });

    // Soft delete: deactivate and anonymise PII so DB referential integrity is preserved
    await prisma.user.update({
      where: { userId: req.user.userId },
      data: {
        isActive: false,
        email: null,
        phone: null,
        name: 'Deleted User',
        avatarUrl: null,
        passwordHash: null,
      },
    });

    res.clearCookie('refresh_token', { path: '/api/auth' });
    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
