import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

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

    const inventory = await prisma.shopInventory.findMany({
      where:    { shopId },
      include:  {
        masterPart: {
          select: {
            masterPartId:  true,
            partName:      true,
            brand:         true,
            categoryL1:    true,
            categoryL2:    true,
            description:   true,
            hsnCode:       true,
            gstRate:       true,
            unitOfSale:    true,
            imageUrl:      true,
            oemNumbers:    true,
          },
        },
      },
      orderBy: { masterPart: { partName: 'asc' } },
    });

    // Single movements fetch — ordered desc so slice(0,5) gives the most recent
    const inventoryIds = inventory.map(i => i.inventoryId);
    const allMovements = inventoryIds.length > 0
      ? await prisma.movement.findMany({
          where:   { inventoryId: { in: inventoryIds } },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    // Group by inventoryId for O(n) stock + recent-movements computation
    const movsByItem = {};
    for (const m of allMovements) {
      if (!movsByItem[m.inventoryId]) movsByItem[m.inventoryId] = [];
      movsByItem[m.inventoryId].push(m);
    }

    const stockMap = {};
    for (const [id, movs] of Object.entries(movsByItem)) {
      stockMap[id] = 0;
      for (const m of movs) {
        if      (['PURCHASE', 'OPENING', 'RETURN_IN'].includes(m.type))    stockMap[id] += m.qty;
        else if (['SALE', 'RETURN_OUT', 'DAMAGE', 'THEFT'].includes(m.type)) stockMap[id] -= m.qty;
        else if (m.type === 'ADJUSTMENT' || m.type === 'AUDIT')              stockMap[id] += m.qty;
      }
    }

    const inventoryWithStock = inventory.map(item => ({
      ...item,
      computedStock: stockMap[item.inventoryId] ?? item.stockQty,
      movements:     (movsByItem[item.inventoryId] || []).slice(0, 5),
    }));

    res.set('Cache-Control', 'private, max-age=20, must-revalidate');
    res.json({ inventory: inventoryWithStock });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      masterPartId, sellingPrice, buyingPrice, stockQty,
      rackLocation, minStockAlert, maxStockLevel,
      customPartName, barcode,
      shopSpecificNotes, isMarketplaceListed,
    } = req.body;
    if (!masterPartId || !sellingPrice) {
      return res.status(400).json({ error: 'masterPartId and sellingPrice required' });
    }

    const existing = await prisma.shopInventory.findUnique({
      where: { shopId_masterPartId: { shopId: req.shopId, masterPartId } },
    });
    if (existing) return res.status(409).json({ error: 'Product already in inventory', inventoryId: existing.inventoryId });

    const item = await prisma.shopInventory.create({
      data: {
        shopId:              req.shopId,
        masterPartId,
        sellingPrice:        parseFloat(sellingPrice),
        buyingPrice:         buyingPrice     ? parseFloat(buyingPrice) : null,
        stockQty:            stockQty        || 0,
        rackLocation:        rackLocation    || null,
        minStockAlert:       minStockAlert   || 5,
        maxStockLevel:       maxStockLevel   ? parseInt(maxStockLevel) : null,
        customPartName:      customPartName  || null,
        barcode:             barcode         || null,
        shopSpecificNotes:   shopSpecificNotes || null,
        isMarketplaceListed: isMarketplaceListed ?? true,
      },
      include: { masterPart: true },
    });

    // If opening stock provided, create an OPENING movement
    if (stockQty && stockQty > 0) {
      await prisma.movement.create({
        data: {
          shopId: req.shopId,
          inventoryId: item.inventoryId,
          type: 'OPENING',
          qty: parseInt(stockQty),
          unitPrice: buyingPrice ? parseFloat(buyingPrice) : null,
          notes: 'Opening stock',
        },
      });
    }

    res.json({ success: true, item });
  } catch (err) {
    next(err);
  }
});

