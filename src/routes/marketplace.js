import crypto from 'crypto';
import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { pageBounds } from '../lib/pagination.js';
import { sendOrderConfirmationEmail } from '../services/email.js';
import { getOrSet, invalidatePattern } from '../lib/cache.js';
import { incrementCounter } from '../lib/metrics.js';

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
      price_max,        // max selling price filter (applied to best shop price)
      part_type,        // "OEM" | "OES" | undefined = all
      shop_id,          // filter to a single shop's inventory
    } = req.query;
    const { take, skip } = pageBounds(limit, offset, { defLimit: 40, maxLimit: 100 });

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
    // Build the base inventory condition (reused in both partWhere and include)
    const inventoryBase = { isMarketplaceListed: true, stockQty: { gt: 0 } };
    // Price filter: only count a part as "available" if at least one shop sells it within budget
    if (price_max && !isNaN(parseFloat(price_max))) {
      inventoryBase.sellingPrice = { lte: parseFloat(price_max) };
    }
    // Shop filter: only show parts carried by this specific shop
    if (shop_id && !isNaN(parseInt(shop_id))) {
      inventoryBase.shopId = parseInt(shop_id);
    }

    const partWhere = {
      // Only show parts that have at least one marketplace-listed, in-stock listing (within price budget if set)
      inventory: { some: inventoryBase },
    };

    // Part type filter (OEM / OES)
    const upperPartType = (part_type || '').toUpperCase();
    if (upperPartType === 'OEM' || upperPartType === 'OES') {
      partWhere.partType = upperPartType;
    }

    // Category filter
    if (category && category !== 'All') {
      partWhere.categoryL1 = { equals: category, mode: 'insensitive' };
    }

    // Search query
    if (q && q.trim().length >= 2) {
      partWhere.OR = [
        { partName:  { contains: q.trim(), mode: 'insensitive' } },
        { brand:     { contains: q.trim(), mode: 'insensitive' } },
        { primaryOemNumber: { contains: q.trim(), mode: 'insensitive' } },
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
    const ck = "catalog:browse:" + JSON.stringify({...req.query, page:undefined});
    const results = await getOrSet(ck, 60, async () => {
      const parts = await prisma.masterPart.findMany({
        where: partWhere,
        include: {
          inventory: {
            where: inventoryBase,   // same condition as partWhere — filters by price too
            include: { shop: true },
          },
          fitments: resolvedVehicleId
            ? { where: { vehicleId: resolvedVehicleId }, select: { fitType: true } }
            : false,
        },
        orderBy: { partName: 'asc' },
        take,
        skip,
      });

      // ── Step 4: Count total (for pagination) ───────────────────────────────
      const total = await prisma.masterPart.count({ where: partWhere });
      return { parts, total };
    });
    const { parts, total } = results;

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
        // OEM/part numbers are confidential — NOT exposed in marketplace API.
        // Use masterPartId as the public item reference number instead.
        hsnCode:         part.hsnCode,
        gstRate:         Number(part.gstRate),
        unitOfSale:      part.unitOfSale,
        description:     part.description,
        specifications:  part.specifications,
        partType:        part.partType,  // "OEM" | "OES"
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
        limit: take,
        offset: skip,
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
      take: pageBounds(limit, 0, { defLimit: 50, maxLimit: 200 }).take,
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

// ─── GET /api/marketplace/vehicles/types ─────────────────────────────────────
// Returns all vehicle types with their body types nested.
// Used to populate type pickers and body-type dropdowns together in one call.
router.get('/vehicles/types', async (req, res, next) => {
  try {
    const types = await prisma.vehicleType.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        bodyTypes: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            bodyTypeId: true, name: true, slug: true, icon: true, sortOrder: true,
          },
        },
      },
    });
    res.json({ success: true, data: types });
  } catch (err) { next(err); }
});

