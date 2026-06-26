import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/shop/inventory/:inventoryId/batches
// List all stock batches for a product, newest first.
router.get('/:inventoryId/batches', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const inventoryId = parseInt(req.params.inventoryId);
    if (!Number.isFinite(inventoryId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid inventoryId' } });
    }

    // Verify the inventory item belongs to this shop
    const inv = await prisma.shopInventory.findFirst({
      where: { inventoryId, shopId: req.shopId },
      select: { inventoryId: true },
    });
    if (!inv) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Inventory item not found' } });
    }

    const batches = await prisma.stockBatch.findMany({
      where: { inventoryId, shopId: req.shopId },
      orderBy: { receivedDate: 'desc' },
    });

    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/inventory/:inventoryId/batches
// Manually create a batch when adding stock.
// Body: { batchNumber?, serialNumber?, qtyReceived, costPrice, supplierName?, partyId?, expiryDate?, notes? }
router.post('/:inventoryId/batches', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const inventoryId = parseInt(req.params.inventoryId);
    if (!Number.isFinite(inventoryId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid inventoryId' } });
    }

    const { batchNumber, serialNumber, qtyReceived, costPrice, supplierName, partyId, expiryDate, notes } = req.body;

    if (qtyReceived == null || parseInt(qtyReceived) <= 0) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_QTY', message: 'qtyReceived must be a positive integer' } });
    }
    if (costPrice == null || parseFloat(costPrice) < 0) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PRICE', message: 'costPrice must be a non-negative number' } });
    }

    // Verify the inventory item belongs to this shop
    const inv = await prisma.shopInventory.findFirst({
      where: { inventoryId, shopId: req.shopId },
      select: { inventoryId: true },
    });
    if (!inv) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Inventory item not found' } });
    }

    const qty = parseInt(qtyReceived);
    const batch = await prisma.stockBatch.create({
      data: {
        shopId:       req.shopId,
        inventoryId,
        batchNumber:  batchNumber  || null,
        serialNumber: serialNumber || null,
        qtyReceived:  qty,
        qtyRemaining: qty,
        costPrice:    parseFloat(costPrice),
        supplierName: supplierName || null,
        partyId:      partyId ? parseInt(partyId) : null,
        expiryDate:   expiryDate ? new Date(expiryDate) : null,
        notes:        notes || null,
      },
    });

    res.status(201).json({ success: true, data: batch });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/batches?search=&from=&to=
// Search batches by batchNumber or serialNumber (case-insensitive).
// Mounted separately at /api/shop/inventory so path becomes /api/shop/inventory/batches
// but we need a distinct path — see registration in index.js.
router.get('/batches', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { search, from, to } = req.query;

    const where = { shopId: req.shopId };

    if (search) {
      where.OR = [
        { batchNumber:  { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (from || to) {
      where.receivedDate = {};
      if (from) where.receivedDate.gte = new Date(from);
      if (to)   where.receivedDate.lte = new Date(to);
    }

    const batches = await prisma.stockBatch.findMany({
      where,
      orderBy: { receivedDate: 'desc' },
      take: 200,
    });

    res.json({ success: true, data: batches });
  } catch (err) {
    next(err);
  }
});

export default router;
