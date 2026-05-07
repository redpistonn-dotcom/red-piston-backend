import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/shop/inventory
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const shopId = req.shopId;
    const inventory = await prisma.shopInventory.findMany({
      where: { shopId },
      include: {
        masterPart: true,
        movements: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
      orderBy: { masterPart: { partName: 'asc' } },
    });

    // Compute stock for ALL items in ONE query (avoids N+1)
    const inventoryIds = inventory.map(i => i.inventoryId);
    const allMovements = inventoryIds.length > 0
      ? await prisma.movement.findMany({ where: { inventoryId: { in: inventoryIds } } })
      : [];

    // Group movements by inventoryId and compute net stock per item
    const stockMap = {};
    for (const m of allMovements) {
      if (!stockMap[m.inventoryId]) stockMap[m.inventoryId] = 0;
      if (['PURCHASE', 'OPENING', 'RETURN_IN'].includes(m.type)) stockMap[m.inventoryId] += m.qty;
      else if (['SALE', 'RETURN_OUT', 'DAMAGE', 'THEFT'].includes(m.type)) stockMap[m.inventoryId] -= m.qty;
      else if (m.type === 'ADJUSTMENT' || m.type === 'AUDIT') stockMap[m.inventoryId] += m.qty;
    }

    const inventoryWithStock = inventory.map(item => ({
      ...item,
      computedStock: stockMap[item.inventoryId] ?? item.stockQty,
    }));

    res.json({ inventory: inventoryWithStock });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { masterPartId, sellingPrice, buyingPrice, stockQty, rackLocation, minStockAlert, isMarketplaceListed } = req.body;
    if (!masterPartId || !sellingPrice) {
      return res.status(400).json({ error: 'masterPartId and sellingPrice required' });
    }

    const existing = await prisma.shopInventory.findUnique({
      where: { shopId_masterPartId: { shopId: req.shopId, masterPartId } },
    });
    if (existing) return res.status(409).json({ error: 'Product already in inventory', inventoryId: existing.inventoryId });

    const item = await prisma.shopInventory.create({
      data: {
        shopId: req.shopId,
        masterPartId,
        sellingPrice: parseFloat(sellingPrice),
        buyingPrice: buyingPrice ? parseFloat(buyingPrice) : null,
        stockQty: stockQty || 0,
        rackLocation,
        minStockAlert: minStockAlert || 5,
        isMarketplaceListed: isMarketplaceListed || false,
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
    const { sellingPrice, buyingPrice, rackLocation, minStockAlert, isMarketplaceListed } = req.body;

    const item = await prisma.shopInventory.findUnique({
      where: { inventoryId: req.params.id },
    });
    if (!item || item.shopId !== req.shopId) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const updated = await prisma.shopInventory.update({
      where: { inventoryId: req.params.id },
      data: {
        ...(sellingPrice !== undefined && { sellingPrice: parseFloat(sellingPrice) }),
        ...(buyingPrice !== undefined && { buyingPrice: parseFloat(buyingPrice) }),
        ...(rackLocation !== undefined && { rackLocation }),
        ...(minStockAlert !== undefined && { minStockAlert: parseInt(minStockAlert) }),
        ...(isMarketplaceListed !== undefined && { isMarketplaceListed }),
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
    const item = await prisma.shopInventory.findUnique({ where: { inventoryId: req.params.id } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const movements = await prisma.movement.findMany({
      where: { inventoryId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });
    const currentStock = await computeStock(req.params.id);
    res.json({ movements, currentStock });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory/purchase
router.post('/purchase', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    // Accept buyingPrice as an alias for unitPrice (frontend sync.js sends buyingPrice)
    const { inventoryId, partyId, notes } = req.body;
    const unitPrice = req.body.unitPrice ?? req.body.buyingPrice ?? null;
    const newSellingPrice = req.body.newSellingPrice ?? null;
    const qty = parseInt(req.body.qty);
    if (!inventoryId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'inventoryId and qty (positive integer) required' });
    }

    const item = await prisma.shopInventory.findUnique({ where: { inventoryId } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const totalAmount = unitPrice ? parseFloat(unitPrice) * qty : null;

    await prisma.$transaction(async (tx) => {
      // Record movement
      await tx.movement.create({
        data: {
          shopId: req.shopId,
          inventoryId,
          type: 'PURCHASE',
          qty,
          unitPrice: unitPrice ? parseFloat(unitPrice) : null,
          totalAmount,
          partyId,
          notes,
        },
      });

      // Update cached stock
      await tx.shopInventory.update({
        where: { inventoryId },
        data: { stockQty: { increment: qty } },
      });

      // Update buying price and/or selling price if provided
      const priceUpdates = {};
      if (unitPrice) priceUpdates.buyingPrice = parseFloat(unitPrice);
      if (newSellingPrice) priceUpdates.sellingPrice = parseFloat(newSellingPrice);
      if (Object.keys(priceUpdates).length > 0) {
        await tx.shopInventory.update({ where: { inventoryId }, data: priceUpdates });
      }
    });

    const newStock = await computeStock(inventoryId);
    res.json({ success: true, newStock });
  } catch (err) {
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
        const qty     = stockQty     ? parseInt(stockQty)       : 0;
        const buyP    = buyingPrice  ? parseFloat(buyingPrice)  : null;
        const sellP   = parseFloat(sellingPrice);
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
              shopId:            req.shopId,
              masterPartId,
              sellingPrice:      sellP,
              buyingPrice:       buyP,
              stockQty:          qty,
              rackLocation:      rackLocation || null,
              minStockAlert:     minAlert,
              shopSpecificNotes: shopSpecificNotes || null,
              lastPurchasedAt:   qty > 0 ? new Date() : null,
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
    const item = await prisma.shopInventory.findUnique({ where: { inventoryId: req.params.id } });
    if (!item || item.shopId !== req.shopId) return res.status(404).json({ error: 'Item not found' });

    const { listed } = req.body; // explicit boolean, or toggle if omitted
    const newValue = listed !== undefined ? Boolean(listed) : !item.isMarketplaceListed;

    const updated = await prisma.shopInventory.update({
      where: { inventoryId: req.params.id },
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