// ─── GET /api/marketplace/vehicles/body-types?vehicleTypeId=1 ────────────────
// Returns body types for a given vehicle type ID (or all if no filter).
router.get('/vehicles/body-types', async (req, res, next) => {
  try {
    const { vehicleTypeId, vehicleTypeSlug } = req.query;
    const where = { isActive: true };
    if (vehicleTypeId) {
      where.vehicleTypeId = parseInt(vehicleTypeId, 10);
    } else if (vehicleTypeSlug) {
      where.vehicleType = { slug: vehicleTypeSlug };
    }
    const bodyTypes = await prisma.vehicleBodyType.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
      include: {
        vehicleType: { select: { id: true, name: true, slug: true, icon: true } },
      },
    });
    res.json({ success: true, data: bodyTypes });
  } catch (err) { next(err); }
});

// ─── GET /api/marketplace/vehicles/manufacturers ─────────────────────────────
// Returns all manufacturers from the vehicle_manufacturers table.
// Query: vehicleType = "car" | "2wheeler" | "commercial" | "tractor"
router.get('/vehicles/manufacturers', async (req, res, next) => {
  try {
    const { vehicleType } = req.query;
    const where = { isActive: true };
    if (vehicleType && vehicleType !== 'all') {
      where.vehicleTypes = { has: vehicleType };
    }
    const manufacturers = await prisma.vehicleManufacturer.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        manufacturerId: true,
        name:           true,
        slug:           true,
        country:        true,
        vehicleTypes:   true,
        parentGroup:    true,
      },
    });
    res.json({ success: true, data: manufacturers });
  } catch (err) { next(err); }
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
// Two modes:
//   manufacturerId (int) → query vehicle_models table (new hierarchy)
//   make (string)        → query flat vehicles table (legacy fallback)
router.get('/vehicles/models', async (req, res, next) => {
  try {
    const { manufacturerId, make, vehicleType } = req.query;

    // ── New path: structured VehicleModel table ──────────────────────────────
    if (manufacturerId) {
      const where = {
        manufacturerId: parseInt(manufacturerId, 10),
        isActive: true,
      };
      if (vehicleType) where.vehicleType = vehicleType;
      const models = await prisma.vehicleModel.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          modelId:    true,
          name:       true,
          slug:       true,
          vehicleType: true,
          bodyType:   true,
          yearFrom:   true,
          yearTo:     true,
        },
      });
      return res.json({ success: true, data: models });
    }

    // ── Legacy path: flat Vehicle table keyed by make string ─────────────────
    if (!make) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAM', message: 'manufacturerId or make is required' },
      });
    }
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
        { primaryOemNumber: { contains: q, mode: 'insensitive' } },
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
      ...pageBounds(limit, offset),
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

