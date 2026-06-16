import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
  const slug = req.user.userType?.slug || req.user.role;
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

export const requireAdmin = (req, res, next) => {
  const slug = req.user.userType?.slug || req.user.role;
  if (slug !== 'PLATFORM_ADMIN') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Admin access required' },
    });
  }
  next();
};

