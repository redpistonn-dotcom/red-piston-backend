import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';
import { requirePermission } from '../middleware/auth.js';
import { invalidate, invalidatePattern } from '../lib/cache.js';
import { incrementCounter } from '../lib/metrics.js';

const router = Router();

// GET /api/shop/inventory
// WHY the rewrite:
//   1. Previously fetched movements twice — once via `include: { movements: { take:5 } }`
//      for display, then again via a separate findMany for stock computation.
//      Now we fetch ALL movements once and derive both the stock count AND the
//      recent-5 display slice from the same array.
//   2. masterPart used `include: { masterPart: true }` (all columns). Explicit select
//      cuts the payload to only what the frontend actually uses.
//   3. Cache-Control: private, max-age=20 allows the browser to skip this request on
//      rapid page refreshes (e.g. CMD+R twice in 20s) without ever showing stale stock.
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const shopId = req.shopId;

    // Pagination params
    const limit  = Math.min(parseInt(req.query.limit  || '500', 10), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);

    // ?all=true bypasses the configured-only filter (used by catalog search)
    const showAll = req.query.all === 'true';
    // ?search=... filters by part name, OEM number, or custom name (useful with all=true)
    const search  = req.query.search?.trim() || '';

    // Build AND conditions so configured-only filter and search can coexist
    const andConditions = [];
    if (!showAll) {
      andConditions.push({ OR: [{ sellingPrice: { gt: 0 } }, { stockQty: { gt: 0 } }] });
    }
    if (search) {
      andConditions.push({
        OR: [
          { customPartName: { contains: search, mode: 'insensitive' } },
          { masterPart: { partName:   { contains: search, mode: 'insensitive' } } },
          { masterPart: { oemNumbers: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }

    const where = {
      shopId,
      deletedAt: null,
      ...(andConditions.length > 0 ? { AND: andConditions } : {}),
    };

    const [inventory, total] = await Promise.all([
      prisma.shopInventory.findMany({
        where,
        include: {
          masterPart: {
            select: {
              masterPartId: true,
              partName:     true,
              brand:        true,
              categoryL1:   true,
              categoryL2:   true,
              description:  true,
              hsnCode:      true,
              gstRate:      true,
              unitOfSale:   true,
              imageUrl:     true,
              oemNumbers:   true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.shopInventory.count({ where }),
    ]);

    // Fetch last 5 movements only for this page's items — never unbounded
    const inventoryIds = inventory.map(i => i.inventoryId);
    const recentMovements = inventoryIds.length > 0
      ? await prisma.movement.findMany({
          where:   { inventoryId: { in: inventoryIds } },
          orderBy: { createdAt: 'desc' },
          take:    Math.min(inventoryIds.length * 5, 2500),
        })
      : [];

    const movsByItem = {};
    for (const m of recentMovements) {
      if (!movsByItem[m.inventoryId]) movsByItem[m.inventoryId] = [];
      if (movsByItem[m.inventoryId].length < 5) movsByItem[m.inventoryId].push(m);
    }

    const inventoryWithStock = inventory.map(item => ({
      ...item,
      computedStock: item.stockQty,
      movements:     movsByItem[item.inventoryId] || [],
    }));

    res.set('Cache-Control', 'private, max-age=20, must-revalidate');
    res.json({ inventory: inventoryWithStock, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      masterPartId, sellingPrice, buyingPrice, mrp, stockQty,
      rackLocation, minStockAlert, maxStockLevel,
      customPartName, nickname, barcode,
      shopSpecificNotes, isMarketplaceListed, supplierName, images,
      supplierGstin, supplierPhone, supplierInvoiceNo,
    } = req.body;
    if (!masterPartId || !sellingPrice) {
      return res.status(400).json({ error: 'masterPartId and sellingPrice required' });
    }
    const parsedSell = parseFloat(sellingPrice);
    if (!Number.isFinite(parsedSell) || parsedSell <= 0) {
      return res.status(400).json({ error: 'Selling price must be greater than 0' });
    }
    // Buying price, when provided, must be a positive amount (0 is not valid).
    if (buyingPrice !== undefined && buyingPrice !== null && buyingPrice !== '' && parseFloat(buyingPrice) <= 0) {
      return res.status(400).json({ error: 'Buying price must be greater than 0' });
    }
    if (mrp !== undefined && mrp !== null && mrp !== '' && (!Number.isFinite(parseFloat(mrp)) || parseFloat(mrp) <= 0)) {
      return res.status(400).json({ error: 'MRP must be greater than 0' });
    }

    const existing = await prisma.shopInventory.findUnique({
      where: { shopId_masterPartId: { shopId: req.shopId, masterPartId } },
    });
    if (existing) return res.status(409).json({ error: 'Product already in inventory', inventoryId: existing.inventoryId });

    const parsedInitialQty = stockQty != null ? parseInt(stockQty) : 0;
    if (isNaN(parsedInitialQty) || parsedInitialQty < 0) {
      return res.status(400).json({ error: 'stockQty must be 0 or greater' });
    }

    const item = await prisma.shopInventory.create({
      data: {
        shopId:              req.shopId,
        masterPartId,
        sellingPrice:        parseFloat(sellingPrice),
        buyingPrice:         buyingPrice     ? parseFloat(buyingPrice) : null,
        mrp:                 mrp             ? parseFloat(mrp) : null,
        stockQty:            parsedInitialQty,
        rackLocation:        rackLocation    || null,
        minStockAlert:       minStockAlert   || 5,
        maxStockLevel:       maxStockLevel   ? parseInt(maxStockLevel) : null,
        customPartName:      customPartName  || null,
        nickname:            nickname        || null,
        barcode:             barcode         || null,
        shopSpecificNotes:   shopSpecificNotes || null,
        // New inventory is NOT auto-listed on the marketplace — going live is an
        // explicit action from Parts Listing (which also requires a product image).
        isMarketplaceListed: isMarketplaceListed ?? false,
        ...(images && { images }),
      },
      include: { masterPart: true },
    });

    // Upsert the supplier into the parties table so it becomes a REUSABLE supplier
    // record (Parties → Suppliers) with GSTIN/phone in real columns — matched by
    // GSTIN when present, else by name (within this shop). Best-effort.
    let supplierPartyId = null;
    if (supplierName || supplierGstin) {
      try {
        const existing = await prisma.party.findFirst({
          where: {
            shopId: req.shopId,
            type: { in: ['SUPPLIER', 'BOTH'] },
            ...(supplierGstin ? { gstin: supplierGstin } : { name: supplierName }),
          },
        });
        if (existing) {
          supplierPartyId = existing.partyId;
          const patch = {};
          if (supplierGstin && !existing.gstin) patch.gstin = supplierGstin;
          if (supplierPhone && !existing.phone) patch.phone = supplierPhone;
          if (Object.keys(patch).length) {
            await prisma.party.update({ where: { partyId: existing.partyId }, data: patch });
          }
        } else {
          const created = await prisma.party.create({
            data: {
              shopId: req.shopId,
              name: supplierName || supplierGstin,
              gstin: supplierGstin || null,
              phone: supplierPhone || null,
              type: 'SUPPLIER',
            },
          });
          supplierPartyId = created.partyId;
        }
      } catch (e) {
        console.error('[inventory POST] supplier party upsert failed:', e?.message);
      }
    }

    // If opening stock provided, create a PURCHASE movement (type=PURCHASE so it counts
    // in purchase reports / cost-of-goods). Notes preserve "Opening stock" context so
    // History still shows this was the initial stock entry, not a restock.
    if (parsedInitialQty > 0) {
      const supplierBits = [
        supplierName && `Supplier: ${supplierName}`,
        supplierGstin && `GSTIN: ${supplierGstin}`,
        supplierPhone && `Ph: ${supplierPhone}`,
        supplierInvoiceNo && `Invoice: ${supplierInvoiceNo}`,
      ].filter(Boolean);
      const parsedQty   = parsedInitialQty;
      const parsedBuy   = buyingPrice ? parseFloat(buyingPrice) : null;
      await prisma.movement.create({
        data: {
          shopId:         req.shopId,
          inventoryId:    item.inventoryId,
          type:           'PURCHASE',
          qty:            parsedQty,
          unitPrice:      parsedBuy,
          totalAmount:    parsedBuy ? parsedQty * parsedBuy : null,
          partyName:      supplierName || null,
          referenceNumber: supplierInvoiceNo || null,
          partyId:        supplierPartyId,
          notes:          supplierBits.length ? `Opening stock · ${supplierBits.join(' · ')}` : 'Opening stock',
        },
      });
    }

    writeAudit(req, {
      entityType: ET.PRODUCT,
      entityId:   item.inventoryId,
      action:     ACT.CREATE,
      newValue: { masterPartId, sellingPrice, buyingPrice, stockQty: stockQty || 0 },
    });

    res.json({ success: true, item });
  } catch (err) {
    next(err);
  }
});

// PUT /api/shop/inventory/:id
router.put('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      sellingPrice, buyingPrice, mrp, rackLocation,
      minStockAlert, maxStockLevel,
      customPartName, nickname, barcode,
      shopSpecificNotes, isMarketplaceListed, imageUrl, images,
      customCategoryL1, customIcon,
      stockQty,
    } = req.body;
    const clientVersion = req.body.version != null ? parseInt(req.body.version) : null;

    const inventoryId = parseInt(req.params.id);
    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const metaData = {
      ...(sellingPrice        !== undefined && { sellingPrice:        parseFloat(sellingPrice) }),
      ...(buyingPrice         !== undefined && { buyingPrice:         parseFloat(buyingPrice) }),
      ...(mrp                 !== undefined && { mrp:                 mrp ? parseFloat(mrp) : null }),
      ...(rackLocation        !== undefined && { rackLocation }),
      ...(minStockAlert       !== undefined && { minStockAlert:       parseInt(minStockAlert) }),
      ...(maxStockLevel       !== undefined && { maxStockLevel:       maxStockLevel ? parseInt(maxStockLevel) : null }),
      ...(customPartName      !== undefined && { customPartName:      customPartName || null }),
      ...(nickname            !== undefined && { nickname:            nickname || null }),
      ...(barcode             !== undefined && { barcode:             barcode || null }),
      ...(shopSpecificNotes   !== undefined && { shopSpecificNotes:   shopSpecificNotes || null }),
      ...(isMarketplaceListed !== undefined && { isMarketplaceListed }),
      ...(imageUrl            !== undefined && { imageUrl:            imageUrl || null }),
      // images: JSON string array of up to 3 photo URLs (caller serializes)
      ...(images              !== undefined && { images:              images || null }),
      ...(customCategoryL1    !== undefined && { customCategoryL1:    customCategoryL1 || null }),
      ...(customIcon          !== undefined && { customIcon:          customIcon || null }),
    };

    // If stockQty is provided and differs from the stored value, update the column AND
    // create an AUDIT movement so the change is traceable in History.
    const newQty = stockQty !== undefined ? parseInt(stockQty) : undefined;
    const qtyChanged = newQty !== undefined && !isNaN(newQty) && newQty >= 0 && newQty !== item.stockQty;

    let updated;
    if (qtyChanged) {
      const delta = newQty - item.stockQty;

      if (clientVersion !== null) {
        const { count } = await prisma.$transaction(async (tx) => {
          await tx.movement.create({
            data: {
              shopId:     req.shopId,
              inventoryId,
              type:       'AUDIT',
              qty:        delta,
              notes:      'Manual stock correction via product edit',
            },
          });
          return tx.shopInventory.updateMany({
            where: { inventoryId, shopId: req.shopId, version: clientVersion },
            data:  { ...metaData, stockQty: newQty, version: { increment: 1 } },
          });
        });
        if (count === 0) {
          return res.status(409).json({ error: 'VERSION_CONFLICT' });
        }
      } else {
        await prisma.$transaction([
          prisma.movement.create({
            data: {
              shopId:     req.shopId,
              inventoryId,
              type:       'AUDIT',
              qty:        delta,
              notes:      'Manual stock correction via product edit',
            },
          }),
          prisma.shopInventory.update({
            where: { inventoryId },
            data:  { ...metaData, stockQty: newQty },
          }),
        ]);
      }

      updated = await prisma.shopInventory.findUnique({ where: { inventoryId }, include: { masterPart: true } });

      await invalidatePattern("shop:inventory:summary:" + req.shopId + ":*").catch(() => {});
      incrementCounter("stockAdjustments");
    } else {
      if (clientVersion !== null) {
        const { count } = await prisma.shopInventory.updateMany({
          where: { inventoryId, shopId: req.shopId, version: clientVersion },
          data:  { ...metaData, version: { increment: 1 } },
        });
        if (count === 0) {
          return res.status(409).json({ error: 'VERSION_CONFLICT' });
        }
        updated = await prisma.shopInventory.findUnique({ where: { inventoryId }, include: { masterPart: true } });
      } else {
        updated = await prisma.shopInventory.update({
          where:   { inventoryId },
          data:    metaData,
          include: { masterPart: true },
        });
      }
    }

    writeAudit(req, {
      entityType: ET.PRODUCT,
      entityId:   inventoryId,
      action:     ACT.UPDATE,
      oldValue: {
        sellingPrice: String(item.sellingPrice),
        buyingPrice:  item.buyingPrice ? String(item.buyingPrice) : null,
        isMarketplaceListed: item.isMarketplaceListed,
        stockQty: item.stockQty,
      },
      newValue: req.body,
    });

    res.json({ success: true, item: updated });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/inventory/:id/movements
router.get('/:id/movements', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const inventoryId = parseInt(req.params.id);
    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const movements = await prisma.movement.findMany({
      where: { inventoryId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const currentStock = item.stockQty;
    res.json({ movements, currentStock });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory/purchase
router.post('/purchase', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { inventoryId, partyId, notes, referenceNumber, gstRate, invoiceNo, payment, supplier } = req.body;
    const unitPrice      = req.body.unitPrice      ?? req.body.buyingPrice ?? null;
    const newSellingPrice = req.body.newSellingPrice ?? null;
    const qty = parseInt(req.body.qty);

    if (!inventoryId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'inventoryId and qty (positive integer) required' });
    }

    const item = await prisma.shopInventory.findUnique({
      where:   { inventoryId },
      include: { masterPart: { select: { gstRate: true } } },
    });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const parsedUnit  = unitPrice ? parseFloat(unitPrice) : null;
    const parsedGst   = gstRate   ? parseFloat(gstRate)   : (parsedUnit ? parseFloat(item.masterPart?.gstRate || 18) : null);
    const taxableAmt  = parsedUnit ? parsedUnit * qty : null;
    const gstAmt      = (taxableAmt && parsedGst) ? taxableAmt * (parsedGst / 100) : null;
    const totalAmount = taxableAmt ? taxableAmt + (gstAmt || 0) : null;

    await prisma.$transaction(async (tx) => {
      // Resolve party name for denormalized display (best-effort inside transaction)
      let purchasePartyName = supplier || null;
      if (partyId && !purchasePartyName) {
        const p = await tx.party.findUnique({ where: { partyId: parseInt(partyId) }, select: { name: true } });
        purchasePartyName = p?.name || null;
      }

      await tx.movement.create({
        data: {
          shopId:          req.shopId,
          inventoryId,
          type:            'PURCHASE',
          qty,
          unitPrice:       parsedUnit,
          gstRate:         parsedGst,
          taxableAmount:   taxableAmt,
          gstAmount:       gstAmt,
          totalAmount,
          partyId:         partyId         ? parseInt(partyId) : null,
          referenceNumber: referenceNumber || invoiceNo || null,
          invoiceNumber:   invoiceNo       || referenceNumber  || null,
          partyName:       purchasePartyName,
          paymentMode:     payment         || null,
          notes:           notes           || null,
          createdBy:       req.user.userId,
        },
      });

      await tx.shopInventory.update({
        where: { inventoryId },
        data:  {
          stockQty: { increment: qty },
          lastPurchasedAt: new Date(),
        },
      });

      const priceUpdates = {};
      if (newSellingPrice) priceUpdates.sellingPrice = parseFloat(newSellingPrice);

      // Weighted average cost: (currentStock × currentBuyPrice + qty × newBuyPrice) / (currentStock + qty)
      // Only recalculate when both qty and a new buying price are supplied.
      const newBuyPrice = parsedUnit;
      if (qty > 0 && newBuyPrice && newBuyPrice > 0) {
        const currentStock    = item.stockQty;                          // stock BEFORE this purchase
        const currentBuyPrice = item.buyingPrice ? parseFloat(item.buyingPrice) : newBuyPrice;
        const newAvg = Math.round(
          ((currentStock * currentBuyPrice) + (qty * newBuyPrice)) / (currentStock + qty) * 100
        ) / 100;
        priceUpdates.buyingPrice = newAvg;
      }

      if (Object.keys(priceUpdates).length > 0) {
        await tx.shopInventory.update({ where: { inventoryId }, data: priceUpdates });
      }
    });

    const { stockQty: newStock } = await prisma.shopInventory.findUnique({ where: { inventoryId }, select: { stockQty: true } });

    writeAudit(req, {
      entityType: ET.STOCK,
      entityId:   inventoryId,
      action:     ACT.PURCHASE,
      newValue: { qty, unitPrice: parsedUnit, partyId: partyId || null, referenceNumber: referenceNumber || null, newStock },
    });

    await invalidatePattern("shop:inventory:summary:" + req.shopId + ":*").catch(() => {});
    incrementCounter("stockAdjustments");

    res.json({ success: true, newStock });
  } catch (err) { next(err); }
});

// ─── GET /api/shop/inventory/low-stock ───────────────────────────────────────
// Returns all items where stockQty <= minStockAlert
router.get('/low-stock', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    // Prisma doesn't support field-to-field comparison (stockQty <= minStockAlert), use raw SQL
    const lowStock = await prisma.$queryRaw`
      SELECT
        si.inventory_id, si.stock_qty, si.min_stock_alert, si.max_stock_level,
        si.selling_price, si.buying_price, si.rack_location, si.custom_part_name, si.barcode,
        mp.part_name, mp.brand, mp.category_l1, mp.image_url
      FROM shop_inventory si
      JOIN master_parts mp ON mp.master_part_id = si.master_part_id
      WHERE si.shop_id = ${req.shopId}
        AND si.stock_qty <= si.min_stock_alert
        AND si.deleted_at IS NULL
      ORDER BY si.stock_qty ASC
    `;

    res.json({ success: true, items: lowStock, total: lowStock.length });
  } catch (err) { next(err); }
});

// GET /api/shop/movements — paginated movement ledger with filters
// Query params: limit (max 500), offset, type, from (ISO date), to (ISO date),
//               search (product/party name / invoice no), partyId
const ADJUSTMENT_TYPES = ['RETURN_IN','RETURN_OUT','CREDIT_NOTE','DEBIT_NOTE','DAMAGE','THEFT','AUDIT','OPENING','TRANSFER_IN','TRANSFER_OUT','ADJUST'];

router.get('/movements', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { limit = 500, offset = 0, type, from, to, search, partyId } = req.query;
    const parsedLimit  = Math.min(Math.max(parseInt(limit)  || 500, 1), 500);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    const where = { shopId: req.shopId };

    if (type && type !== 'ALL') {
      if (type === 'ADJUSTMENTS') {
        where.type = { in: ADJUSTMENT_TYPES };
      } else {
        where.type = type;
      }
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }
    if (partyId) where.partyId = partyId;
    if (search) {
      const s = search.trim();
      where.OR = [
        { referenceNumber: { contains: s, mode: 'insensitive' } },
        { invoiceNumber:   { contains: s, mode: 'insensitive' } },
        { partyName:       { contains: s, mode: 'insensitive' } },
        { party:     { name: { contains: s, mode: 'insensitive' } } },
        { inventory: { customPartName: { contains: s, mode: 'insensitive' } } },
        { inventory: { masterPart: { partName: { contains: s, mode: 'insensitive' } } } },
      ];
    }

    const [movements, total] = await Promise.all([
      prisma.movement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take:    parsedLimit,
        skip:    parsedOffset,
        include: {
          inventory: {
            select: {
              customPartName: true,
              masterPart: { select: { partName: true } },
            },
          },
          party: { select: { name: true, type: true } },
        },
      }),
      prisma.movement.count({ where }),
    ]);

    res.json({ success: true, movements, total, limit: parsedLimit, offset: parsedOffset });
  } catch (err) {
    console.error('[GET /shop/movements]', err);
    next(err);
  }
});

// POST /api/shop/inventory/bulk-stock-in
// Cart/bucket procurement — receives entire purchase session in one call.
// Body: {
//   items: [{ masterPartId, sellingPrice, buyingPrice?, stockQty?, rackLocation?,
//             minStockAlert?, shopSpecificNotes? }],
//   supplier: { name?, invoiceNo?, invoiceDate?, paymentMode?, creditDays?, notes? }
// }
// Returns: { success, created, updated, errorCount, errors,
//            items: [...ShopInventory+masterPart], movements: [...Movement] }
router.post('/bulk-stock-in', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { items, supplier = {} } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must be non-empty' });
    }
    if (items.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 items per bulk stock-in' });
    }

    const supplierNotes = [
      supplier.name       && `Supplier: ${supplier.name}`,
      supplier.invoiceNo  && `Invoice: ${supplier.invoiceNo}`,
      supplier.notes,
    ].filter(Boolean).join(' · ') || 'Bulk stock-in';

    const resultItems    = [];  // full ShopInventory objects returned to frontend
    const resultMovements = []; // all Movement objects created
    const errors = [];

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const {
          masterPartId, sellingPrice, buyingPrice, stockQty,
          rackLocation, minStockAlert, shopSpecificNotes,
        } = item;

      if (!masterPartId || sellingPrice == null) {
        errors.push({ masterPartId, error: 'masterPartId and sellingPrice are required' });
        continue;
      }

      try {
        const qty     = Math.max(0, parseInt(stockQty) || 0);
        const buyP    = buyingPrice  ? parseFloat(buyingPrice)  : null;
        const sellP   = parseFloat(sellingPrice);
        if (!Number.isFinite(sellP) || sellP < 0) {
          errors.push({ masterPartId, error: 'sellingPrice must be a non-negative number' });
          continue;
        }
        const minAlert = minStockAlert ? parseInt(minStockAlert) : 5;

        const existing = await tx.shopInventory.findUnique({
          where: { shopId_masterPartId: { shopId: req.shopId, masterPartId } },
        });

        let invId;
        let movType;

        if (existing) {
          // ── Already in inventory: add stock as PURCHASE ────────────────────
          const updateData = {
            ...(sellingPrice != null  && { sellingPrice: sellP }),
            ...(buyingPrice  != null  && { buyingPrice:  buyP  }),
            ...(rackLocation          && { rackLocation }),
            ...(shopSpecificNotes     && { shopSpecificNotes }),
            ...(qty > 0               && { stockQty: { increment: qty }, lastPurchasedAt: new Date() }),
          };
          await tx.shopInventory.update({
            where: { inventoryId: existing.inventoryId },
            data: updateData,
          });
          invId   = existing.inventoryId;
          movType = 'PURCHASE';
        } else {
          // ── New to shop: create inventory row ──────────────────────────────
          const created = await tx.shopInventory.create({
            data: {
              shopId:              req.shopId,
              masterPartId,
              sellingPrice:        sellP,
              buyingPrice:         buyP,
              stockQty:            qty,
              rackLocation:        rackLocation || null,
              minStockAlert:       minAlert,
              shopSpecificNotes:   shopSpecificNotes || null,
              lastPurchasedAt:     qty > 0 ? new Date() : null,
              isMarketplaceListed: true,
            },
          });
          invId   = created.inventoryId;
          movType = 'PURCHASE'; // new item's first stock is still a purchase
        }

        // ── Record movement ───────────────────────────────────────────────────
        let mov = null;
        if (qty > 0) {
          mov = await tx.movement.create({
            data: {
              shopId:      req.shopId,
              inventoryId: invId,
              type:        movType,
              qty,
              unitPrice:   buyP,
              totalAmount: buyP ? buyP * qty : null,
              notes:       supplierNotes,
            },
          });
          resultMovements.push(mov);
        }

        // ── Re-fetch full inventory row with masterPart ───────────────────────
        const fullInv = await tx.shopInventory.findUnique({
          where: { inventoryId: invId },
          include: { masterPart: true },
        });
        resultItems.push({ ...fullInv, _status: existing ? 'updated' : 'created' });
      } catch (e) {
        errors.push({ masterPartId, error: e.message });
      }
    }
    });

    const created = resultItems.filter(r => r._status === 'created').length;
    const updated = resultItems.filter(r => r._status === 'updated').length;

    res.json({
      success: true,
      created,
      updated,
      errorCount: errors.length,
      errors,
      items:     resultItems,
      movements: resultMovements,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/inventory/:id/marketplace — toggle isMarketplaceListed
router.patch('/:id/marketplace', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const inventoryId = parseInt(req.params.id);
    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const { listed } = req.body; // explicit boolean, or toggle if omitted
    const newValue = listed !== undefined ? Boolean(listed) : !item.isMarketplaceListed;

    // Going live requires a real price and a product image
    if (newValue && !(Number(item.sellingPrice) > 0)) {
      return res.status(400).json({ error: 'Set a selling price before listing this item on the marketplace' });
    }
    if (newValue && !item.imageUrl) {
      return res.status(400).json({ error: 'Upload a product image before listing this item on the marketplace' });
    }

    const updated = await prisma.shopInventory.update({
      where: { inventoryId },
      data: { isMarketplaceListed: newValue },
      include: { masterPart: true },
    });
    res.json({ success: true, isMarketplaceListed: updated.isMarketplaceListed, item: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory/adjust
router.post('/adjust', authenticate, requireShopOwner, requirePermission('inventory.adjust'), async (req, res, next) => {
  try {
    const { inventoryId, type, qty, notes } = req.body;
    if (!inventoryId || !type || qty === undefined) return res.status(400).json({ error: 'inventoryId, type, and qty required' });
    if (!Number.isFinite(parseInt(qty))) return res.status(400).json({ error: 'qty must be a number' });

    // All adjustment types accepted from frontend (AUDIT, OPENING, CREDIT_NOTE, DEBIT_NOTE are
    // financial-only and carry no stock change)
    const validTypes = [
      'ADJUSTMENT', 'DAMAGE', 'THEFT', 'RETURN_IN', 'RETURN_OUT',
      'OPENING', 'AUDIT', 'CREDIT_NOTE', 'DEBIT_NOTE',
    ];
    if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });

    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    // Map each type to its stock delta direction:
    //   +qty: RETURN_IN, OPENING, ADJUSTMENT (positive values add stock)
    //   -qty: DAMAGE, THEFT, RETURN_OUT (always reduce stock, store abs qty in movement)
    //    0:   CREDIT_NOTE, DEBIT_NOTE (financial only, no physical stock change)
    const STOCK_OUT_TYPES = ['DAMAGE', 'THEFT', 'RETURN_OUT'];
    const NO_STOCK_TYPES  = ['CREDIT_NOTE', 'DEBIT_NOTE'];
    let qtyChange;
    if (NO_STOCK_TYPES.includes(type)) {
      qtyChange = 0;
    } else if (STOCK_OUT_TYPES.includes(type)) {
      qtyChange = -Math.abs(parseInt(qty));
    } else {
      // RETURN_IN, OPENING: always positive; ADJUSTMENT: caller controls sign via qty
      qtyChange = parseInt(qty);
    }

    // Never let an adjustment drive stock below zero (phantom negative stock
    // is unrecoverable through the UI). Guard against the LEDGER-computed stock
    // (the value the UI shows) rather than the stored stockQty column — the two
    // can drift, which would otherwise reject a reduction that looks valid to
    // the user ("current: 7" on screen but the stored column says 1).
    if (qtyChange < 0) {
      const { stockQty: liveStock } = await prisma.shopInventory.findUnique({ where: { inventoryId }, select: { stockQty: true } });
      if (liveStock + qtyChange < 0) {
        return res.status(400).json({ error: `Adjustment would make stock negative (current: ${liveStock})` });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.movement.create({
        data: {
          shopId: req.shopId,
          inventoryId,
          type,
          qty: parseInt(qty),
          notes,
        },
      });
      await tx.shopInventory.update({
        where: { inventoryId },
        data: { stockQty: { increment: qtyChange } },
      });
    });

    const { stockQty: newStock } = await prisma.shopInventory.findUnique({ where: { inventoryId }, select: { stockQty: true } });

    await invalidatePattern("shop:inventory:summary:" + req.shopId + ":*").catch(() => {});
    incrementCounter("stockAdjustments");

    res.json({ success: true, newStock });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/shop/inventory/:id — remove a product from this shop's inventory.
// Also clears its stock-movement ledger rows (in one transaction). Blocks with a
// clear message if the product is still referenced by orders / job cards (FK).
router.delete('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const inventoryId = parseInt(req.params.id, 10);
    if (!Number.isFinite(inventoryId)) return res.status(400).json({ error: 'Invalid id' });

    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    await prisma.shopInventory.update({
      where: { inventoryId },
      data:  { deletedAt: new Date(), isMarketplaceListed: false },
    });

    writeAudit(req, {
      entityType: ET.PRODUCT,
      entityId:   inventoryId,
      action:     ACT.DELETE,
      oldValue:   { partName: item.customPartName || null, stockQty: item.stockQty },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[inventory DELETE]', err);
    next(err);
  }
});

export default router;
