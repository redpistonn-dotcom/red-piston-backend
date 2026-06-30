/**
 * Fitment Routes — Vehicle ↔ Product Compatibility System
 *
 * GET    /api/fitments                    — list fitments (filter by partId or vehicleId)
 * POST   /api/fitments                    — add a fitment mapping
 * PUT    /api/fitments/:fitmentId          — update fitment (fitType, confidence, notes)
 * DELETE /api/fitments/:fitmentId          — remove a fitment
 * POST   /api/fitments/bulk               — bulk import fitments (array)
 * GET    /api/fitments/validate           — check if a part fits a vehicle
 *
 * Confirm Fit (user-initiated shop verification):
 * POST   /api/fitments/confirm-request    — user requests shop to verify compatibility
 * GET    /api/fitments/confirm-requests   — shop/admin lists pending requests
 * PUT    /api/fitments/confirm-requests/:id — shop resolves (confirm / reject)
 */

import express from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_FIT_TYPES   = ['EXACT', 'COMPATIBLE', 'UNIVERSAL'];
const VALID_CONFIDENCE  = ['verified', 'shop_confirmed', 'unverified'];
const VALID_SOURCES     = ['SHOP_CONFIRMED', 'USER_REPORTED', 'OEM', 'SYSTEM'];

function fitmentResponse(f) {
  return {
    fitmentId:    f.fitmentId,
    masterPartId: f.masterPartId,
    vehicleId:    f.vehicleId,
    fitType:      f.fitType,
    confidence:   f.confidence,
    source:       f.source,
    position:     f.position,
    notes:        f.notes,
    createdAt:    f.createdAt,
    updatedAt:    f.updatedAt,
    part: f.masterPart ? {
      partName: f.masterPart.partName,
      brand:    f.masterPart.brand,
      category: f.masterPart.categoryL1,
    } : undefined,
    vehicle: f.vehicle ? {
      make:      f.vehicle.make,
      model:     f.vehicle.model,
      variant:   f.vehicle.variant,
      yearFrom:  f.vehicle.yearFrom,
      yearTo:    f.vehicle.yearTo,
      fuelType:  f.vehicle.fuelType,
    } : undefined,
  };
}

// ─── GET /api/fitments/vehicles/makes — distinct makes for autocomplete ───────
router.get('/vehicles/makes', async (req, res, next) => {
  try {
    const makes = await prisma.vehicle.findMany({
      select:   { make: true },
      distinct: ['make'],
      orderBy:  { make: 'asc' },
      take:     500,
    });
    res.json({ success: true, makes: makes.map(m => m.make) });
  } catch (err) { next(err); }
});

// ─── GET /api/fitments/vehicles/search?make=&q= — vehicle lookup ─────────────
router.get('/vehicles/search', async (req, res, next) => {
  try {
    const { make, q, limit = 30 } = req.query;
    const where = {};
    if (make) where.make = { equals: make, mode: 'insensitive' };
    if (q)    where.OR   = [
      { make:  { contains: q, mode: 'insensitive' } },
      { model: { contains: q, mode: 'insensitive' } },
    ];
    const vehicles = await prisma.vehicle.findMany({
      where,
      select: { vehicleId: true, make: true, model: true, yearFrom: true, yearTo: true, fuelType: true },
      orderBy: [{ make: 'asc' }, { model: 'asc' }],
      take: parseInt(limit),
    });
    res.json({ success: true, vehicles });
  } catch (err) { next(err); }
});

