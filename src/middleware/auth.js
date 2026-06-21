import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';
import { hasPermission } from '../lib/permissions.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: { code: 'NO_TOKEN', message: 'No token provided' },
      });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await prisma.user.findUnique({
      where: { userId: decoded.userId },
      // Drop the full `shop` JOIN (no handler reads req.user.shop — confirmed) and
      // trim userType to the columns the role gate needs. Default User scalars
      // (name/phone/email/avatarUrl/firebaseUid, which handlers DO use) are still
      // returned. One fewer JOIN + less data on every authenticated request.
      include: { userType: { select: { id: true, name: true, slug: true } } },
    });
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: { code: 'USER_INACTIVE', message: 'User not found or inactive' },
      });
    }
    req.user = user;
    req.impersonatedBy = decoded.impersonatedBy || null;
    req.shopId = user.shopId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
      });
    }
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid token' },
    });
  }
};

export const requireShopOwner = (req, res, next) => {
  const slug = (req.user.userType?.slug || req.user.role || '').toUpperCase();
  if (!['SHOP_OWNER', 'PLATFORM_ADMIN'].includes(slug)) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Shop owner access required' },
    });
  }
  // Both SHOP_OWNER and PLATFORM_ADMIN need a non-null shopId to query shop-scoped data.
  // Passing null to Prisma on a non-nullable Int field throws PrismaClientValidationError (500).
  if (!req.shopId) {
    return res.status(403).json({
      success: false,
      error: { code: 'NO_SHOP', message: 'No shop associated with this account' },
    });
  }
  next();
};

export const requireAdmin = async (req, res, next) => {
  const slug = (req.user.userType?.slug || req.user.role || '').toUpperCase();
  const isAdmin = slug === 'PLATFORM_ADMIN' || slug === 'ADMIN';
  if (isAdmin) {
    try {
      const ap = await prisma.adminProfile.findUnique({ where: { userId: req.user.userId }, select: { ipWhitelist: true } });
      if (ap && ap.ipWhitelist && ap.ipWhitelist.length > 0) {
        const clientIp = req.ip || "";
        if (!ap.ipWhitelist.includes(clientIp)) {
          return res.status(403).json({ success: false, error: { code: "IP_RESTRICTED", message: "Access denied from this IP address" } });
        }
      }
    } catch { /* non-fatal */ }
  }
  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Admin access required' },
    });
  }
  next();
};

export function requirePermission(permission) {
  return async (req, res, next) => {
    const slug = (req.user.userType?.slug || req.user.role || "").toUpperCase();
    if (slug === "PLATFORM_ADMIN" || slug === "ADMIN") return next();
    try {
      const shopUser = await prisma.shopUser.findUnique({
        where: { shopId_userId: { shopId: req.shopId, userId: req.user.userId } },
        select: { role: true, permissions: true, isActive: true },
      });
      if (!shopUser || !shopUser.isActive) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Staff account not active" } });
      }
      if (!hasPermission(shopUser.role, shopUser.permissions, permission)) {
        return res.status(403).json({ success: false, error: { code: "PERMISSION_DENIED", message: "Permission required: " + permission } });
      }
      req.shopUserRole = shopUser.role;
      next();
    } catch (err) { next(err); }
  };
}

