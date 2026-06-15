/**
 * catalog.js — Layer 1 + Layer 2 of the three-layer auto-parts architecture.
 *
 * Layer 1: master_parts — The global "encyclopedia" of every part that exists.
 *          Platform-owned, never per-shop, always normalised.
 * Layer 2: Lookup engine — Fast barcode / OEM-number resolution so a cashier or
 *          stockroom worker never has to TYPE a part name. They scan → the catalog
 *          fills in every field automatically.
 *
 * IMPORTANT: The array columns (oem_numbers, barcodes, images) were added via raw SQL
 * and may not be in the Prisma client type definitions yet.
 * We use $queryRaw for those column lookups to ensure forward/backward compatibility.
 *
 * Public endpoints (no auth required):
 *   GET  /api/catalog/lookup?q=           Unified fast lookup (name / OEM / barcode)
 *   GET  /api/catalog/search?q=&vehicle_id=   Full-text search with optional fitment
 *   GET  /api/catalog/parts/:id            Single part detail
 *   GET  /api/catalog/oem/:oemNumber       OEM number lookup
 *   GET  /api/catalog/barcode/:barcode     Barcode / EAN lookup
 *   GET  /api/catalog/vehicles             All vehicles grouped by make
 *   GET  /api/catalog/vehicles/:make/models
 *
 * Authenticated:
 *   POST /api/catalog/contribute           Shop owner contributes a new part (PENDING)
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Standard fitment include — returns up to 10 vehicles per part.
 * Used in all endpoints that need fitment data.
 */
const fitmentInclude = {
  fitments: {
    include: { vehicle: true },
    take: 10,
  },
};

/**
 * Search the `oem_numbers` and `barcodes` TEXT[] columns using raw SQL.
 * This works even before `prisma generate` is re-run after schema changes.
 * Returns an array of master_part_id strings that match.
 */
async function arrayLookupIds(term) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT master_part_id
      FROM   master_parts
      WHERE  oem_numbers @> ARRAY[${term}]::TEXT[]
         OR  barcodes    @> ARRAY[${term}]::TEXT[]
    `;
    return rows.map(r => r.master_part_id);
  } catch {
    // Array columns don't exist yet (first deploy) — graceful no-op
    return [];
  }
}

/**
 * Barcode-exact lookup using raw SQL on the barcodes[] and oemNumbers[] columns.
 * Also checks the legacy single oemNumber column.
 */
async function barcodeArrayLookupIds(barcode) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT master_part_id
      FROM   master_parts
      WHERE  barcodes    @> ARRAY[${barcode}]::TEXT[]
         OR  oem_numbers @> ARRAY[${barcode}]::TEXT[]
         OR  LOWER(primary_oem_number) = LOWER(${barcode})
    `;
    return rows.map(r => r.master_part_id);
  } catch {
    return [];
  }
}

