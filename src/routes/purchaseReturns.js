/**
 * purchaseReturns.js — Supplier Return engine
 *
 * Mounted at: /api/shop/purchase-returns
 *
 * GET   /bill/:billId/eligible-items   what on this bill can still be returned
 * POST  /                              create a purchase return (decrements stock, reverses ITC)
 * GET   /                              list returns (paginated)
 * GET   /:id                           single return detail
 * PATCH /:id/resolution                update resolution once the supplier responds (days/weeks later)
 *
 * PurchaseBill has no structured line-item table (only a raw `extracted` JSON blob),
 * so returnable lines are derived from the Movement rows that bill-import already
 * wrote (type PURCHASE/OPENING, matched by referenceNumber = bill.invoiceNumber).
 * No credit-note engine here — the supplier's own credit note is just a reference
 * string; the shop isn't issuing a GST document to itself for a purchase return.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';
import { runSerializable } from '../lib/serializable-tx.js';
import { nextSeq } from '../lib/sequence.js';
import { financialYearKey } from '../lib/gst-fy.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

const VALID_REASONS     = ['DAMAGED', 'WRONG_ITEM', 'EXCESS_SUPPLY', 'QUALITY_ISSUE'];
const VALID_RESOLUTIONS = ['PENDING', 'SUPPLIER_REFUND', 'SUPPLIER_CREDIT', 'REPLACEMENT'];
const SOURCE_TYPES      = ['PURCHASE', 'OPENING'];

// ─── GET /bill/:billId/eligible-items ──────────────────────────────────────────
router.get('/bill/:billId/eligible-items', authenticate, requireShopOwner, requirePermission('purchase.view'), async (req, res, next) => {
  try {
    const billId = parseInt(req.params.billId, 10);
    if (!Number.isFinite(billId)) return res.status(400).json({ success: false, error: { message: 'Invalid bill id' } });

    const bill = await prisma.purchaseBill.findFirst({ where: { billId, shopId: req.shopId } });
    if (!bill) return res.status(404).json({ success: false, error: { message: 'Bill not found' } });
    if (!bill.invoiceNumber) {
      return res.status(400).json({ success: false, error: { message: 'This bill has no invoice number to match receiving movements against' } });
    }

    const sourceMovements = await prisma.movement.findMany({
      where: { shopId: req.shopId, referenceNumber: bill.invoiceNumber, type: { in: SOURCE_TYPES } },
      include: { inventory: { include: { masterPart: { select: { partName: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    if (sourceMovements.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'This bill has not been imported into inventory yet' } });
    }

    const movementIds = sourceMovements.map(m => m.movementId);
    const returnedByMovement = await prisma.purchaseReturnItem.groupBy({
      by: ['sourceMovementId'],
      where: { sourceMovementId: { in: movementIds } },
      _sum: { qty: true },
    });
    const returnedMap = new Map(returnedByMovement.map(r => [r.sourceMovementId, r._sum.qty || 0]));

    const items = sourceMovements.map(m => {
      const qtyReturned = returnedMap.get(m.movementId) || 0;
      return {
        sourceMovementId: m.movementId,
        inventoryId:      m.inventoryId,
        partName:         m.inventory?.masterPart?.partName || 'Unknown Part',
        unitPrice:        Number(m.unitPrice || 0),
        gstRate:          Number(m.gstRate || 0),
        qtyReceived:      m.qty,
        qtyReturned,
        qtyReturnable:    m.qty - qtyReturned,
      };
    });

    res.json({
      success: true,
      bill: { billId: bill.billId, invoiceNumber: bill.invoiceNumber, supplierName: bill.supplierName, supplierGstin: bill.supplierGstin, createdAt: bill.createdAt },
      items,
    });
  } catch (err) { next(err); }
});

// ─── POST / — create a purchase return ─────────────────────────────────────────
router.post('/', authenticate, requireShopOwner, requirePermission('purchase.create'), async (req, res, next) => {
  try {
    const { originalBillId, items, reason, resolution, supplierCreditNoteNo, partyId, notes } = req.body;

    if (!Number.isFinite(Number(originalBillId))) {
      return res.status(400).json({ success: false, error: { message: 'originalBillId is required' } });
    }
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, error: { message: `reason must be one of: ${VALID_REASONS.join(', ')}` } });
    }
    const resolvedResolution = resolution && VALID_RESOLUTIONS.includes(resolution) ? resolution : 'PENDING';
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'At least one item is required' } });
    }
    for (const it of items) {
      if (!Number.isFinite(Number(it.sourceMovementId)) || !Number.isInteger(Number(it.qty)) || Number(it.qty) <= 0) {
        return res.status(400).json({ success: false, error: { message: 'Each item needs a valid sourceMovementId and a positive integer qty' } });
      }
    }

    const billId = parseInt(originalBillId, 10);
    const bill = await prisma.purchaseBill.findFirst({ where: { billId, shopId: req.shopId } });
    if (!bill) return res.status(404).json({ success: false, error: { message: 'Original purchase bill not found' } });

    const movementIds = items.map(it => parseInt(it.sourceMovementId, 10));
    const sourceMovements = await prisma.movement.findMany({
      where: { movementId: { in: movementIds }, shopId: req.shopId, referenceNumber: bill.invoiceNumber, type: { in: SOURCE_TYPES } },
    });
    const movementMap = new Map(sourceMovements.map(m => [m.movementId, m]));
    for (const id of movementIds) {
      if (!movementMap.has(id)) {
        return res.status(400).json({ success: false, error: { message: `Movement ${id} does not belong to bill ${bill.invoiceNumber}` } });
      }
    }

    if (partyId) {
      const party = await prisma.party.findFirst({ where: { partyId: parseInt(partyId, 10), shopId: req.shopId } });
      if (!party) return res.status(400).json({ success: false, error: { message: 'Party not found' } });
    }

    const result = await runSerializable(async (tx) => {
      const itemsData = [];

      for (const it of items) {
        const sourceMovementId = parseInt(it.sourceMovementId, 10);
        const qty = parseInt(it.qty, 10);
        const movement = movementMap.get(sourceMovementId);

        // Re-check "already returned" inside the Serializable transaction — closes the
        // race where two concurrent requests both read "0 returned" against the same movement.
        const priorSum = await tx.purchaseReturnItem.aggregate({
          where: { sourceMovementId },
          _sum: { qty: true },
        });
        const alreadyReturned = priorSum._sum.qty || 0;
        const returnable = movement.qty - alreadyReturned;
        if (qty > returnable) {
          throw { status: 400, message: `Cannot return ${qty} units against movement ${sourceMovementId} — only ${returnable} left returnable` };
        }

        const unitPrice = Number(movement.unitPrice || 0);
        const gstRate    = Number(movement.gstRate || 0);
        const taxableValue = unitPrice * qty;
        const itemCgst = taxableValue * (gstRate / 2 / 100);
        const itemSgst = itemCgst;

        itemsData.push({
          inventoryId: movement.inventoryId,
          sourceMovementId,
          qty,
          unitPrice: movement.unitPrice,
          taxableValue,
          gstRate,
          cgst: itemCgst,
          sgst: itemSgst,
        });
      }

      const fy = financialYearKey(new Date());
      const seq = await nextSeq(tx, req.shopId, `PR-${fy}`);
      const returnNo = `PR-S${req.shopId}-${fy}-${String(seq).padStart(5, '0')}`;

      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          returnNo,
          shopId:         req.shopId,
          originalBillId: billId,
          partyId:        partyId ? parseInt(partyId, 10) : null,
          supplierName:   bill.supplierName,
          supplierGstin:  bill.supplierGstin,
          reason,
          resolution:     resolvedResolution,
          supplierCreditNoteNo: supplierCreditNoteNo || null,
          notes:          notes || null,
          createdBy:      req.user.userId,
          items: { create: itemsData },
        },
        include: { items: true },
      });

      // ── Stock leaves the shop; ITC is reversed for the same qty/period ───────
      for (const item of purchaseReturn.items) {
        const deducted = await tx.shopInventory.updateMany({
          where: { inventoryId: item.inventoryId, stockQty: { gte: item.qty } },
          data:  { stockQty: { decrement: item.qty } },
        });
        if (deducted.count === 0) {
          throw { status: 400, message: `Insufficient stock to return ${item.qty} units — some may have already been sold` };
        }

        await tx.movement.create({
          data: {
            shopId:          req.shopId,
            inventoryId:     item.inventoryId,
            type:            'PURCHASE_RETURN_OUT',
            qty:             item.qty,
            unitPrice:       item.unitPrice,
            gstRate:         item.gstRate,
            taxableAmount:   item.taxableValue,
            totalAmount:     Number(item.taxableValue) + Number(item.cgst) + Number(item.sgst),
            gstAmount:       Number(item.cgst) + Number(item.sgst),
            partyId:         partyId ? parseInt(partyId, 10) : null,
            partyName:       bill.supplierName,
            referenceNumber: returnNo,
            invoiceNumber:   bill.invoiceNumber,
            notes:           reason,
            correlationId:   returnNo,
            createdBy:       req.user.userId,
          },
        });
      }

      return { purchaseReturn, returnNo };
    });

    writeAudit(req, {
      entityType: ET.BILL, entityId: result.purchaseReturn.returnId, action: ACT.CREATE,
      newValue: { returnNo: result.returnNo, reason, resolution: resolvedResolution, billId },
    });

    res.status(201).json({ success: true, purchaseReturn: result.purchaseReturn });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: { message: err.message } });
    next(err);
  }
});

// ─── GET / — list purchase returns ─────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, requirePermission('purchase.view'), async (req, res, next) => {
  try {
    const { reason, resolution, partyId, from, to } = req.query;
    const where = { shopId: req.shopId };
    if (reason && VALID_REASONS.includes(reason)) where.reason = reason;
    if (resolution && VALID_RESOLUTIONS.includes(resolution)) where.resolution = resolution;
    if (partyId) where.partyId = parseInt(partyId, 10);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

    const [returns, total] = await Promise.all([
      prisma.purchaseReturn.findMany({
        where,
        include: { items: true, bill: { select: { invoiceNumber: true } } },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.purchaseReturn.count({ where }),
    ]);

    res.json({ success: true, returns, total, limit, offset });
  } catch (err) { next(err); }
});

// ─── GET /:id — single return detail ────────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, requirePermission('purchase.view'), async (req, res, next) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    const purchaseReturn = await prisma.purchaseReturn.findFirst({
      where: { returnId, shopId: req.shopId },
      include: {
        items: { include: { inventory: { include: { masterPart: { select: { partName: true } } } } } },
        bill:  { select: { invoiceNumber: true, createdAt: true, supplierName: true } },
      },
    });
    if (!purchaseReturn) return res.status(404).json({ success: false, error: { message: 'Return not found' } });
    res.json({ success: true, purchaseReturn });
  } catch (err) { next(err); }
});

// ─── PATCH /:id/resolution — update resolution once the supplier responds ─────
router.patch('/:id/resolution', authenticate, requireShopOwner, requirePermission('purchase.create'), async (req, res, next) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    const { resolution, supplierCreditNoteNo, version } = req.body;
    if (!VALID_RESOLUTIONS.includes(resolution)) {
      return res.status(400).json({ success: false, error: { message: `resolution must be one of: ${VALID_RESOLUTIONS.join(', ')}` } });
    }
    if (!Number.isInteger(Number(version))) {
      return res.status(400).json({ success: false, error: { message: 'version is required for optimistic concurrency' } });
    }

    const updated = await prisma.purchaseReturn.updateMany({
      where: { returnId, shopId: req.shopId, version: parseInt(version, 10) },
      data:  { resolution, supplierCreditNoteNo: supplierCreditNoteNo || undefined, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      return res.status(409).json({ success: false, error: { message: 'This return was updated elsewhere — reload and try again' } });
    }

    const purchaseReturn = await prisma.purchaseReturn.findUnique({ where: { returnId } });
    writeAudit(req, { entityType: ET.BILL, entityId: returnId, action: ACT.UPDATE, newValue: { resolution, supplierCreditNoteNo } });
    res.json({ success: true, purchaseReturn });
  } catch (err) { next(err); }
});

export default router;