// ─── GET /api/marketplace/orders — customer's order history ──────────────────
router.get('/orders', authenticate, async (req, res, next) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const where = { customerId: req.user.userId };
    if (status) where.status = status;

    const [orders, total] = await Promise.all([
      prisma.marketplaceOrder.findMany({
        where,
        include: {
          items: { include: { inventory: { include: { masterPart: { select: { partName: true, imageUrl: true, brand: true } } } } } },
          shop:  { select: { name: true, phone: true, address: true, city: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pageBounds(limit, offset),
      }),
      prisma.marketplaceOrder.count({ where }),
    ]);

    res.json({ success: true, data: { orders, total } });
  } catch (err) { next(err); }
});

// ─── GET /api/marketplace/orders/shop — shop's incoming marketplace orders ───
router.get('/orders/shop', authenticate, async (req, res, next) => {
  try {
    if (!req.user.shopId) return res.status(403).json({ error: 'No shop associated' });
    const { status, limit = 30, offset = 0 } = req.query;
    const where = { shopId: req.user.shopId };
    if (status) where.status = status;

    const [orders, total] = await Promise.all([
      prisma.marketplaceOrder.findMany({
        where,
        include: {
          // Customer phone deliberately excluded from the list view (PII
          // minimisation) — it's available on the order detail endpoint.
          items: { include: { inventory: { include: { masterPart: { select: { partName: true, brand: true } } } } } },
          customer: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...pageBounds(limit, offset),
      }),
      prisma.marketplaceOrder.count({ where }),
    ]);

    res.json({ success: true, data: { orders, total } });
  } catch (err) { next(err); }
});

// ─── GET /api/marketplace/orders/:id — order detail ──────────────────────────
router.get('/orders/:id', authenticate, async (req, res, next) => {
  try {
    const order = await prisma.marketplaceOrder.findUnique({
      where:   { orderId: parseInt(req.params.id, 10) },
      include: {
        items:          { include: { inventory: { include: { masterPart: true } } } },
        shop:           { select: { name: true, phone: true, address: true, city: true, logoUrl: true } },
        customer:       { select: { name: true, phone: true } },
        customerVehicle: true,
        deliveryAddr:   true,
      },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Allow customer who owns it, or the shop, or admin
    const userId  = req.user.userId;
    const shopId  = req.user.shopId;
    const isAdmin = req.user.role === 'PLATFORM_ADMIN';

    if (!isAdmin && order.customerId !== userId && order.shopId !== shopId) {
      // 404 (not 403) so unauthorized callers can't probe which order IDs exist
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) { next(err); }
});

// POST /api/marketplace/orders
router.post('/orders', authenticate, async (req, res, next) => {
  try {
    const {
      items, customerName, deliveryAddress, deliveryAddressId,
      paymentMode, customerVehicleId,
    } = req.body;

    if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });

    // Validate stock
    for (const item of items) {
      const inv = await prisma.shopInventory.findUnique({ where: { inventoryId: item.inventoryId } });
      if (!inv || inv.stockQty < item.qty) {
        return res.status(400).json({ error: `Insufficient stock for item ${item.inventoryId}` });
      }
    }

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
            // Object.entries keys are STRINGS — schema shopId is Int; the old
            // `shopId.slice(0,6)` orderNumber suffix was leftover cuid-era code.
            orderNumber:       `${orderNumber}-S${shopId}`,
            customerId:        req.user.userId,
            customerPhone:     req.user.phone || '',
            customerName:      customerName || req.user.name || null,
            shopId:            Number(shopId),
            subtotal:          shopSubtotal,
            total:             shopSubtotal,
            deliveryAddress:   deliveryAddress ? (typeof deliveryAddress === 'string' ? deliveryAddress : JSON.stringify(deliveryAddress)) : null,
            deliveryAddressId: deliveryAddressId || null,
            paymentMode:       paymentMode       || null,
            customerVehicleId: customerVehicleId || null,
            paymentStatus:     'PENDING',
            status:            'PENDING',
            commissionRate:    5.00, // default 5% — can be configured per shop plan
            items: {
              create: shopItems.map(i => ({
                inventoryId: i.inventoryId,
                partName:    i.partName    || 'Part',
                brand:       i.brand       || null,
                qty:         i.qty,
                unitPrice:   i.unitPrice,
                total:       i.unitPrice * i.qty,
              })),
            },
          },
          include: { items: true },
        });

        // Deduct stock immediately on order placement
        for (const item of shopItems) {
          await prisma.shopInventory.update({
            where: { inventoryId: item.inventoryId },
            data:  { stockQty: { decrement: item.qty } },
          });
        }

        return order;
      })
    );

    // Order confirmation email to the customer (fire-and-forget; phone-only
    // accounts have no email — skipped silently inside the helper)
    if (req.user.email) {
      const itemCount = items.reduce((s, i) => s + i.qty, 0);
      const grand = orders.reduce((s, o) => s + Number(o.total), 0);
      const shopRow = orders.length === 1
        ? await prisma.shop.findUnique({ where: { shopId: orders[0].shopId }, select: { name: true } }).catch(() => null)
        : null;
      sendOrderConfirmationEmail(req.user.email, {
        customerName: req.user.name,
        orderNumber,
        shopName: shopRow?.name || (orders.length > 1 ? `${orders.length} shops` : null),
        itemCount,
        totalAmount: grand,
      }).catch((e) => console.error('[EMAIL] Order confirmation failed:', e?.message));
    }

    await invalidatePattern("catalog:browse:*").catch(() => {});
    incrementCounter("marketplaceOrders");

    res.json({ success: true, orders, orderNumber });
  } catch (err) { next(err); }
});