// ─── POST /api/catalog/lookup ─────────────────────────────────────────────────
// Body: { barcode: "...", q: "..." }
// Spec-compliant barcode scan endpoint — called by the camera scanner component.
// Returns: { parts, found, exactMatch }
router.post('/lookup', async (req, res, next) => {
  try {
    const { barcode, q } = req.body;
    const term = (barcode || q || '').trim();

    if (!term || term.length < 2) {
      return res.status(400).json({ error: 'barcode or q must be at least 2 characters' });
    }

    // Exact barcode/OEM lookup first (GIN index → sub-5 ms)
    const [arrayIds, textParts] = await Promise.all([
      barcodeArrayLookupIds(term),
      prisma.masterPart.findMany({
        where: {
          OR: [
            { primaryOemNumber: { equals: term, mode: 'insensitive' } },
            { partName:   { contains: term, mode: 'insensitive' } },
            { brand:      { contains: term, mode: 'insensitive' } },
          ],
        },
        include: fitmentInclude,
        take: 10,
      }),
    ]);

    let arrayParts = [];
    if (arrayIds.length > 0) {
      arrayParts = await prisma.masterPart.findMany({
        where: { masterPartId: { in: arrayIds } },
        include: fitmentInclude,
      });
    }

    const seen = new Set(arrayParts.map(p => p.masterPartId));
    const parts = [
      ...arrayParts,
      ...textParts.filter(p => !seen.has(p.masterPartId)),
    ];

    if (parts.length === 0) {
      return res.status(404).json({
        found: false,
        allow_contribution: true,
        message: 'Part not found',
        scannedBarcode: term,
      });
    }

    res.json({
      parts,
      found: true,
      exactMatch: arrayParts.length === 1 ? arrayParts[0] : null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/lookup ───────────────────────────────────────────────────
// Unified fast lookup used by CatalogStockInModal (cashier / stock-in flow).
// Searches name, brand, OEM number AND barcodes in one network round-trip.
// VERIFIED parts surface first; no vehicle filter required.
router.get('/lookup', async (req, res, next) => {
  try {
    const { q } = req.query;
    // Clamp limit: default 12, max 50, guard against NaN
    const limitRaw = parseInt(req.query.limit);
    const limit = isNaN(limitRaw) ? 12 : Math.min(Math.max(limitRaw, 1), 50);

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const term = q.trim();

    // Parallel: text search + array-column search
    const [textParts, arrayIds] = await Promise.all([
      prisma.masterPart.findMany({
        where: {
          OR: [
            { partName:  { contains: term, mode: 'insensitive' } },
            { brand:     { contains: term, mode: 'insensitive' } },
            { primaryOemNumber: { contains: term, mode: 'insensitive' } },
          ],
        },
        include: fitmentInclude,
        orderBy: [{ status: 'asc' }, { partName: 'asc' }],
        take: limit,
      }),
      arrayLookupIds(term),
    ]);

    // Fetch parts found via array lookup that aren't already in textParts
    const existingIds = new Set(textParts.map(p => p.masterPartId));
    const newIds = arrayIds.filter(id => !existingIds.has(id));

    let arrayParts = [];
    if (newIds.length > 0) {
      arrayParts = await prisma.masterPart.findMany({
        where: { masterPartId: { in: newIds } },
        include: fitmentInclude,
      });
    }

    const parts = [...textParts, ...arrayParts].slice(0, limit);
    res.json({ parts, total: parts.length });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/barcode/:barcode ────────────────────────────────────────
// Exact barcode scan lookup — cashier scans the box, gets the part in < 100 ms.
router.get('/barcode/:barcode', async (req, res, next) => {
  try {
    const { barcode } = req.params;
    if (!barcode || barcode.trim().length < 4) {
      return res.status(400).json({ error: 'Barcode too short' });
    }

    const bc = barcode.trim();

    // Array lookup first (most accurate), then text fallback on oemNumber
    const [arrayIds, textParts] = await Promise.all([
      barcodeArrayLookupIds(bc),
      prisma.masterPart.findMany({
        where: {
          OR: [
            { primaryOemNumber: { equals: bc, mode: 'insensitive' } },
            { partName:  { contains: bc, mode: 'insensitive' } },
          ],
        },
        include: fitmentInclude,
        take: 5,
      }),
    ]);

    let arrayParts = [];
    if (arrayIds.length > 0) {
      arrayParts = await prisma.masterPart.findMany({
        where: { masterPartId: { in: arrayIds } },
        include: fitmentInclude,
      });
    }

    const seen = new Set(arrayParts.map(p => p.masterPartId));
    const parts = [
      ...arrayParts,
      ...textParts.filter(p => !seen.has(p.masterPartId)),
    ];

    res.json({
      parts,
      found: parts.length > 0,
      exactMatch: parts.length === 1 ? parts[0] : null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/search ──────────────────────────────────────────────────
// Full-text search with optional vehicle fitment filter.
router.get('/search', async (req, res, next) => {
  try {
    const { q, vehicle_id, category } = req.query;
    // Sanitise pagination params — guard against NaN from bad query strings
    const limitRaw  = parseInt(req.query.limit);
    const offsetRaw = parseInt(req.query.offset);
    const limit  = isNaN(limitRaw)  ? 20  : Math.min(Math.max(limitRaw,  1), 100);
    const offset = isNaN(offsetRaw) ? 0   : Math.max(offsetRaw, 0);

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const term = q.trim();

    const textWhere = {
      OR: [
        { partName:  { contains: term, mode: 'insensitive' } },
        { brand:     { contains: term, mode: 'insensitive' } },
        { primaryOemNumber: { contains: term, mode: 'insensitive' } },
      ],
      ...(category && category !== 'All' ? { categoryL1: category } : {}),
    };

    let parts;
    if (vehicle_id) {
      parts = await prisma.masterPart.findMany({
        where: {
          ...textWhere,
          fitments: { some: { vehicleId: vehicle_id } },
        },
        include: {
          fitments: {
            where: { vehicleId: vehicle_id },
            include: { vehicle: true },
          },
        },
        take: limit,
        skip: offset,
      });
    } else {
      parts = await prisma.masterPart.findMany({
        where: textWhere,
        include: fitmentInclude,
        take: limit,
        skip: offset,
      });
    }

    res.json({ parts, total: parts.length });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/parts/:masterPartId ─────────────────────────────────────
router.get('/parts/:masterPartId', async (req, res, next) => {
  try {
    const part = await prisma.masterPart.findUnique({
      where: { masterPartId: req.params.masterPartId },
      include: { fitments: { include: { vehicle: true } } },
    });
    if (!part) return res.status(404).json({ error: 'Part not found' });
    res.json(part);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/oem/:oemNumber ──────────────────────────────────────────
router.get('/oem/:oemNumber', async (req, res, next) => {
  try {
    const oem = req.params.oemNumber.trim();
    const [textParts, arrayIds] = await Promise.all([
      prisma.masterPart.findMany({
        where: { primaryOemNumber: { contains: oem, mode: 'insensitive' } },
        include: { fitments: { include: { vehicle: true } } },
      }),
      arrayLookupIds(oem),
    ]);

    let arrayParts = [];
    if (arrayIds.length > 0) {
      const seen = new Set(textParts.map(p => p.masterPartId));
      const newIds = arrayIds.filter(id => !seen.has(id));
      if (newIds.length > 0) {
        arrayParts = await prisma.masterPart.findMany({
          where: { masterPartId: { in: newIds } },
          include: { fitments: { include: { vehicle: true } } },
        });
      }
    }

    res.json({ parts: [...textParts, ...arrayParts] });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/vehicles ────────────────────────────────────────────────
router.get('/vehicles', async (req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      orderBy: [{ make: 'asc' }, { model: 'asc' }, { yearFrom: 'desc' }],
    });
    const grouped = vehicles.reduce((acc, v) => {
      if (!acc[v.make]) acc[v.make] = [];
      acc[v.make].push(v);
      return acc;
    }, {});
    res.json({ vehicles, grouped });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/catalog/vehicles/:make/models ───────────────────────────────────
router.get('/vehicles/:make/models', async (req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { make: { equals: req.params.make, mode: 'insensitive' } },
      orderBy: [{ model: 'asc' }, { yearFrom: 'desc' }],
    });
    const models = [...new Set(vehicles.map(v => v.model))];
    res.json({ models, vehicles });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/catalog/contribute ─────────────────────────────────────────────
// A shop owner contributes a new part that isn't in the catalog.
// Status starts as PENDING — platform admin reviews and can VERIFY or REJECT.
router.post('/contribute', authenticate, async (req, res, next) => {
  try {
    const {
      partName, brand, categoryL1, categoryL2, categoryL3,
      hsnCode, gstRate, unitOfSale, weightGrams, description,
      primaryOemNumber, oemNumber,
      oemNumbers, barcodes, images, specifications,
      partType,
      fitments, // [{ make, model, yearFrom?, yearTo?, fitType? }]
    } = req.body;

    if (!partName || !partName.trim()) {
      return res.status(400).json({ error: 'Part name is required' });
    }

    // Prevent duplicate inventory entries: if this shop already has a part with
    // the same name, return 409 so the frontend can show a friendly message.
    const shopId = req.user?.shopId || null;
    if (shopId) {
      const dupCheck = await prisma.shopInventory.findFirst({
        where: {
          shopId,
          masterPart: { partName: { equals: partName.trim(), mode: 'insensitive' } },
        },
        select: { inventoryId: true },
      });
      if (dupCheck) {
        return res.status(409).json({ error: 'A part with this name is already in your inventory', inventoryId: dupCheck.inventoryId });
      }
    }

    const VALID_PART_TYPES = ['OEM', 'OES'];
    const resolvedPartType = VALID_PART_TYPES.includes((partType || '').toUpperCase())
      ? (partType || '').toUpperCase()
      : 'OEM';

    const allOems = Array.isArray(oemNumbers) ? oemNumbers : [];
    const primaryOem = primaryOemNumber || oemNumber || null;
    if (primaryOem && !allOems.includes(primaryOem)) allOems.unshift(primaryOem);
    const cleanOems     = [...new Set(allOems.filter(Boolean))];
    const cleanBarcodes = Array.isArray(barcodes) ? [...new Set(barcodes.filter(Boolean))] : [];
    const cleanImages   = Array.isArray(images)   ? images.filter(Boolean) : [];

    const shopId = req.user?.shopId || null;

    const part = await prisma.masterPart.create({
      data: {
        partName:            partName.trim(),
        brand:               brand?.trim()    || null,
        categoryL1:          categoryL1       || null,
        categoryL2:          categoryL2       || null,
        categoryL3:          categoryL3       || null,
        primaryOemNumber:    primaryOem,
        hsnCode:             hsnCode          || null,
        gstRate:             gstRate ? parseFloat(gstRate) : 18.00,
        unitOfSale:          unitOfSale       || 'Piece',
        weightGrams:         weightGrams      ? parseInt(weightGrams) : null,
        description:         description      || null,
        imageUrl:            cleanImages[0]   || null,
        partType:            resolvedPartType,
        status:              'PENDING',   // admin must approve before it goes live
        source:              'CONTRIBUTED',
        contributedByShopId: shopId,
      },
    });

    if (cleanOems.length > 0 || cleanBarcodes.length > 0 || cleanImages.length > 0 || specifications) {
      try {
        const specsJson = specifications ? JSON.stringify(specifications) : null;
        await prisma.$executeRaw`
          UPDATE master_parts
          SET oem_numbers    = ${cleanOems}::TEXT[],
              barcodes       = ${cleanBarcodes}::TEXT[],
              images         = ${cleanImages}::TEXT[],
              specifications = ${specsJson}::JSONB,
              updated_at     = NOW()
          WHERE master_part_id = ${part.masterPartId}
        `;
      } catch (rawErr) {
        console.warn('[Catalog] Could not set array fields:', rawErr.message);
      }
    }

    // Save fitments if provided: each entry is { make, model, yearFrom?, yearTo?, fitType? }
    const fitmentResults = [];
    if (Array.isArray(fitments) && fitments.length > 0) {
      for (const f of fitments) {
        const make  = String(f.make  || '').trim();
        const model = String(f.model || '').trim();
        if (!make || !model) continue;
        try {
          // Find or create the Vehicle row
          let vehicle = await prisma.vehicle.findFirst({
            where: { make: { equals: make, mode: 'insensitive' }, model: { equals: model, mode: 'insensitive' } },
          });
          if (!vehicle) {
            vehicle = await prisma.vehicle.create({
              data: {
                make,
                model,
                yearFrom: f.yearFrom ? parseInt(f.yearFrom) : 2000,
                yearTo:   f.yearTo   ? parseInt(f.yearTo)   : null,
                fuelType: f.fuelType || null,
              },
            });
          }
          // Upsert fitment (unique on masterPartId + vehicleId)
          const fitment = await prisma.partFitment.upsert({
            where:  { masterPartId_vehicleId: { masterPartId: part.masterPartId, vehicleId: vehicle.vehicleId } },
            create: {
              masterPartId: part.masterPartId,
              vehicleId:    vehicle.vehicleId,
              fitType:      f.fitType || 'COMPATIBLE',
              confidence:   'shop_confirmed',
              source:       'SHOP_CONFIRMED',
            },
            update: { fitType: f.fitType || 'COMPATIBLE', confidence: 'shop_confirmed' },
          });
          fitmentResults.push({ vehicleId: vehicle.vehicleId, make, model, fitmentId: fitment.fitmentId });
        } catch (fitErr) {
          console.error('[catalog/contribute] fitment save failed:', fitErr?.message);
        }
      }
    }

    res.json({ success: true, part, fitments: fitmentResults });
  } catch (err) { next(err); }
});

// ─── GET /api/catalog/parts — list (admin uses status filter) ─────────────────
router.get('/parts', authenticate, async (req, res, next) => {
  try {
    const { status, category, q, limit = 30, offset = 0 } = req.query;
    const where = {};

    // Non-admins can only see VERIFIED parts
    const isAdmin = req.user.role === 'PLATFORM_ADMIN';
    if (!isAdmin) {
      where.status = 'VERIFIED';
    } else if (status) {
      where.status = status;
    }

    if (category) where.categoryL1 = { equals: category, mode: 'insensitive' };
    if (q && q.trim().length >= 2) {
      where.OR = [
        { partName: { contains: q.trim(), mode: 'insensitive' } },
        { brand:    { contains: q.trim(), mode: 'insensitive' } },
      ];
    }

    const [parts, total] = await Promise.all([
      prisma.masterPart.findMany({
        where,
        include: fitmentInclude,
        orderBy: [{ status: 'asc' }, { partName: 'asc' }],
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.masterPart.count({ where }),
    ]);

    res.json({ success: true, parts, total });
  } catch (err) { next(err); }
});

// ─── PUT /api/catalog/parts/:id — admin update / approve / reject ─────────────
router.put('/parts/:masterPartId', authenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'PLATFORM_ADMIN';
    const isShopOwner = ['SHOP_OWNER', 'SHOP_STAFF'].includes(req.user.role);

    const part = await prisma.masterPart.findUnique({ where: { masterPartId: req.params.masterPartId } });
    if (!part) return res.status(404).json({ error: 'Part not found' });

    // Shop owners can only update parts they contributed
    if (isShopOwner && part.contributedByShopId !== req.user.shopId) {
      return res.status(403).json({ error: 'You can only edit parts you contributed' });
    }

    const {
      partName, brand, categoryL1, categoryL2, categoryL3,
      hsnCode, gstRate, unitOfSale, weightGrams, description,
      primaryOemNumber, imageUrl, isUniversal, requiresFitment,
      partType,
      status, // admin only
    } = req.body;

    const data = {};
    if (partName           !== undefined) data.partName          = partName.trim();
    if (brand              !== undefined) data.brand             = brand || null;
    if (categoryL1         !== undefined) data.categoryL1        = categoryL1 || null;
    if (categoryL2         !== undefined) data.categoryL2        = categoryL2 || null;
    if (categoryL3         !== undefined) data.categoryL3        = categoryL3 || null;
    if (hsnCode            !== undefined) data.hsnCode           = hsnCode || null;
    if (gstRate            !== undefined) data.gstRate           = parseFloat(gstRate);
    if (unitOfSale         !== undefined) data.unitOfSale        = unitOfSale;
    if (weightGrams        !== undefined) data.weightGrams       = weightGrams ? parseInt(weightGrams) : null;
    if (description        !== undefined) data.description       = description || null;
    if (primaryOemNumber   !== undefined) data.primaryOemNumber  = primaryOemNumber || null;
    if (imageUrl           !== undefined) data.imageUrl          = imageUrl || null;
    if (isUniversal        !== undefined) data.isUniversal       = Boolean(isUniversal);
    if (requiresFitment    !== undefined) data.requiresFitment   = Boolean(requiresFitment);
    if (partType           !== undefined) {
      const VALID_PART_TYPES = ['OEM', 'OES'];
      const pt = (partType || '').toUpperCase();
      if (VALID_PART_TYPES.includes(pt)) data.partType = pt;
    }

    // Only admin can change status and set verifiedAt
    if (isAdmin && status !== undefined) {
      const VALID_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      data.status = status;
      if (status === 'VERIFIED') data.verifiedAt = new Date();
    }

    const updated = await prisma.masterPart.update({
      where: { masterPartId: req.params.masterPartId },
      data,
    });

    res.json({ success: true, part: updated });
  } catch (err) { next(err); }
});

// ─── Admin vehicle management ─────────────────────────────────────────────────

// POST /api/catalog/vehicles — admin creates a new vehicle
router.post('/vehicles', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const {
      make, model, variant, yearFrom, yearTo,
      fuelType, engineCc, engineCode, transmission,
      bodyType, vehicleType, absEquipped,
    } = req.body;

    if (!make || !model || !yearFrom) {
      return res.status(400).json({ error: 'make, model, yearFrom are required' });
    }

    const vehicle = await prisma.vehicle.create({
      data: {
        make,
        model,
        variant:      variant      || null,
        yearFrom:     parseInt(yearFrom),
        yearTo:       yearTo       ? parseInt(yearTo)    : null,
        fuelType:     fuelType     || null,
        engineCc:     engineCc     ? parseInt(engineCc)  : null,
        engineCode:   engineCode   || null,
        transmission: transmission || null,
        bodyType:     bodyType     || null,
        vehicleType:  vehicleType  || 'Car',
        absEquipped:  absEquipped  ? Boolean(absEquipped) : false,
      },
    });

    res.status(201).json({ success: true, vehicle });
  } catch (err) { next(err); }
});

// PUT /api/catalog/vehicles/:id — admin updates vehicle
router.put('/vehicles/:vehicleId', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const vehicle = await prisma.vehicle.findUnique({ where: { vehicleId: req.params.vehicleId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const {
      make, model, variant, yearFrom, yearTo,
      fuelType, engineCc, engineCode, transmission,
      bodyType, vehicleType, absEquipped,
    } = req.body;

    const data = {};
    if (make         !== undefined) data.make         = make;
    if (model        !== undefined) data.model        = model;
    if (variant      !== undefined) data.variant      = variant || null;
    if (yearFrom     !== undefined) data.yearFrom     = parseInt(yearFrom);
    if (yearTo       !== undefined) data.yearTo       = yearTo ? parseInt(yearTo) : null;
    if (fuelType     !== undefined) data.fuelType     = fuelType || null;
    if (engineCc     !== undefined) data.engineCc     = engineCc ? parseInt(engineCc) : null;
    if (engineCode   !== undefined) data.engineCode   = engineCode || null;
    if (transmission !== undefined) data.transmission = transmission || null;
    if (bodyType     !== undefined) data.bodyType     = bodyType || null;
    if (vehicleType  !== undefined) data.vehicleType  = vehicleType;
    if (absEquipped  !== undefined) data.absEquipped  = Boolean(absEquipped);

    const updated = await prisma.vehicle.update({ where: { vehicleId: req.params.vehicleId }, data });
    res.json({ success: true, vehicle: updated });
  } catch (err) { next(err); }
});

// DELETE /api/catalog/vehicles/:id — admin removes vehicle (only if no fitments or customer vehicles)
router.delete('/vehicles/:vehicleId', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const [fitmentCount, customerCount] = await Promise.all([
      prisma.partFitment.count({ where: { vehicleId: req.params.vehicleId } }),
      prisma.customerVehicle.count({ where: { vehicleId: req.params.vehicleId } }),
    ]);

    if (fitmentCount > 0 || customerCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: vehicle has ${fitmentCount} fitment(s) and ${customerCount} customer garage entry(s)`,
      });
    }

    await prisma.vehicle.delete({ where: { vehicleId: req.params.vehicleId } });
    res.json({ success: true, message: 'Vehicle deleted' });
  } catch (err) { next(err); }
});

export default router;
