import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// ─── GET /api/marketplace/browse ─────────────────────────────────────────────
// Main catalog listing. Returns ALL marketplace-listed parts when no vehicle is
// set. When a vehicle is specified, applies the fitment filter:
//   SHOW:  is_universal = true  (engine oils, fuses, etc. — always visible)
//   SHOW:  requires_fitment = false AND no vehicle-specific exclusion
//   SHOW:  has a fitment record for the resolved vehicle
//   HIDE:  requires_fitment = true AND no fitment record for this vehicle
//
// Query params:
//   make, model, year, fuel_type  — vehicle context (optional)
//   vehicle_id                    — direct vehicle UUID (optional, overrides make/model/year)
//   category                      — category filter (optional)
//   q                             — search query (optional, min 2 chars)
//   lat, lng                      — user location for distance sort (optional)
//   limit (default 40), offset (default 0)
router.get('/browse', async (req, res, next) => {
  try {
    const {
      make, model, year, fuel_type,
      vehicle_id,
      category,
      q,
      lat, lng,
      limit = 40,
      offset = 0,
    } = req.query;

    // ── Step 1: Resolve vehicle_id from make/model/year if not provided directly ──
    let resolvedVehicleId = vehicle_id || null;
    if (!resolvedVehicleId && make && model && year) {
      const matchedVehicle = await prisma.vehicle.findFirst({
        where: {
          make: { equals: make, mode: 'insensitive' },
          model: { equals: model, mode: 'insensitive' },
          yearFrom: { lte: parseInt(year) },
          OR: [
            { yearTo: null },
            { yearTo: { gte: parseInt(year) } },
          ],
          ...(fuel_type ? { fuelType: { equals: fuel_type, mode: 'insensitive' } } : {}),
        },
        orderBy: { yearFrom: 'desc' }, // most recent matching variant
      });
      resolvedVehicleId = matchedVehicle?.vehicleId || null;
    }

    // ── Step 2: Build master_parts WHERE clause ───────────────────────────────
    const partWhere = {
      // Only show parts that have at least one marketplace-listed inventory item in stock
      inventory: { some: { isMarketplaceListed: true, stockQty: { gt: 0 } } },
    };

    // Category filter
    if (category && category !== 'All') {
      partWhere.categoryL1 = { equals: category, mode: 'insensitive' };
    }

    // Search query
    if (q && q.trim().length >= 2) {
      partWhere.OR = [
        { partName:  { contains: q.trim(), mode: 'insensitive' } },
        { brand:     { contains: q.trim(), mode: 'insensitive' } },
        { oemNumber: { contains: q.trim(), mode: 'insensitive' } },
        { categoryL1:{ contains: q.trim(), mode: 'insensitive' } },
      ];
    }

    // Vehicle fitment filter — only applied when vehicle context is known
    if (resolvedVehicleId) {
      partWhere.AND = [
        {
          OR: [
            { isUniversal: true },                                                     // always show universals
            { requiresFitment: false },                                                // generic parts (nuts, bolts)
            { fitments: { some: { vehicleId: resolvedVehicleId } } },                 // explicit fitment match
          ],
        },
      ];
    }

    // ── Step 3: Fetch matching parts with shop inventory ──────────────────────
    const parts = await prisma.masterPart.findMany({
      where: partWhere,
      include: {
        inventory: {
          where: { isMarketplaceListed: true, stockQty: { gt: 0 } },
          include: { shop: true },
        },
        fitments: resolvedVehicleId
          ? { where: { vehicleId: resolvedVehicleId }, select: { fitType: true } }
          : false,
      },
      orderBy: { partName: 'asc' },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    // ── Step 4: Count total (for pagination) ─────────────────────────────────
    const total = await prisma.masterPart.count({ where: partWhere });

    // ── Step 5: Shape response ─────────────────────────────────────────────────
    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;

    const result = parts.map(part => {
      // Determine fitment type for this vehicle
      let fitmentType = null;
      if (part.isUniversal) {
        fitmentType = 'universal';
      } else if (resolvedVehicleId && part.fitments?.length > 0) {
        // Use the most specific fit type (EXACT > COMPATIBLE > UNIVERSAL)
        const fitTypes = part.fitments.map(f => f.fitType);
        if (fitTypes.includes('EXACT'))      fitmentType = 'exact';
        else if (fitTypes.includes('COMPATIBLE')) fitmentType = 'compatible';
        else fitmentType = 'universal';
      } else if (!resolvedVehicleId) {
        fitmentType = null; // no vehicle context
      }

      // Build shop listings sorted by price (best deal first)
      const shops = part.inventory
        .map(inv => {
          const dist = (userLat && userLng && inv.shop.latitude && inv.shop.longitude)
            ? +getDistanceKm(userLat, userLng, Number(inv.shop.latitude), Number(inv.shop.longitude)).toFixed(1)
            : null;
          return {
            inventoryId:  inv.inventoryId,
            shopId:       inv.shopId,
            shopName:     inv.shop.name,
            shopAddress:  inv.shop.address,
            shopCity:     inv.shop.city,
            isVerified:   inv.shop.isVerified,
            price:        Number(inv.sellingPrice),
            stockQty:     inv.stockQty - inv.reservedQty,
            rackLocation: inv.rackLocation,
            distance:     dist,
          };
        })
        .filter(s => s.stockQty > 0)
        .sort((a, b) => {
          // Sort by distance if available, else price
          if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
          return a.price - b.price;
        });

      if (shops.length === 0) return null; // no in-stock listings

      const bestPrice = Math.min(...shops.map(s => s.price));

      return {
        masterPartId:    part.masterPartId,
        partName:        part.partName,
        brand:           part.brand,
        categoryL1:      part.categoryL1,
        categoryL2:      part.categoryL2,
        imageUrl:        part.imageUrl,
        images:          part.images,
        oemNumber:       part.oemNumber,
        oemNumbers:      part.oemNumbers,
        hsnCode:         part.hsnCode,
        gstRate:         Number(part.gstRate),
        unitOfSale:      part.unitOfSale,
        description:     part.description,
        specifications:  part.specifications,
        isUniversal:     part.isUniversal,
        requiresFitment: part.requiresFitment,
        fitmentType,      // "exact" | "compatible" | "universal" | null
        shops,
        bestPrice,
        shopCount:       shops.length,
      };
    }).filter(Boolean);

    res.json({
      success: true,
      data: {
        parts: result,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        vehicleId:     resolvedVehicleId,
        vehicleApplied: !!resolvedVehicleId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/marketplace/vehicles ───────────────────────────────────────────
// Search vehicles for the fitment selector UI.
// Supports cascading dropdowns: makes → models → variants → years.
// Query params:
//   q             — text search across make+model+variant
//   make          — filter by make (for model dropdown)
//   model         — filter by model (for variant dropdown)
//   vehicle_type  — "Car" | "Motorcycle" | "Commercial" | "Tractor"
//   limit (default 50)
router.get('/vehicles', async (req, res, next) => {
  try {
    const { q, make, model, vehicle_type, limit = 50 } = req.query;

    const where = {};
    if (vehicle_type) where.vehicleType = vehicle_type;
    if (make)  where.make  = { equals: make,  mode: 'insensitive' };
    if (model) where.model = { equals: model, mode: 'insensitive' };
    if (q && q.length >= 2) {
      where.OR = [
        { make:    { contains: q, mode: 'insensitive' } },
        { model:   { contains: q, mode: 'insensitive' } },
        { variant: { contains: q, mode: 'insensitive' } },
      ];
    }

    const vehicles = await prisma.vehicle.findMany({
      where,
      orderBy: [{ make: 'asc' }, { model: 'asc' }, { yearFrom: 'desc' }],
      take: parseInt(limit),
      select: {
        vehicleId: true, make: true, model: true, variant: true,
        yearFrom: true, yearTo: true, fuelType: true,
        engineCc: true, engineCode: true, transmission: true,
        bodyType: true, absEquipped: true, vehicleType: true,
      },
    });

    // For the cascading UI: return distinct makes if no make filter, else models, etc.
    if (!make && !model && !q) {
      const makes = [...new Set(vehicles.map(v => v.make))].sort();
      return res.json({ success: true, data: { makes, vehicles } });
    }

    res.json({ success: true, data: { vehicles } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/marketplace/vehicles/makes ─────────────────────────────────────
// Returns distinct makes for top-level dropdown
router.get('/vehicles/makes', async (req, res, next) => {
  try {
    const { vehicle_type } = req.query;
    const where = vehicle_type ? { vehicleType: vehicle_type } : {};
    const results = await prisma.vehicle.findMany({
      where,
      distinct: ['make'],
      orderBy: { make: 'asc' },
      select: { make: true },
    });
    res.json({ success: true, data: results.map(r => r.make) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/marketplace/vehicles/models ────────────────────────────────────
// Returns distinct models for a given make
router.get('/vehicles/models', async (req, res, next) => {
  try {
    const { make } = req.query;
    if (!make) return res.status(400).json({ success: false, error: { code: 'MISSING_MAKE', message: 'make is required' } });
    const results = await prisma.vehicle.findMany({
      where: { make: { equals: make, mode: 'insensitive' } },
      distinct: ['model'],
      orderBy: { model: 'asc' },
      select: { model: true },
    });
    res.json({ success: true, data: results.map(r => r.model) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/marketplace/vehicles/variants ───────────────────────────────────
// Returns full variant list for a make + model combination
router.get('/vehicles/variants', async (req, res, next) => {
  try {
    const { make, model } = req.query;
    if (!make || !model) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'make and model are required' } });
    }
    const vehicles = await prisma.vehicle.findMany({
      where: {
        make:  { equals: make,  mode: 'insensitive' },
        model: { equals: model, mode: 'insensitive' },
      },
      orderBy: [{ yearFrom: 'desc' }, { variant: 'asc' }],
      select: {
        vehicleId: true, variant: true, yearFrom: true, yearTo: true,
        fuelType: true, engineCode: true, transmission: true, vehicleType: true,
      },
    });
    res.json({ success: true, data: vehicles });
  } catch (err) {
    next(err);
  }
});

// GET /api/marketplace/search?q=&vehicle_id=&lat=&lng=&radius=10
router.get('/search', async (req, res, next) => {
  try {
    const { q, vehicle_id, lat, lng, radius = 10, limit = 20, offset = 0 } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query required' });

    // Find matching master parts
    const partWhere = {
      status: 'VERIFIED',
      OR: [
        { partName: { contains: q, mode: 'insensitive' } },
        { oemNumber: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (vehicle_id) {
      partWhere.fitments = { some: { vehicleId: vehicle_id } };
    }

    const parts = await prisma.masterPart.findMany({
      where: partWhere,
      include: {
        inventory: {
          where: {
            isMarketplaceListed: true,
            stockQty: { gt: 0 },
          },
          include: { shop: true },
        },
        fitments: vehicle_id ? { where: { vehicleId: vehicle_id }, include: { vehicle: true } } : false,
      },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    // Filter by location if provided
    const results = parts.map(part => ({
      ...part,
      shops: part.inventory
        .filter(inv => {
          if (!lat || !lng || !inv.shop.latitude || !inv.shop.longitude) return true;
          const dist = getDistanceKm(parseFloat(lat), parseFloat(lng), Number(inv.shop.latitude), Number(inv.shop.longitude));
          return dist <= parseFloat(radius);
        })
        .map(inv => ({
          inventoryId: inv.inventoryId,
          shopId: inv.shopId,
          shopName: inv.shop.name,
          shopAddress: inv.shop.address,
          price: Number(inv.sellingPrice),
          stockQty: inv.stockQty,
          distance: (lat && lng && inv.shop.latitude)
            ? getDistanceKm(parseFloat(lat), parseFloat(lng), Number(inv.shop.latitude), Number(inv.shop.longitude)).toFixed(1)
            : null,
        }))
        .filter(s => s.stockQty > 0)
        .sort((a, b) => (a.distance || 999) - (b.distance || 999)),
    })).filter(p => p.shops.length > 0);

    res.json({ results, total: results.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/marketplace/orders
router.post('/orders', authenticate, async (req, res, next) => {
  try {
    const { items, customerName, deliveryAddress } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });

    // Validate stock
    for (const item of items) {
      const inv = await prisma.shopInventory.findUnique({ where: { inventoryId: item.inventoryId } });
      if (!inv || inv.stockQty < item.qty) {
        return res.status(400).json({ error: `Insufficient stock for item ${item.inventoryId}` });
      }
    }

    const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
    const orderNumber = `ORD${Date.now()}`;

    // Group items by shop
    const shopGroups = items.reduce((acc, item) => {
      if (!acc[item.shopId]) acc[item.shopId] = [];
      acc[item.shopId].push(item);
      return acc;
    }, {});

    const orders = await Promise.all(
      Object.entries(shopGroups).map(async ([shopId, shopItems]) => {
        const shopSubtotal = shopItems.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
        const order = await prisma.marketplaceOrder.create({
          data: {
            orderNumber: `${orderNumber}-${shopId.slice(0, 6)}`,
            customerId: req.user.userId,
            customerPhone: req.user.phone,
            customerName: customerName || req.user.name,
            shopId,
            subtotal: shopSubtotal,
            total: shopSubtotal,
            deliveryAddress,
            status: 'PENDING',
            items: {
              create: shopItems.map(i => ({
                inventoryId: i.inventoryId,
                partName: i.partName,
                qty: i.qty,
                unitPrice: i.unitPrice,
                total: i.unitPrice * i.qty,
              })),
            },
          },
          include: { items: true },
        });

        // Reserve stock
        for (const item of shopItems) {
          await prisma.shopInventory.update({
            where: { inventoryId: item.inventoryId },
            data: { reservedQty: { increment: item.qty } },
          });
        }

        return order;
      })
    );

    res.json({ success: true, orders, orderNumber });
  } catch (err) {
    next(err);
  }
});

// PUT /api/marketplace/orders/:id/status
router.put('/orders/:id/status', authenticate, async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['CONFIRMED', 'PACKED', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const order = await prisma.marketplaceOrder.findUnique({
      where: { orderId: req.params.id },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Only the shop owner can update the status (or admin)
    if (req.user.role !== 'PLATFORM_ADMIN' && order.shopId !== req.user.shopId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await prisma.marketplaceOrder.update({
      where: { orderId: req.params.id },
      data: { status },
    });

    res.json({ success: true, status });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/marketplace/catalog/:masterPartId ───────────────────────────────
// One-product-page: shows full part details + ALL shops listing it + review summary.
// Amazon-style: one canonical page for "Bosch Front Brake Pad for Innova Crysta 2020"
// with every shop's price shown below.
router.get('/catalog/:masterPartId', async (req, res, next) => {
  try {
    const { lat, lng, radius = 50 } = req.query;
    const { masterPartId } = req.params;

    const part = await prisma.masterPart.findUnique({
      where: { masterPartId },
      include: {
        fitments: { include: { vehicle: true }, take: 20 },
        inventory: {
          where: { isMarketplaceListed: true, stockQty: { gt: 0 } },
          include: { shop: true },
        },
      },
    });
    if (!part) return res.status(404).json({ error: 'Part not found' });

    // Aggregate review stats via raw SQL (marketplace_reviews table added via migration)
    let reviewStats = { avgRating: null, totalReviews: 0 };
    let recentReviews = [];
    try {
      const [stats] = await prisma.$queryRaw`
        SELECT
          ROUND(AVG(rating)::NUMERIC, 1)::FLOAT AS avg_rating,
          COUNT(*)::INT                          AS total_reviews
        FROM marketplace_reviews
        WHERE master_part_id = ${masterPartId}
          AND is_hidden = FALSE
      `;
      reviewStats = {
        avgRating:    stats.avg_rating,
        totalReviews: stats.total_reviews,
      };

      recentReviews = await prisma.$queryRaw`
        SELECT review_id, customer_name, rating, title, body,
               verified_purchase, helpful_count, created_at
        FROM   marketplace_reviews
        WHERE  master_part_id = ${masterPartId}
          AND  is_hidden = FALSE
        ORDER  BY created_at DESC
        LIMIT  10
      `;
    } catch { /* marketplace_reviews may not exist on older deploys */ }

    // Build shop listings with optional distance sort
    const listings = part.inventory
      .map(inv => ({
        inventoryId:  inv.inventoryId,
        shopId:       inv.shopId,
        shopName:     inv.shop.name,
        shopAddress:  inv.shop.address,
        shopCity:     inv.shop.city,
        isVerified:   inv.shop.isVerified,
        price:        Number(inv.sellingPrice),
        stockQty:     inv.stockQty,
        rackLocation: inv.rackLocation,
        distance: (lat && lng && inv.shop.latitude && inv.shop.longitude)
          ? +getDistanceKm(parseFloat(lat), parseFloat(lng), Number(inv.shop.latitude), Number(inv.shop.longitude)).toFixed(1)
          : null,
      }))
      .sort((a, b) => {
        // Sort by distance if available, else by price
        if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
        return a.price - b.price;
      });

    res.json({
      part: {
        ...part,
        inventory: undefined,   // don't double-send raw inventory
      },
      listings,
      reviews:     recentReviews,
      reviewStats,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/marketplace/catalog/:masterPartId/review ───────────────────────
// Add a review for a master part (not per-shop — rating persists if shop delists).
router.post('/catalog/:masterPartId/review', authenticate, async (req, res, next) => {
  try {
    const { masterPartId } = req.params;
    const { rating, title, body, inventoryId, orderId } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be 1–5' });
    }

    const part = await prisma.masterPart.findUnique({ where: { masterPartId } });
    if (!part) return res.status(404).json({ error: 'Part not found' });

    // Check if this is a verified purchase (order exists and is DELIVERED)
    let verifiedPurchase = false;
    if (orderId) {
      const order = await prisma.marketplaceOrder.findUnique({ where: { orderId } });
      verifiedPurchase = order?.status === 'DELIVERED';
    }

    // Use raw SQL for insert (marketplace_reviews added via migration, not in generated client yet)
    await prisma.$executeRaw`
      INSERT INTO marketplace_reviews
        (master_part_id, inventory_id, order_id, customer_name, customer_phone,
         rating, title, body, verified_purchase)
      VALUES
        (${masterPartId}, ${inventoryId || null}, ${orderId || null},
         ${req.user.name || 'Anonymous'}, ${req.user.phone || null},
         ${parseInt(rating)}, ${title || null}, ${body || null}, ${verifiedPurchase})
    `;

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/marketplace/orders/:id/track
router.get('/orders/:id/track', async (req, res, next) => {
  try {
    const order = await prisma.marketplaceOrder.findUnique({
      where: { orderId: req.params.id },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default router;