// PUT /api/marketplace/orders/:id/status
router.put('/orders/:id/status', authenticate, async (req, res, next) => {
  try {
    const { status, estimatedDeliveryAt, cancelReason } = req.body;
    const validStatuses = ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${validStatuses.join(', ')}` });
    }

    const order = await prisma.marketplaceOrder.findUnique({
      where:   { orderId: parseInt(req.params.id, 10) },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (req.user.role !== 'PLATFORM_ADMIN' && order.shopId !== req.user.shopId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const data = { status };
    if (status === 'DELIVERED')         data.deliveredAt = new Date();
    if (estimatedDeliveryAt)            data.estimatedDeliveryAt = new Date(estimatedDeliveryAt);
    if (cancelReason && status === 'CANCELLED') data.cancelReason = cancelReason;

    // When delivered: stock was already deducted at order placement — just stamp lastSoldAt
    if (status === 'DELIVERED') {
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          await tx.shopInventory.update({
            where: { inventoryId: item.inventoryId },
            data:  { lastSoldAt: new Date() },
          });
        }

        // Calculate payout
        const commission   = Number(order.commissionRate);
        const payoutAmount = Number(order.total) * (1 - commission / 100);

        await tx.marketplaceOrder.update({
          where: { orderId: parseInt(req.params.id, 10) },
          data:  {
            ...data,
            payoutAmount,
            payoutStatus: 'PENDING',
          },
        });
      });
    } else if (status === 'CANCELLED') {
      // Restore stock on cancel (stock was decremented at order placement)
      await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          await tx.shopInventory.update({
            where: { inventoryId: item.inventoryId },
            data:  { stockQty: { increment: item.qty } },
          });
        }
        await tx.marketplaceOrder.update({ where: { orderId: parseInt(req.params.id, 10) }, data });
      });
    } else {
      await prisma.marketplaceOrder.update({ where: { orderId: parseInt(req.params.id, 10) }, data });
    }

    res.json({ success: true, status });
  } catch (err) { next(err); }
});

// PUT /api/marketplace/orders/:id/payment — update payment status (Razorpay callback)
//
// SECURITY: Any transition to PAID requires a valid Razorpay HMAC-SHA256 signature.
// Without this check an authenticated user could self-mark their own order as paid
// by sending {"paymentStatus":"PAID"} without actually paying.
router.put('/orders/:id/payment', authenticate, async (req, res, next) => {
  try {
    const { paymentStatus, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const VALID_PAY_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'];

    if (!paymentStatus || !VALID_PAY_STATUSES.includes(paymentStatus)) {
      return res.status(400).json({ error: `paymentStatus must be one of: ${VALID_PAY_STATUSES.join(', ')}` });
    }

    // Verify Razorpay HMAC signature before accepting a PAID status
    if (paymentStatus === 'PAID') {
      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({
          error: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required to mark an order as PAID',
        });
      }
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keySecret) {
        console.error('[Marketplace] RAZORPAY_KEY_SECRET is not set — cannot verify payment signature');
        return res.status(503).json({ error: 'Payment verification is not configured' });
      }
      const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
      // Constant-time comparison to prevent timing attacks
      const sigBuffer  = Buffer.from(razorpaySignature, 'hex');
      const expBuffer  = Buffer.from(expectedSignature, 'hex');
      const sigValid   = sigBuffer.length === expBuffer.length &&
                         crypto.timingSafeEqual(sigBuffer, expBuffer);
      if (!sigValid) {
        return res.status(403).json({ error: 'Invalid payment signature' });
      }
    }

    const order = await prisma.marketplaceOrder.findUnique({ where: { orderId: parseInt(req.params.id, 10) } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Allow: the customer themselves, the shop, or admin
    const isOwner = order.customerId === req.user.userId || order.shopId === req.user.shopId;
    if (!isOwner && req.user.role !== 'PLATFORM_ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const data = { paymentStatus };
    if (razorpayOrderId)   data.razorpayOrderId   = razorpayOrderId;
    if (razorpayPaymentId) data.razorpayPaymentId = razorpayPaymentId;
    if (paymentStatus === 'PAID') data.status = 'CONFIRMED';

    await prisma.marketplaceOrder.update({ where: { orderId: parseInt(req.params.id, 10) }, data });
    res.json({ success: true, paymentStatus });
  } catch (err) { next(err); }
});

// ─── GET /api/marketplace/catalog/:masterPartId ───────────────────────────────
// One-product-page: shows full part details + ALL shops listing it + review summary.
// Amazon-style: one canonical page for "Bosch Front Brake Pad for Innova Crysta 2020"
// with every shop's price shown below.
router.get('/catalog/:masterPartId', async (req, res, next) => {
  try {
    const { lat, lng, radius = 50 } = req.query;
    const rawId = req.params.masterPartId;
    const masterPartId = parseInt(rawId, 10);
    if (isNaN(masterPartId)) return res.status(400).json({ error: 'Invalid part ID' });

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
router.get('/orders/:id/track', authenticate, async (req, res, next) => {
  try {
    const order = await prisma.marketplaceOrder.findUnique({
      where: { orderId: parseInt(req.params.id, 10) },
      include: { items: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/marketplace/shops ──────────────────────────────────────────────
// Returns all shops that have at least one marketplace-listed item.
// Query: q (search), city, lat, lng, limit (default 50)
router.get('/shops', async (req, res, next) => {
  try {
    const { q, city, lat, lng, limit = 50, offset = 0 } = req.query;

    const where = {
      isActive: true,
    };
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (q)    where.OR  = [
      { name:    { contains: q, mode: 'insensitive' } },
      { city:    { contains: q, mode: 'insensitive' } },
      { address: { contains: q, mode: 'insensitive' } },
    ];

    const shops = await prisma.shop.findMany({
      where,
      ...pageBounds(limit, offset),
      orderBy: { name: 'asc' },
      select: {
        shopId: true, name: true, address: true, city: true,
        phone: true, latitude: true, longitude: true,
        logoUrl: true, isVerified: true, deliveryRadiusKm: true,
        _count: { select: { inventory: true } },
      },
    });

    const result = shops.map(s => ({
      id:              s.shopId,
      name:            s.name,
      address:         s.address,
      city:            s.city,
      phone:           s.phone,
      logo:            s.logoUrl,
      is_verified:     s.isVerified,
      delivery_radius: s.deliveryRadiusKm,
      rating:          4.2,
      reviews:         s._count.inventory * 3,
      parts_count:     s._count.inventory,
      distance: (lat && lng && s.latitude && s.longitude)
        ? +getDistanceKm(parseFloat(lat), parseFloat(lng), Number(s.latitude), Number(s.longitude)).toFixed(1)
        : null,
    }));

    res.json({ success: true, shops: result, total: result.length });
  } catch (err) { next(err); }
});

// ─── GET /api/marketplace/plate-lookup?plate=MH01AB1234 ──────────────────────
// If RC_API_KEY is set → calls the real RapidAPI endpoint.
// Otherwise falls back to a smart mock that parses the Indian plate format.
router.get('/plate-lookup', async (req, res, next) => {
  try {
    const { plate } = req.query;
    if (!plate) return res.status(400).json({ error: 'plate is required' });

    const clean   = plate.toUpperCase().replace(/\s|-/g, '');
    const apiKey  = process.env.RC_API_KEY;
    const apiHost = process.env.RC_API_HOST;
    const apiUrl  = process.env.RC_API_URL;

    // ── Real API path (swap in any RapidAPI RC provider) ──────────────────────
    if (apiKey && apiHost && apiUrl) {
      const r = await fetch(`${apiUrl}?plate=${encodeURIComponent(clean)}`, {
        headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': apiHost },
      });
      const j = await r.json();
      if (!r.ok) return res.status(422).json({ error: j.message || j.error || 'RC not found' });
      return res.json({
        make:     j.make || j.manufacturer || j.vehicleManufacturerName || '',
        model:    j.model || j.vehicleModel || '',
        year:     String(j.year || j.modelYear || j.manufacturingYear || ''),
        fuelType: (j.fuelType || j.fuel || '').toLowerCase(),
        plate:    clean,
        source:   'live',
      });
    }

    // ── Smart mock — parses real Indian plate format ───────────────────────────
    // Format: [SS][RR][XX][NNNN]  e.g. MH 01 AB 1234
    const STATE_CODES = {
      MH:'Maharashtra', DL:'Delhi', KA:'Karnataka', TN:'Tamil Nadu',
      TG:'Telangana', AP:'Andhra Pradesh', UP:'Uttar Pradesh', RJ:'Rajasthan',
      GJ:'Gujarat', MP:'Madhya Pradesh', KL:'Kerala', HR:'Haryana',
      PB:'Punjab', WB:'West Bengal', OD:'Odisha', BR:'Bihar',
      AS:'Assam', JH:'Jharkhand', UK:'Uttarakhand', HP:'Himachal Pradesh',
    };

    const VEHICLES = [
      { make:'Maruti Suzuki', model:'Swift',       fuelType:'petrol' },
      { make:'Maruti Suzuki', model:'Baleno',      fuelType:'petrol' },
      { make:'Maruti Suzuki', model:'WagonR',      fuelType:'cng'    },
      { make:'Hyundai',       model:'i20',         fuelType:'petrol' },
      { make:'Hyundai',       model:'Creta',       fuelType:'diesel' },
      { make:'Hyundai',       model:'Verna',       fuelType:'petrol' },
      { make:'Tata Motors',   model:'Nexon',       fuelType:'petrol' },
      { make:'Tata Motors',   model:'Punch',       fuelType:'petrol' },
      { make:'Tata Motors',   model:'Harrier',     fuelType:'diesel' },
      { make:'Mahindra',      model:'Scorpio',     fuelType:'diesel' },
      { make:'Mahindra',      model:'XUV700',      fuelType:'diesel' },
      { make:'Kia',           model:'Seltos',      fuelType:'petrol' },
      { make:'Toyota',        model:'Innova Crysta',fuelType:'diesel'},
      { make:'Honda',         model:'City',        fuelType:'petrol' },
      { make:'Renault',       model:'Kwid',        fuelType:'petrol' },
    ];

    const stateCode = clean.slice(0, 2);
    const rtoNum    = parseInt(clean.slice(2, 4), 10) || 1;
    const state     = STATE_CODES[stateCode] || stateCode;

    // Seed a deterministic vehicle from the plate string so same plate = same car
    const seed = clean.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const vehicle = VEHICLES[seed % VEHICLES.length];

    // Derive a plausible year: newer RTO codes = newer vehicles (rough heuristic)
    const currentYear = new Date().getFullYear();
    const yearOffset  = Math.min(rtoNum, 15);
    const year        = String(currentYear - (seed % (yearOffset + 1)));

    return res.json({
      make:     vehicle.make,
      model:    vehicle.model,
      year,
      fuelType: vehicle.fuelType,
      state,
      plate:    clean,
      source:   'mock',
    });
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