// PUT /api/shop/inventory/:id
router.put('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      sellingPrice, buyingPrice, rackLocation,
      minStockAlert, maxStockLevel,
      customPartName, barcode,
      shopSpecificNotes, isMarketplaceListed, imageUrl,
    } = req.body;

    const inventoryId = parseInt(req.params.id);
    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const updated = await prisma.shopInventory.update({
      where: { inventoryId },
      data: {
        ...(sellingPrice       !== undefined && { sellingPrice:       parseFloat(sellingPrice) }),
        ...(buyingPrice        !== undefined && { buyingPrice:        parseFloat(buyingPrice) }),
        ...(rackLocation       !== undefined && { rackLocation }),
        ...(minStockAlert      !== undefined && { minStockAlert:      parseInt(minStockAlert) }),
        ...(maxStockLevel      !== undefined && { maxStockLevel:      maxStockLevel ? parseInt(maxStockLevel) : null }),
        ...(customPartName     !== undefined && { customPartName:     customPartName || null }),
        ...(barcode            !== undefined && { barcode:            barcode || null }),
        ...(shopSpecificNotes  !== undefined && { shopSpecificNotes:  shopSpecificNotes || null }),
        ...(isMarketplaceListed !== undefined && { isMarketplaceListed }),
        ...(imageUrl           !== undefined && { imageUrl:           imageUrl || null }),
      },
      include: { masterPart: true },
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
    });
    const currentStock = await computeStock(inventoryId);
    res.json({ movements, currentStock });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory/purchase
router.post('/purchase', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { inventoryId, partyId, notes, referenceNumber, gstRate } = req.body;
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
          partyId:         partyId         || null,
          referenceNumber: referenceNumber || null,
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
      if (unitPrice)       priceUpdates.buyingPrice  = parseFloat(unitPrice);
      if (newSellingPrice) priceUpdates.sellingPrice = parseFloat(newSellingPrice);
      if (Object.keys(priceUpdates).length > 0) {
        await tx.shopInventory.update({ where: { inventoryId }, data: priceUpdates });
      }
    });

    const newStock = await computeStock(inventoryId);
    res.json({ success: true, newStock });
  } catch (err) { next(err); }
});

// ─── GET /api/shop/inventory/low-stock ───────────────────────────────────────
// Returns all items where stockQty <= minStockAlert
router.get('/low-stock', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const items = await prisma.shopInventory.findMany({
      where: {
        shopId: req.shopId,
        // stockQty at or below alert threshold
        stockQty: { lte: prisma.shopInventory.fields.minStockAlert },
      },
      include: { masterPart: { select: { partName: true, brand: true, categoryL1: true, imageUrl: true } } },
      orderBy: { stockQty: 'asc' },
    });

    // Prisma doesn't support field-to-field comparison in where, use raw filter
    const lowStock = await prisma.$queryRaw`
      SELECT
        si.inventory_id, si.stock_qty, si.min_stock_alert, si.max_stock_level,
        si.selling_price, si.buying_price, si.rack_location, si.custom_part_name, si.barcode,
        mp.part_name, mp.brand, mp.category_l1, mp.image_url
      FROM shop_inventory si
      JOIN master_parts mp ON mp.master_part_id = si.master_part_id
      WHERE si.shop_id = ${req.shopId}
        AND si.stock_qty <= si.min_stock_alert
      ORDER BY si.stock_qty ASC
    `;

    res.json({ success: true, items: lowStock, total: lowStock.length });
  } catch (err) { next(err); }
});

// GET /api/shop/movements — all movements for this shop with product + party names
router.get('/movements', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const movements = await prisma.movement.findMany({
      where: { shopId: req.shopId },
      orderBy: { createdAt: 'desc' },
      include: {
        inventory: {
          select: {
            customPartName: true,
            masterPart: { select: { partName: true } },
          },
        },
        party: { select: { name: true, type: true } },
      },
    });
    res.json({ success: true, movements });
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
          movType = 'OPENING';
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
router.post('/adjust', authenticate, requireShopOwner, async (req, res, next) => {
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
    // is unrecoverable through the UI)
    if (qtyChange < 0 && item.stockQty + qtyChange < 0) {
      return res.status(400).json({ error: `Adjustment would make stock negative (current: ${item.stockQty})` });
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

    const newStock = await computeStock(inventoryId);
    res.json({ success: true, newStock });
  } catch (err) {
    next(err);
  }
});

// Helper: compute stock from movements ledger
async function computeStock(inventoryId) {
  const movements = await prisma.movement.findMany({ where: { inventoryId } });
  return movements.reduce((total, m) => {
    if (['PURCHASE', 'OPENING', 'RETURN_IN'].includes(m.type)) return total + m.qty;
    if (['SALE', 'RETURN_OUT', 'DAMAGE', 'THEFT'].includes(m.type)) return total - m.qty;
    // ADJUSTMENT and AUDIT: qty can be negative (downward correction) or positive (upward)
    if (m.type === 'ADJUSTMENT' || m.type === 'AUDIT') return total + m.qty;
    // RECEIPT, CREDIT_NOTE, DEBIT_NOTE: financial only — no stock change
    return total;
  }, 0);
}

export default router;
