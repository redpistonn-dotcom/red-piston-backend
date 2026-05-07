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
      include: { shop: true, userType: true },
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
  if (slug === 'SHOP_OWNER' && !req.user.shopId) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No shop associated with this account' },
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

// Generic role gate: authorize(['SHOP_OWNER', 'PLATFORM_ADMIN'])
// Must be used after authenticate()
export const authorize = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: `Access restricted to: ${roles.join(', ')}` },
    });
  }
  next();
};
