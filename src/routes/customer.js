/**
 * customer.js — Layer 2 Customer Profile Routes
 *
 * Mounted at: /api/customer
 *
 * Routes:
 *   GET    /api/customer/profile           — get wallet, loyalty points
 *   GET    /api/customer/addresses         — list saved addresses
 *   POST   /api/customer/addresses         — add a new address
 *   PUT    /api/customer/addresses/:id     — update an address
 *   DELETE /api/customer/addresses/:id     — delete an address
 *   PATCH  /api/customer/addresses/:id/default — set as default
 *   GET    /api/customer/garage            — list saved vehicles
 *   POST   /api/customer/garage            — add a vehicle to garage
 *   PUT    /api/customer/garage/:id        — update a garage vehicle
 *   DELETE /api/customer/garage/:id        — remove from garage
 *   PATCH  /api/customer/garage/:id/default — set as default vehicle
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ─── Guard: customer-only endpoints ──────────────────────────────────────────
function requireCustomer(req, res, next) {
  if (req.user.role !== 'CUSTOMER') {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'This endpoint is for customers only' },
    });
  }
  next();
}

// Ensure CustomerProfile exists for this user (upsert on first access)
async function ensureCustomerProfile(userId) {
  return prisma.customerProfile.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

// ─── Profile ─────────────────────────────────────────────────────────────────

const VALID_PROFILE_TYPES = ['INDIVIDUAL', 'MECHANIC', 'FLEET_MANAGER'];

// GET /api/customer/profile
router.get('/profile', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const [profile, orderStats] = await Promise.all([
      ensureCustomerProfile(req.user.userId),
      prisma.marketplaceOrder.aggregate({
        where: { customerId: req.user.userId, paymentStatus: 'PAID' },
        _count: { orderId: true },
        _sum:   { total: true },
      }),
    ]);
    res.json({
      success: true,
      data: {
        ...profile,
        totalOrders: orderStats._count.orderId || 0,
        totalSpent:  Number(orderStats._sum.total || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/customer/profile — update profileType
router.patch('/profile', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const { profileType } = req.body;
    if (!profileType || !VALID_PROFILE_TYPES.includes(profileType)) {
      return res.status(400).json({
        success: false,
        error: { message: `profileType must be one of: ${VALID_PROFILE_TYPES.join(', ')}` },
      });
    }
    const profile = await prisma.customerProfile.upsert({
      where:  { userId: req.user.userId },
      update: { profileType },
      create: { userId: req.user.userId, profileType },
    });
    res.json({ success: true, data: profile });
  } catch (err) { next(err); }
});

// ─── Addresses ───────────────────────────────────────────────────────────────

// GET /api/customer/addresses
router.get('/addresses', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const addresses = await prisma.customerAddress.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, data: addresses });
  } catch (err) {
    next(err);
  }
});

// POST /api/customer/addresses
router.post('/addresses', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const { label, fullName, phone, line1, line2, landmark, city, state, pincode, latitude, longitude, isDefault } = req.body;

    if (!fullName || !phone || !line1 || !city || !state || !pincode) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'fullName, phone, line1, city, state, pincode are required' },
      });
    }

    const addressData = {
      userId: req.user.userId,
      label: label || 'Home',
      fullName,
      phone,
      line1,
      line2: line2 || null,
      landmark: landmark || null,
      city,
      state,
      pincode,
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      isDefault: isDefault || false,
    };

    let address;
    if (isDefault) {
      address = await prisma.$transaction(async (tx) => {
        await tx.customerAddress.updateMany({
          where: { userId: req.user.userId },
          data: { isDefault: false },
        });
        return tx.customerAddress.create({ data: addressData });
      });
    } else {
      address = await prisma.customerAddress.create({ data: addressData });
    }

    res.status(201).json({ success: true, data: address });
  } catch (err) {
    next(err);
  }
});

// PUT /api/customer/addresses/:id
router.put('/addresses/:id', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const existing = await prisma.customerAddress.findFirst({
      where: { addressId: req.params.id, userId: req.user.userId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }

    const { label, fullName, phone, line1, line2, landmark, city, state, pincode, latitude, longitude } = req.body;
    const data = {};
    if (label !== undefined) data.label = label;
    if (fullName !== undefined) data.fullName = fullName;
    if (phone !== undefined) data.phone = phone;
    if (line1 !== undefined) data.line1 = line1;
    if (line2 !== undefined) data.line2 = line2;
    if (landmark !== undefined) data.landmark = landmark;
    if (city !== undefined) data.city = city;
    if (state !== undefined) data.state = state;
    if (pincode !== undefined) data.pincode = pincode;
    if (latitude !== undefined) data.latitude = latitude ? parseFloat(latitude) : null;
    if (longitude !== undefined) data.longitude = longitude ? parseFloat(longitude) : null;

    const updated = await prisma.customerAddress.update({
      where: { addressId: req.params.id },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/customer/addresses/:id/default
router.patch('/addresses/:id/default', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const existing = await prisma.customerAddress.findFirst({
      where: { addressId: req.params.id, userId: req.user.userId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }

    await prisma.$transaction([
      prisma.customerAddress.updateMany({
        where: { userId: req.user.userId },
        data: { isDefault: false },
      }),
      prisma.customerAddress.update({
        where: { addressId: req.params.id },
        data: { isDefault: true },
      }),
    ]);

    const addresses = await prisma.customerAddress.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, data: addresses });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customer/addresses/:id
router.delete('/addresses/:id', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const existing = await prisma.customerAddress.findFirst({
      where: { addressId: req.params.id, userId: req.user.userId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }
    await prisma.customerAddress.delete({ where: { addressId: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Garage (saved vehicles) ──────────────────────────────────────────────────

// GET /api/customer/garage
router.get('/garage', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const vehicles = await prisma.customerVehicle.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, data: vehicles });
  } catch (err) {
    next(err);
  }
});

// POST /api/customer/garage
router.post('/garage', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const { vehicleId, nickname, make, model, variant, year, fuelType, registrationNo, purchaseYear, isDefault } = req.body;

    if (!make || !model || !year) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'make, model, year are required' },
      });
    }

    const vehicleData = {
      userId:         req.user.userId,
      vehicleId:      vehicleId      || null,
      nickname:       nickname       || null,
      make,
      model,
      variant:        variant        || null,
      year:           parseInt(year),
      fuelType:       fuelType       || null,
      registrationNo: registrationNo || null,
      purchaseYear:   purchaseYear   ? parseInt(purchaseYear) : null,
      isDefault:      isDefault      || false,
    };

    let vehicle;
    if (isDefault) {
      vehicle = await prisma.$transaction(async (tx) => {
        await tx.customerVehicle.updateMany({
          where: { userId: req.user.userId },
          data:  { isDefault: false },
        });
        return tx.customerVehicle.create({ data: vehicleData });
      });
    } else {
      vehicle = await prisma.customerVehicle.create({ data: vehicleData });
    }

    res.status(201).json({ success: true, data: vehicle });
  } catch (err) { next(err); }
});

// PUT /api/customer/garage/:id
router.put('/garage/:id', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const existing = await prisma.customerVehicle.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Vehicle not found in garage' } });
    }

    const { nickname, make, model, variant, year, fuelType, registrationNo, purchaseYear } = req.body;
    const data = {};
    if (nickname       !== undefined) data.nickname       = nickname;
    if (make           !== undefined) data.make           = make;
    if (model          !== undefined) data.model          = model;
    if (variant        !== undefined) data.variant        = variant;
    if (year           !== undefined) data.year           = parseInt(year);
    if (fuelType       !== undefined) data.fuelType       = fuelType;
    if (registrationNo !== undefined) data.registrationNo = registrationNo;
    if (purchaseYear   !== undefined) data.purchaseYear   = purchaseYear ? parseInt(purchaseYear) : null;

    const updated = await prisma.customerVehicle.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/customer/garage/:id/default
router.patch('/garage/:id/default', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const existing = await prisma.customerVehicle.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Vehicle not found in garage' } });
    }

    await prisma.$transaction([
      prisma.customerVehicle.updateMany({
        where: { userId: req.user.userId },
        data: { isDefault: false },
      }),
      prisma.customerVehicle.update({
        where: { id: req.params.id },
        data: { isDefault: true },
      }),
    ]);

    const vehicles = await prisma.customerVehicle.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, data: vehicles });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customer/garage/:id
router.delete('/garage/:id', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const existing = await prisma.customerVehicle.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Vehicle not found in garage' } });
    }
    await prisma.customerVehicle.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Orders ───────────────────────────────────────────────────────────────────

// GET /api/customer/orders — customer's marketplace order history
router.get('/orders', authenticate, requireCustomer, async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const where = { customerId: req.user.userId };
    if (status) where.status = status;

    const [orders, total] = await Promise.all([
      prisma.marketplaceOrder.findMany({
        where,
        include: {
          items: {
            include: {
              inventory: {
                include: { masterPart: { select: { partName: true, brand: true, imageUrl: true } } },
              },
            },
          },
          shop: { select: { name: true, city: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.marketplaceOrder.count({ where }),
    ]);

    res.json({ success: true, data: { orders, total } });
  } catch (err) { next(err); }
});

export default router;
