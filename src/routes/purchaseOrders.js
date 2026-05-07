/**
 * purchaseOrders.js — Purchase Orders (shop buying from suppliers)
 *
 * Mounted at: /api/shop/purchase-orders
 *
 * Routes:
 *   GET    /api/shop/purchase-orders             — list POs (filterable)
 *   POST   /api/shop/purchase-orders             — create PO
 *   GET    /api/shop/purchase-orders/:id         — get PO detail
 *   PATCH  /api/shop/purchase-orders/:id/status  — update PO status / mark received
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

const VALID_STATUSES = ['PENDING', 'RECEIVED', 'PARTIAL', 'CANCELLED'];

async function generatePoNumber(shopId) {
  const now = new Date();
  const prefix = `PO-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const last = await prisma.purchaseOrder.findFirst({
    where: { shopId, poNumber: { startsWith: prefix } },
    orderBy: { poNumber: 'desc' },
  });
  const seq = last ? parseInt(last.poNumber.split('-')[2]) + 1 : 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

// GET /api/shop/purchase-orders
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status, partyId, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };
    if (status) where.status = status;
    if (partyId) where.partyId = partyId;

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

// POST /api/shop/purchase-orders
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

    // Validate inventory items belong to this shop and compute totals
    let subtotal = 0, totalCgst = 0, totalSgst = 0;
    const processedItems = [];

    for (const item of items) {
      const inv = await prisma.shopInventory.findUnique({
        where: { inventoryId: item.inventoryId },
        include: { masterPart: true },
      });
      if (!inv || inv.shopId !== req.shopId) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_ITEM', message: `Invalid inventory item: ${item.inventoryId}` },
        });
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
        inventoryId: item.inventoryId,
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

    const taxableAmount = subtotal;
    const totalAmount = subtotal + totalCgst + totalSgst;
    const poNumber = await generatePoNumber(req.shopId);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        shopId: req.shopId,
        createdBy: req.user.userId,
        partyId: partyId || null,
        supplierName: supplierName || null,
        supplierPhone: supplierPhone || null,
        supplierGstin: supplierGstin || null,
        subtotal,
        taxableAmount,
        cgst: totalCgst,
        sgst: totalSgst,
        totalAmount,
        paymentMode: paymentMode || null,
        expectedAt: expectedAt ? new Date(expectedAt) : null,
        notes: notes || null,
        items: { create: processedItems },
      },
      include: { items: true },
    });

    res.status(201).json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/purchase-orders/:id
router.get('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const po = await prisma.purchaseOrder.findFirst({
      where: { poId: req.params.id, shopId: req.shopId },
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
    const { status, receivedItems } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      });
    }

    const po = await prisma.purchaseOrder.findFirst({
      where: { poId: req.params.id, shopId: req.shopId },
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
        where: { poId: req.params.id },
        data: {
          status,
          receivedAt: status === 'RECEIVED' ? new Date() : undefined,
        },
      });
    });

    const updated = await prisma.purchaseOrder.findUnique({
      where: { poId: req.params.id },
      include: { items: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
