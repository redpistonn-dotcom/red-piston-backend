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
         OR  LOWER(oem_number) = LOWER(${barcode})
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
            { oemNumber:  { equals: term, mode: 'insensitive' } },
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
            { oemNumber: { contains: term, mode: 'insensitive' } },
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
            { oemNumber: { equals: bc, mode: 'insensitive' } },
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
        { oemNumber: { contains: term, mode: 'insensitive' } },
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
        where: { oemNumber: { contains: oem, mode: 'insensitive' } },
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
// Once VERIFIED it becomes available to all shops via the lookup endpoints.
router.post('/contribute', authenticate, async (req, res, next) => {
  try {
    const {
      partName, brand, categoryL1, categoryL2,
      hsnCode, gstRate, unitOfSale, description,
      oemNumber,
      oemNumbers, barcodes, images, specifications,
    } = req.body;

    if (!partName || !partName.trim()) {
      return res.status(400).json({ error: 'Part name is required' });
    }

    // Deduplicate OEM numbers
    const allOems = Array.isArray(oemNumbers) ? oemNumbers : [];
    if (oemNumber && !allOems.includes(oemNumber)) allOems.unshift(oemNumber);
    const cleanOems    = [...new Set(allOems.filter(Boolean))];
    const cleanBarcodes = Array.isArray(barcodes) ? [...new Set(barcodes.filter(Boolean))] : [];
    const cleanImages   = Array.isArray(images)   ? images.filter(Boolean) : [];

    // Create MasterPart using base fields (always supported)
    const part = await prisma.masterPart.create({
      data: {
        partName:    partName.trim(),
        brand:       brand?.trim()    || null,
        categoryL1:  categoryL1       || null,
        categoryL2:  categoryL2       || null,
        hsnCode:     hsnCode          || null,
        gstRate:     gstRate ? parseFloat(gstRate) : 18.00,
        unitOfSale:  unitOfSale       || 'Piece',
        description: description      || null,
        imageUrl:    cleanImages[0]   || null,
        oemNumber:   cleanOems[0]     || null,
        status:      'PENDING',
        source:      'CONTRIBUTED',
      },
    });

    // Update the new array columns via raw SQL (works before Prisma client is regenerated)
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
        // Non-fatal: part is created, array fields just won't be populated yet
        console.warn('[Catalog] Could not set array fields:', rawErr.message);
      }
    }

    res.json({ success: true, part });
  } catch (err) {
    next(err);
  }
});

export default router;