// ─── GET /api/fitments ────────────────────────────────────────────────────────
// Query: ?masterPartId=X  OR  ?vehicleId=Y  OR  ?make=&model=&year=
router.get('/', async (req, res, next) => {
  try {
    const { masterPartId, vehicleId, make, model, year, confidence, fitType, limit = 50, offset = 0 } = req.query;

    const where = {};

    if (masterPartId) where.masterPartId = masterPartId;
    if (vehicleId)    where.vehicleId    = vehicleId;
    if (confidence)   where.confidence   = confidence;
    if (fitType)      where.fitType      = fitType;

    // Resolve vehicle from make/model/year if provided
    if (make && model) {
      const vWhere = { make, model };
      if (year) {
        const y = parseInt(year);
        vWhere.yearFrom = { lte: y };
        vWhere.OR = [{ yearTo: null }, { yearTo: { gte: y } }];
      }
      const vehicles = await prisma.vehicle.findMany({ where: vWhere, select: { vehicleId: true } });
      const ids = vehicles.map(v => v.vehicleId);
      if (!ids.length) return res.json({ success: true, fitments: [], total: 0 });
      where.vehicleId = { in: ids };
    }

    const [fitments, total] = await Promise.all([
      prisma.partFitment.findMany({
        where,
        include: { masterPart: { select: { partName: true, brand: true, categoryL1: true } }, vehicle: true },
        orderBy: { createdAt: 'desc' },
        take:  parseInt(limit),
        skip:  parseInt(offset),
      }),
      prisma.partFitment.count({ where }),
    ]);

    res.json({ success: true, fitments: fitments.map(fitmentResponse), total });
  } catch (err) { next(err); }
});

// ─── POST /api/fitments ───────────────────────────────────────────────────────
// Add a single fitment (shop owner or admin)
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { masterPartId, vehicleId, fitType, confidence, position, notes, source } = req.body;

    if (!masterPartId || !vehicleId || !fitType) {
      return res.status(400).json({ success: false, error: { message: 'masterPartId, vehicleId, fitType are required' } });
    }
    if (!VALID_FIT_TYPES.includes(fitType)) {
      return res.status(400).json({ success: false, error: { message: `fitType must be one of: ${VALID_FIT_TYPES.join(', ')}` } });
    }
    if (confidence && !VALID_CONFIDENCE.includes(confidence)) {
      return res.status(400).json({ success: false, error: { message: `confidence must be one of: ${VALID_CONFIDENCE.join(', ')}` } });
    }

    // Verify part and vehicle exist
    const [part, vehicle] = await Promise.all([
      prisma.masterPart.findUnique({ where: { masterPartId } }),
      prisma.vehicle.findUnique({ where: { vehicleId } }),
    ]);
    if (!part)    return res.status(404).json({ success: false, error: { message: 'Part not found' } });
    if (!vehicle) return res.status(404).json({ success: false, error: { message: 'Vehicle not found' } });

    const fitment = await prisma.partFitment.upsert({
      where:  { masterPartId_vehicleId: { masterPartId, vehicleId } },
      create: {
        masterPartId,
        vehicleId,
        fitType,
        confidence:  confidence || 'shop_confirmed',
        source:      source || 'SHOP_CONFIRMED',
        position:    position || null,
        notes:       notes || null,
      },
      update: {
        fitType,
        confidence:  confidence || 'shop_confirmed',
        source:      source || 'SHOP_CONFIRMED',
        position:    position || null,
        notes:       notes || null,
      },
      include: { masterPart: { select: { partName: true, brand: true, categoryL1: true } }, vehicle: true },
    });

    res.status(201).json({ success: true, fitment: fitmentResponse(fitment) });
  } catch (err) { next(err); }
});

// ─── PUT /api/fitments/:fitmentId ─────────────────────────────────────────────
router.put('/:fitmentId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { fitmentId } = req.params;
    const { fitType, confidence, position, notes, source } = req.body;

    const existing = await prisma.partFitment.findUnique({ where: { fitmentId } });
    if (!existing) return res.status(404).json({ success: false, error: { message: 'Fitment not found' } });

    if (fitType && !VALID_FIT_TYPES.includes(fitType)) {
      return res.status(400).json({ success: false, error: { message: `fitType must be one of: ${VALID_FIT_TYPES.join(', ')}` } });
    }
    if (confidence && !VALID_CONFIDENCE.includes(confidence)) {
      return res.status(400).json({ success: false, error: { message: `confidence must be one of: ${VALID_CONFIDENCE.join(', ')}` } });
    }

    const updated = await prisma.partFitment.update({
      where: { fitmentId },
      data: {
        ...(fitType    && { fitType }),
        ...(confidence && { confidence }),
        ...(position !== undefined && { position }),
        ...(notes    !== undefined && { notes }),
        ...(source   && { source }),
      },
      include: { masterPart: { select: { partName: true, brand: true, categoryL1: true } }, vehicle: true },
    });

    res.json({ success: true, fitment: fitmentResponse(updated) });
  } catch (err) { next(err); }
});

