/**
 * purchaseOrders.js — Purchase Orders (shop buying from suppliers)
 *
 * Mounted at: /api/shop/purchase-orders
 *
 * Routes:
 *   GET    /api/shop/purchase-orders             — list POs (filterable)
 *   POST   /api/shop/purchase-orders             — create PO (default status DRAFT)
 *   GET    /api/shop/purchase-orders/:id         — get PO detail
 *   PATCH  /api/shop/purchase-orders/:id         — edit a DRAFT PO (items / qty / price / remarks)
 *   GET    /api/shop/purchase-orders/:id/pdf     — stream PO PDF for sharing with supplier
 *   PATCH  /api/shop/purchase-orders/:id/status  — advance status / mark received
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { generatePurchaseOrderPdf } from '../services/pdf.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

// Status flow: DRAFT → APPROVED → SENT → RECEIVED (PARTIAL/CANCELLED side states;
// PENDING kept for backwards compat with older rows)
const VALID_STATUSES = ['DRAFT', 'APPROVED', 'SENT', 'PENDING', 'RECEIVED', 'PARTIAL', 'CANCELLED'];

async function generatePoNumber(shopId) {
  const year = new Date().getFullYear();
  const counterKey = `po-${year}`;
  // Atomic upsert — concurrent saves each get a unique sequence value.
  const counter = await prisma.numberCounter.upsert({
    where:  { shopId_counterKey: { shopId, counterKey } },
    update: { lastValue: { increment: 1 } },
    create: { shopId, counterKey, lastValue: 1 },
    select: { lastValue: true },
  });
  return `PO-${year}-${String(counter.lastValue).padStart(3, '0')}`;
}

// Validate raw items against shop inventory and compute GST-split totals
async function buildPoItems(items, shopId) {
  let subtotal = 0, totalCgst = 0, totalSgst = 0;
  const processedItems = [];

  for (const item of items) {
    const inv = await prisma.shopInventory.findUnique({
      where: { inventoryId: parseInt(item.inventoryId) },
      include: { masterPart: true },
    });
    if (!inv || inv.shopId !== shopId) {
      const err = new Error(`Invalid inventory item: ${item.inventoryId}`);
      err.code = 'INVALID_ITEM';
      throw err;
    }

    const qty = parseInt(item.orderedQty || item.qty || 1);
    const unitPrice = parseFloat(item.unitPrice || inv.buyingPrice || 0);
    const gstRate = parseFloat(item.gstRate || inv.masterPart.gstRate || 18);
    const taxableAmt = unitPrice * qty;
    const itemCgst = taxableAmt * (gstRate / 2 / 100);
    const itemSgst = itemCgst;
    const total = taxableAmt + itemCgst + itemSgst;

    subtotal += taxableAmt;
    totalCgst += itemCgst;
    totalSgst += itemSgst;

    processedItems.push({
      inventoryId: inv.inventoryId,
      partName: inv.masterPart.partName,
      hsnCode: inv.masterPart.hsnCode || null,
      orderedQty: qty,
      unitPrice,
      taxableAmt,
      gstRate,
      cgst: itemCgst,
      sgst: itemSgst,
      total,
    });
  }

  return { processedItems, subtotal, totalCgst, totalSgst };
}

// GET /api/shop/purchase-orders
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status, partyId, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };
    if (status) where.status = status;
    if (partyId) where.partyId = parseInt(partyId);

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: { items: true, party: { select: { name: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    res.json({ success: true, data: orders, total });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/purchase-orders/supplier-products/:partyId
// Inventory ids previously bought from this supplier (purchase movements + past PO items).
// Used to pre-filter the PO item picker to the supplier's linked products.
router.get('/supplier-products/:partyId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const partyId = parseInt(req.params.partyId);

    // Look up the party's name so we can also match movements that were recorded
    // with a supplier name string but no partyId FK (the common case for POS/stock-in purchases).
    const party = await prisma.party.findUnique({ where: { partyId }, select: { name: true } });
    const partyName = party?.name || null;

    const [movementsById, movementsByName, poItems] = await Promise.all([
      // Movements explicitly linked via partyId FK
      prisma.movement.findMany({
        where: { shopId: req.shopId, partyId, type: 'PURCHASE' },
        select: { inventoryId: true },
        distinct: ['inventoryId'],
      }),
      // Movements where supplier name was stored as text (no FK set) — case-insensitive match
      partyName ? prisma.movement.findMany({
        where: { shopId: req.shopId, partyId: null, type: 'PURCHASE', partyName: { equals: partyName, mode: 'insensitive' } },
        select: { inventoryId: true },
        distinct: ['inventoryId'],
      }) : [],
      // Past PO items for this supplier
      prisma.purchaseOrderItem.findMany({
        where: { purchaseOrder: { shopId: req.shopId, partyId } },
        select: { inventoryId: true },
        distinct: ['inventoryId'],
      }),
    ]);

    const ids = [...new Set([...movementsById, ...movementsByName, ...poItems]
      .map(r => r.inventoryId).filter(Boolean))];
    res.json({ success: true, inventoryIds: ids });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/purchase-orders — creates a DRAFT PO (supplier is mandatory)
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      partyId, supplierName, supplierPhone, supplierGstin,
      paymentMode, expectedAt, notes, items,
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_ITEMS', message: 'At least one item is required' },
      });
    }
    if (!partyId && !supplierName) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_SUPPLIER', message: 'A supplier must be selected before generating a PO' },
      });
    }

    let processedItems, subtotal, totalCgst, totalSgst;
    try {
      ({ processedItems, subtotal, totalCgst, totalSgst } = await buildPoItems(items, req.shopId));
    } catch (e) {
      if (e.code === 'INVALID_ITEM') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_ITEM', message: e.message } });
      }
      throw e;
    }

    const totalAmount = subtotal + totalCgst + totalSgst;
    const poNumber = await generatePoNumber(req.shopId);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        shopId: req.shopId,
        createdBy: req.user.userId,
        partyId: partyId ? parseInt(partyId) : null,
        supplierName: supplierName || null,
        supplierPhone: supplierPhone || null,
        supplierGstin: supplierGstin || null,
        subtotal,
        taxableAmount: subtotal,
        cgst: totalCgst,
        sgst: totalSgst,
        totalAmount,
        status: 'DRAFT',
        paymentMode: paymentMode || null,
        expectedAt: expectedAt ? new Date(expectedAt) : null,
        notes: notes || null,
        items: { create: processedItems },
      },
      include: { items: true, party: { select: { name: true, phone: true, gstin: true } } },
    });

    writeAudit(req, {
      entityType: ET.ORDER,
      entityId:   po.poId,
      action:     ACT.CREATE,
      newValue:   { poNumber, supplierId: partyId || null, itemCount: po.items.length, totalAmount },
    });

    res.status(201).json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/purchase-orders/:id — edit a DRAFT PO (replace items, update remarks)
router.patch('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const { items, notes, expectedAt } = req.body;

    const po = await prisma.purchaseOrder.findFirst({ where: { poId, shopId: req.shopId } });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    if (po.status !== 'DRAFT') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_EDITABLE', message: `Only DRAFT purchase orders can be edited (current: ${po.status})` },
      });
    }

    const data = {};
    if (notes !== undefined) data.notes = notes || null;
    if (expectedAt !== undefined) data.expectedAt = expectedAt ? new Date(expectedAt) : null;

    if (items && items.length > 0) {
      let processedItems, subtotal, totalCgst, totalSgst;
      try {
        ({ processedItems, subtotal, totalCgst, totalSgst } = await buildPoItems(items, req.shopId));
      } catch (e) {
        if (e.code === 'INVALID_ITEM') {
          return res.status(400).json({ success: false, error: { code: 'INVALID_ITEM', message: e.message } });
        }
        throw e;
      }
      data.subtotal = subtotal;
      data.taxableAmount = subtotal;
      data.cgst = totalCgst;
      data.sgst = totalSgst;
      data.totalAmount = subtotal + totalCgst + totalSgst;
      data.items = { deleteMany: {}, create: processedItems };
    }

    const updated = await prisma.purchaseOrder.update({
      where: { poId },
      data,
      include: { items: true, party: { select: { name: true, phone: true, gstin: true } } },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/purchase-orders/:id/pdf — stream PO PDF (for sharing with supplier)
router.get('/:id/pdf', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const po = await prisma.purchaseOrder.findFirst({
      where: { poId, shopId: req.shopId },
      include: {
        items: true,
        party: { select: { name: true, phone: true, gstin: true, address: true } },
        shop: { select: { name: true, address: true, city: true, gstin: true } },
      },
    });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    const pdfBuffer = await generatePurchaseOrderPdf(po);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${po.poNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/purchase-orders/:id
router.get('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const po = await prisma.purchaseOrder.findFirst({
      where: { poId: parseInt(req.params.id), shopId: req.shopId },
      include: {
        items: { include: { inventory: { include: { masterPart: true } } } },
        party: { select: { name: true, phone: true, gstin: true } },
      },
    });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    res.json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/shop/purchase-orders/:id/status
// Also handles marking items as received (partial or full) and creating stock movements
router.patch('/:id/status', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const { status, receivedItems } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      });
    }

    const po = await prisma.purchaseOrder.findFirst({
      where: { poId, shopId: req.shopId },
      include: { items: true },
    });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }

    await prisma.$transaction(async (tx) => {
      // If receiving stock, update per-item receivedQty and create PURCHASE movements
      if ((status === 'RECEIVED' || status === 'PARTIAL') && receivedItems?.length) {
        for (const ri of receivedItems) {
          const poItem = po.items.find(i => i.itemId === ri.itemId);
          if (!poItem) continue;

          const qty = parseInt(ri.receivedQty || 0);
          if (qty <= 0) continue;

          await tx.purchaseOrderItem.update({
            where: { itemId: ri.itemId },
            data: { receivedQty: { increment: qty } },
          });

          await tx.movement.create({
            data: {
              shopId: req.shopId,
              inventoryId: poItem.inventoryId,
              type: 'PURCHASE',
              qty,
              unitPrice: parseFloat(poItem.unitPrice),
              totalAmount: parseFloat(poItem.unitPrice) * qty,
              partyId: po.partyId || null,
            },
          });

          await tx.shopInventory.update({
            where: { inventoryId: poItem.inventoryId },
            data: { stockQty: { increment: qty } },
          });
        }
      }

      await tx.purchaseOrder.update({
        where: { poId },
        data: {
          status,
          receivedAt: status === 'RECEIVED' ? new Date() : undefined,
        },
      });
    });

    const updated = await prisma.purchaseOrder.findUnique({
      where: { poId },
      include: { items: true },
    });

    // Audit the status transition
    const actionMap = {
      APPROVED:  ACT.APPROVE,
      SENT:      ACT.UPDATE,
      RECEIVED:  ACT.PURCHASE,
      PARTIAL:   ACT.UPDATE,
      CANCELLED: ACT.REJECT,
    };
    writeAudit(req, {
      entityType: ET.ORDER,
      entityId:   poId,
      action:     actionMap[status] || ACT.UPDATE,
      newValue:   { status, poNumber: po.poNumber },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