// ─── DELETE /api/fitments/:fitmentId ─────────────────────────────────────────
router.delete('/:fitmentId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { fitmentId } = req.params;
    const existing = await prisma.partFitment.findUnique({ where: { fitmentId } });
    if (!existing) return res.status(404).json({ success: false, error: { message: 'Fitment not found' } });

    await prisma.partFitment.delete({ where: { fitmentId } });
    res.json({ success: true, message: 'Fitment removed' });
  } catch (err) { next(err); }
});

// ─── POST /api/fitments/bulk ─────────────────────────────────────────────────
// Bulk import: [{ masterPartId, vehicleId, fitType, confidence, notes }]
router.post('/bulk', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { fitments } = req.body;
    if (!Array.isArray(fitments) || !fitments.length) {
      return res.status(400).json({ success: false, error: { message: 'fitments array is required' } });
    }
    if (fitments.length > 500) {
      return res.status(400).json({ success: false, error: { message: 'Max 500 fitments per bulk import' } });
    }

    const results = { created: 0, updated: 0, errors: [] };

    for (const [i, f] of fitments.entries()) {
      const { masterPartId, vehicleId, fitType, confidence, notes, position, source } = f;
      if (!masterPartId || !vehicleId || !fitType) {
        results.errors.push({ index: i, error: 'masterPartId, vehicleId, fitType required' });
        continue;
      }
      if (!VALID_FIT_TYPES.includes(fitType)) {
        results.errors.push({ index: i, error: `Invalid fitType: ${fitType}` });
        continue;
      }
      try {
        const result = await prisma.partFitment.upsert({
          where:  { masterPartId_vehicleId: { masterPartId, vehicleId } },
          create: { masterPartId, vehicleId, fitType, confidence: confidence || 'shop_confirmed', source: source || 'SHOP_CONFIRMED', notes, position },
          update: { fitType, confidence: confidence || 'shop_confirmed', source: source || 'SHOP_CONFIRMED', notes, position },
        });
        // Detect if created or updated based on timestamps
        const isNew = result.createdAt.getTime() === result.updatedAt.getTime();
        if (isNew) results.created++; else results.updated++;
      } catch (e) {
        results.errors.push({ index: i, masterPartId, vehicleId, error: e.message });
      }
    }

    res.json({ success: true, results });
  } catch (err) { next(err); }
});

// ─── GET /api/fitments/validate ──────────────────────────────────────────────
// Check if a part fits a specific vehicle
// Query: ?masterPartId=X&vehicleId=Y  OR  ?masterPartId=X&make=&model=&year=
router.get('/validate', async (req, res, next) => {
  try {
    const { masterPartId, vehicleId, make, model, year, fuelType } = req.query;

    if (!masterPartId) {
      return res.status(400).json({ success: false, error: { message: 'masterPartId is required' } });
    }

    const part = await prisma.masterPart.findUnique({
      where:  { masterPartId },
      select: { partName: true, brand: true, isUniversal: true, requiresFitment: true },
    });
    if (!part) return res.status(404).json({ success: false, error: { message: 'Part not found' } });

    // Universal parts fit everything
    if (part.isUniversal) {
      return res.json({ success: true, compatible: true, fitType: 'UNIVERSAL', confidence: 'verified', part });
    }

    // Parts that don't require fitment check
    if (!part.requiresFitment) {
      return res.json({ success: true, compatible: true, fitType: 'UNIVERSAL', confidence: 'verified', part });
    }

    if (!vehicleId && !(make && model)) {
      return res.status(400).json({ success: false, error: { message: 'vehicleId or (make + model) required' } });
    }

    // Resolve vehicle
    let resolvedVehicleId = vehicleId;
    if (!resolvedVehicleId && make && model) {
      const vWhere = { make, model };
      if (year) {
        const y = parseInt(year);
        vWhere.yearFrom = { lte: y };
        vWhere.OR = [{ yearTo: null }, { yearTo: { gte: y } }];
      }
      if (fuelType) vWhere.fuelType = fuelType;
      const vehicle = await prisma.vehicle.findFirst({ where: vWhere });
      if (!vehicle) {
        return res.json({ success: true, compatible: false, fitType: null, confidence: null, reason: 'Vehicle not found in database' });
      }
      resolvedVehicleId = vehicle.vehicleId;
    }

    const fitment = await prisma.partFitment.findUnique({
      where:   { masterPartId_vehicleId: { masterPartId, vehicleId: resolvedVehicleId } },
      include: { vehicle: true },
    });

    if (!fitment) {
      return res.json({
        success:    true,
        compatible: false,
        fitType:    null,
        confidence: null,
        reason:     'No fitment record found — use Confirm Fit to request shop verification',
      });
    }

    res.json({
      success:    true,
      compatible: true,
      fitType:    fitment.fitType,
      confidence: fitment.confidence,
      position:   fitment.position,
      notes:      fitment.notes,
      vehicle:    fitment.vehicle,
      part,
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM FIT — User requests shop to verify compatibility
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/fitments/confirm-request
router.post('/confirm-request', authenticate, async (req, res, next) => {
  try {
    const { masterPartId, shopId, vehicleId, make, model, variant, year, fuelType, regNo, userNote } = req.body;

    if (!masterPartId || !shopId || !make || !model || !year) {
      return res.status(400).json({
        success: false,
        error: { message: 'masterPartId, shopId, make, model, year are required' },
      });
    }

    const [part, shop] = await Promise.all([
      prisma.masterPart.findUnique({ where: { masterPartId }, select: { partName: true } }),
      prisma.shop.findUnique({ where: { shopId }, select: { name: true } }),
    ]);
    if (!part) return res.status(404).json({ success: false, error: { message: 'Part not found' } });
    if (!shop) return res.status(404).json({ success: false, error: { message: 'Shop not found' } });

    // Check if fitment already exists
    let resolvedVehicleId = vehicleId || null;
    if (!resolvedVehicleId) {
      const y = parseInt(year);
      const vehicle = await prisma.vehicle.findFirst({
        where: {
          make, model,
          yearFrom: { lte: y },
          OR: [{ yearTo: null }, { yearTo: { gte: y } }],
          ...(fuelType && { fuelType }),
        },
      });
      resolvedVehicleId = vehicle?.vehicleId || null;
    }

    if (resolvedVehicleId) {
      const existing = await prisma.partFitment.findUnique({
        where: { masterPartId_vehicleId: { masterPartId, vehicleId: resolvedVehicleId } },
      });
      if (existing) {
        return res.json({
          success: true,
          alreadyVerified: true,
          fitment: { fitType: existing.fitType, confidence: existing.confidence, notes: existing.notes },
          message: 'This part already has a verified fitment for your vehicle',
        });
      }
    }

    const request = await prisma.confirmFitRequest.create({
      data: {
        userId:      req.user.userId,
        masterPartId,
        shopId,
        vehicleId:   resolvedVehicleId,
        make,
        model,
        variant:     variant || null,
        year:        parseInt(year),
        fuelType:    fuelType || null,
        regNo:       regNo || null,
        userNote:    userNote || null,
        status:      'PENDING',
      },
    });

    res.status(201).json({
      success: true,
      request: {
        id:          request.id,
        status:      request.status,
        part:        part.partName,
        shop:        shop.name,
        vehicle:     `${make} ${model} ${year}`,
        createdAt:   request.createdAt,
      },
      message: 'Request sent to shop — they will verify and respond shortly',
    });
  } catch (err) { next(err); }
});

// GET /api/fitments/confirm-requests — shop sees pending requests
router.get('/confirm-requests', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status = 'PENDING', limit = 20, offset = 0 } = req.query;

    const where = {};
    // Shop owners only see their shop's requests
    if (req.user.role !== 'PLATFORM_ADMIN') {
      if (!req.user.shopId) return res.status(403).json({ success: false, error: { message: 'No shop associated' } });
      where.shopId = req.user.shopId;
    }
    if (status !== 'ALL') where.status = status;

    const [requests, total] = await Promise.all([
      prisma.confirmFitRequest.findMany({
        where,
        include: {
          user:      { select: { name: true, phone: true } },
          masterPart:{ select: { partName: true, brand: true, categoryL1: true, imageUrl: true } },
          shop:      { select: { name: true } },
          vehicle:   true,
        },
        orderBy: { createdAt: 'desc' },
        take:  parseInt(limit),
        skip:  parseInt(offset),
      }),
      prisma.confirmFitRequest.count({ where }),
    ]);

    res.json({ success: true, requests, total });
  } catch (err) { next(err); }
});

// PUT /api/fitments/confirm-requests/:id — shop resolves: CONFIRMED or REJECTED
router.put('/confirm-requests/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, shopNote, fitType, confidence, notes: fitNotes } = req.body;

    if (!['CONFIRMED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'status must be CONFIRMED or REJECTED' } });
    }

    const request = await prisma.confirmFitRequest.findUnique({
      where: { id },
      include: { vehicle: true },
    });
    if (!request) return res.status(404).json({ success: false, error: { message: 'Request not found' } });

    // Shop owners can only resolve their own shop's requests
    if (req.user.role !== 'PLATFORM_ADMIN' && request.shopId !== req.user.shopId) {
      return res.status(403).json({ success: false, error: { message: 'Access denied' } });
    }

    let savedFitmentId = null;

    // If confirmed — auto-save to PartFitment table
    if (status === 'CONFIRMED') {
      if (!fitType || !VALID_FIT_TYPES.includes(fitType)) {
        return res.status(400).json({ success: false, error: { message: `fitType required when confirming. Must be: ${VALID_FIT_TYPES.join(', ')}` } });
      }

      let vehicleId = request.vehicleId;

      // If no vehicleId, try to resolve or create vehicle
      if (!vehicleId) {
        const y = request.year;
        const existing = await prisma.vehicle.findFirst({
          where: {
            make: request.make, model: request.model,
            yearFrom: { lte: y },
            OR: [{ yearTo: null }, { yearTo: { gte: y } }],
            ...(request.fuelType && { fuelType: request.fuelType }),
          },
        });
        if (existing) {
          vehicleId = existing.vehicleId;
        } else {
          // Create a new vehicle record from the confirm fit data
          const newVehicle = await prisma.vehicle.create({
            data: {
              make:      request.make,
              model:     request.model,
              variant:   request.variant || null,
              yearFrom:  y,
              yearTo:    y,
              fuelType:  request.fuelType || null,
            },
          });
          vehicleId = newVehicle.vehicleId;
        }
      }

      const fitment = await prisma.partFitment.upsert({
        where:  { masterPartId_vehicleId: { masterPartId: request.masterPartId, vehicleId } },
        create: {
          masterPartId: request.masterPartId,
          vehicleId,
          fitType,
          confidence:  confidence || 'shop_confirmed',
          source:      'SHOP_CONFIRMED',
          notes:       fitNotes || shopNote || null,
        },
        update: {
          fitType,
          confidence:  confidence || 'shop_confirmed',
          source:      'SHOP_CONFIRMED',
          notes:       fitNotes || shopNote || null,
        },
      });
      savedFitmentId = fitment.fitmentId;
    }

    const updated = await prisma.confirmFitRequest.update({
      where: { id },
      data: {
        status,
        shopNote:       shopNote || null,
        resolvedAt:     new Date(),
        resolvedBy:     req.user.userId,
        savedToFitments: status === 'CONFIRMED',
        ...(savedFitmentId && { fitmentId: savedFitmentId }),
      },
    });

    res.json({
      success: true,
      request: updated,
      message: status === 'CONFIRMED'
        ? 'Compatibility confirmed and saved to fitment database'
        : 'Request rejected and user notified',
    });
  } catch (err) { next(err); }
});

export default router;
