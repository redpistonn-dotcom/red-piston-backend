/**
 * purchaseOrders.js — Purchase Orders (shop buying from suppliers)
 *
 * Mounted at: /api/shop/purchase-orders
 *
 * Routes:
 *   GET    /                              — list POs (filterable)
 *   POST   /                              — create PO (default status DRAFT)
 *   GET    /:id                           — get PO detail
 *   PATCH  /:id                           — edit a DRAFT PO (items / qty / price / freight / remarks)
 *   GET    /:id/pdf                       — stream PO PDF
 *   PATCH  /:id/status                    — advance status (enforced transitions)
 *   POST   /:id/clone                     — duplicate any PO as a new DRAFT
 *   PATCH  /:id/link-bill                 — link / unlink a purchase bill to this PO
 *   GET    /supplier-products/:partyId    — inventory ids bought from this supplier
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { generatePurchaseOrderPdf } from '../services/pdf.js';
import { sendPurchaseOrderEmail } from '../services/email.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

const VALID_STATUSES = ['DRAFT', 'APPROVED', 'SENT', 'PENDING', 'RECEIVED', 'PARTIAL', 'CANCELLED'];

// Enforced state machine — only these transitions are legal.
// PENDING is kept for backwards-compat with older rows (same rules as SENT).
const VALID_TRANSITIONS = {
  DRAFT:     ['APPROVED', 'CANCELLED'],
  APPROVED:  ['SENT', 'CANCELLED'],
  SENT:      ['RECEIVED', 'PARTIAL', 'CANCELLED'],
  PARTIAL:   ['RECEIVED', 'CANCELLED'],
  PENDING:   ['RECEIVED', 'PARTIAL', 'CANCELLED'],
  RECEIVED:  [],
  CANCELLED: [],
};

async function generatePoNumber(shopId) {
  const year = new Date().getFullYear();
  const counterKey = `po-${year}`;
  const counter = await prisma.numberCounter.upsert({
    where:  { shopId_counterKey: { shopId, counterKey } },
    update: { lastValue: { increment: 1 } },
    create: { shopId, counterKey, lastValue: 1 },
    select: { lastValue: true },
  });
  return `PO-${year}-${String(counter.lastValue).padStart(3, '0')}`;
}

// Validate items against shop inventory and compute GST-split totals.
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

    const qty        = parseInt(item.orderedQty || item.qty || 1);
    const unitPrice  = parseFloat(item.unitPrice || inv.buyingPrice || 0);
    const gstRate    = parseFloat(item.gstRate || inv.masterPart?.gstRate || 18);
    const taxableAmt = unitPrice * qty;
    const itemCgst   = taxableAmt * (gstRate / 2 / 100);
    const itemSgst   = itemCgst;
    const total      = taxableAmt + itemCgst + itemSgst;

    subtotal  += taxableAmt;
    totalCgst += itemCgst;
    totalSgst += itemSgst;

    processedItems.push({
      inventoryId: inv.inventoryId,
      partName:    inv.masterPart?.partName || inv.partName || 'Unknown Part',
      hsnCode:     inv.masterPart?.hsnCode || null,
      orderedQty:  qty,
      unitPrice,
      taxableAmt,
      gstRate,
      cgst:  itemCgst,
      sgst:  itemSgst,
      total,
    });
  }

  return { processedItems, subtotal, totalCgst, totalSgst };
}

const PO_INCLUDE_LIST = {
  items: true,
  party: { select: { name: true, phone: true, email: true } },
  linkedBill: { select: { billId: true, invoiceNumber: true, status: true } },
};

const PO_INCLUDE_DETAIL = {
  items: { include: { inventory: { include: { masterPart: true } } } },
  party: { select: { name: true, phone: true, email: true, gstin: true } },
  linkedBill: { select: { billId: true, invoiceNumber: true, supplierName: true, grandTotal: true, status: true } },
};

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { status, partyId, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };
    if (status)  where.status  = status;
    if (partyId) where.partyId = parseInt(partyId);

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include:  PO_INCLUDE_LIST,
        orderBy:  { createdAt: 'desc' },
        take:     parseInt(limit),
        skip:     parseInt(offset),
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    res.json({ success: true, data: orders, total });
  } catch (err) {
    next(err);
  }
});

// ── GET /supplier-products/:partyId ──────────────────────────────────────────
router.get('/supplier-products/:partyId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const partyId   = parseInt(req.params.partyId);
    const party     = await prisma.party.findUnique({ where: { partyId }, select: { name: true } });
    const partyName = party?.name || null;

    const [movementsById, movementsByName, poItems] = await Promise.all([
      prisma.movement.findMany({
        where: { shopId: req.shopId, partyId, type: 'PURCHASE' },
        select: { inventoryId: true },
        distinct: ['inventoryId'],
      }),
      partyName ? prisma.movement.findMany({
        where: { shopId: req.shopId, partyId: null, type: 'PURCHASE', partyName: { equals: partyName, mode: 'insensitive' } },
        select: { inventoryId: true },
        distinct: ['inventoryId'],
      }) : [],
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

// ── GET /price-history/:partyId ──────────────────────────────────────────────
// Returns last 5 ordered prices per inventoryId for this supplier.
// Excludes DRAFT and CANCELLED POs so only confirmed orders count.
router.get('/price-history/:partyId', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const partyId = parseInt(req.params.partyId);

    const items = await prisma.purchaseOrderItem.findMany({
      where: {
        purchaseOrder: {
          shopId: req.shopId,
          partyId,
          status: { notIn: ['DRAFT', 'CANCELLED'] },
        },
      },
      select: {
        inventoryId: true,
        unitPrice:   true,
        orderedQty:  true,
        purchaseOrder: { select: { poNumber: true, createdAt: true } },
      },
      orderBy: { purchaseOrder: { createdAt: 'desc' } },
    });

    // Group by inventoryId, keep 5 most-recent per item (list is already desc-sorted)
    const grouped = {};
    for (const item of items) {
      const id = item.inventoryId;
      if (!id) continue;
      if (!grouped[id]) grouped[id] = [];
      if (grouped[id].length < 5) {
        grouped[id].push({
          price:    parseFloat(item.unitPrice),
          qty:      item.orderedQty,
          date:     item.purchaseOrder.createdAt,
          poNumber: item.purchaseOrder.poNumber,
        });
      }
    }

    res.json({ success: true, data: grouped });
  } catch (err) {
    next(err);
  }
});

// ── POST / ───────────────────────────────────────────────────────────────────
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      partyId, supplierName, supplierPhone, supplierGstin,
      paymentMode, expectedAt, notes, items,
      freight = 0, otherCharges = 0,
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

    const freightAmt      = parseFloat(freight)      || 0;
    const otherChargesAmt = parseFloat(otherCharges) || 0;
    const totalAmount     = subtotal + totalCgst + totalSgst + freightAmt + otherChargesAmt;
    const poNumber        = await generatePoNumber(req.shopId);

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        shopId:        req.shopId,
        createdBy:     req.user.userId,
        partyId:       partyId ? parseInt(partyId) : null,
        supplierName:  supplierName || null,
        supplierPhone: supplierPhone || null,
        supplierGstin: supplierGstin || null,
        subtotal,
        taxableAmount: subtotal,
        cgst:          totalCgst,
        sgst:          totalSgst,
        freight:       freightAmt,
        otherCharges:  otherChargesAmt,
        totalAmount,
        status:        'DRAFT',
        paymentMode:   paymentMode || null,
        expectedAt:    expectedAt ? new Date(expectedAt) : null,
        notes:         notes || null,
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

// ── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const po = await prisma.purchaseOrder.findFirst({
      where:   { poId: parseInt(req.params.id), shopId: req.shopId },
      include: PO_INCLUDE_DETAIL,
    });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    res.json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ───────────────────────────────────────────────────────────────
router.patch('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const { items, notes, expectedAt, freight, otherCharges } = req.body;

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
    if (notes        !== undefined) data.notes        = notes || null;
    if (expectedAt   !== undefined) data.expectedAt   = expectedAt ? new Date(expectedAt) : null;
    if (freight      !== undefined) data.freight      = parseFloat(freight)      || 0;
    if (otherCharges !== undefined) data.otherCharges = parseFloat(otherCharges) || 0;

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
      const newFreight      = data.freight      ?? parseFloat(po.freight)      ?? 0;
      const newOtherCharges = data.otherCharges ?? parseFloat(po.otherCharges) ?? 0;
      data.subtotal      = subtotal;
      data.taxableAmount = subtotal;
      data.cgst          = totalCgst;
      data.sgst          = totalSgst;
      data.totalAmount   = subtotal + totalCgst + totalSgst + newFreight + newOtherCharges;
      data.items         = { deleteMany: {}, create: processedItems };
    } else if (freight !== undefined || otherCharges !== undefined) {
      // Re-compute totalAmount when only surcharges change (no item update)
      const newFreight      = data.freight      ?? parseFloat(po.freight)      ?? 0;
      const newOtherCharges = data.otherCharges ?? parseFloat(po.otherCharges) ?? 0;
      data.totalAmount = parseFloat(po.subtotal) + parseFloat(po.cgst) + parseFloat(po.sgst)
                         + newFreight + newOtherCharges;
    }

    const updated = await prisma.purchaseOrder.update({
      where:   { poId },
      data,
      include: PO_INCLUDE_DETAIL,
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id/pdf ──────────────────────────────────────────────────────────────
router.get('/:id/pdf', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const po   = await prisma.purchaseOrder.findFirst({
      where: { poId, shopId: req.shopId },
      include: {
        items: true,
        party: { select: { name: true, phone: true, gstin: true, address: true } },
        shop:  { select: { name: true, address: true, city: true, gstin: true } },
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

// ── PATCH /:id/status ─────────────────────────────────────────────────────────
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
      where:   { poId, shopId: req.shopId },
      include: { items: true },
    });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }

    const allowed = VALID_TRANSITIONS[po.status] ?? [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `Cannot move from ${po.status} to ${status}. Allowed next: ${allowed.join(', ') || 'none (terminal state)'}`,
        },
      });
    }

    await prisma.$transaction(async (tx) => {
      if ((status === 'RECEIVED' || status === 'PARTIAL') && receivedItems?.length) {
        for (const ri of receivedItems) {
          const poItem = po.items.find(i => i.itemId === ri.itemId);
          if (!poItem) continue;

          const qty = parseInt(ri.receivedQty || 0);
          if (qty <= 0) continue;

          await tx.purchaseOrderItem.update({
            where: { itemId: ri.itemId },
            data:  { receivedQty: { increment: qty } },
          });

          // Proportional GST for a partial receive — poItem already carries the full-line
          // GST breakup from PO creation, scaled here to the quantity actually received.
          const receiveFraction = poItem.orderedQty > 0 ? qty / poItem.orderedQty : 1;
          const taxableAmount   = parseFloat(poItem.taxableAmt) * receiveFraction;
          const gstAmount       = (parseFloat(poItem.cgst) + parseFloat(poItem.sgst)) * receiveFraction;
          await tx.movement.create({
            data: {
              shopId:      req.shopId,
              inventoryId: poItem.inventoryId,
              type:        'PURCHASE',
              qty,
              unitPrice:   parseFloat(poItem.unitPrice),
              gstRate:     parseFloat(poItem.gstRate),
              taxableAmount,
              totalAmount: taxableAmount + gstAmount,
              gstAmount,
              referenceNumber: po.poNumber,
              partyId:     po.partyId || null,
            },
          });

          await tx.shopInventory.update({
            where: { inventoryId: poItem.inventoryId },
            data:  { stockQty: { increment: qty } },
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
      where:   { poId },
      include: { items: true },
    });

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

// ── POST /:id/send-email ──────────────────────────────────────────────────────
// Send the PO PDF to the supplier via email.
// Only APPROVED POs may be sent (auto-advances status to SENT on success).
router.post('/:id/send-email', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const po = await prisma.purchaseOrder.findFirst({
      where: { poId, shopId: req.shopId },
      include: {
        items: true,
        party: { select: { name: true, phone: true, email: true, gstin: true, address: true } },
        shop:  { select: { name: true, address: true, city: true, gstin: true } },
      },
    });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    if (po.status !== 'APPROVED') {
      return res.status(400).json({
        success: false,
        error: { code: 'WRONG_STATUS', message: `Only APPROVED POs can be emailed (current: ${po.status})` },
      });
    }

    let pdfBuffer;
    try {
      pdfBuffer = await generatePurchaseOrderPdf(po);
    } catch (pdfErr) {
      console.error('[sendPoEmail] PDF generation failed', pdfErr);
      return res.status(500).json({ success: false, error: { code: 'PDF_FAILED', message: 'Could not generate PO PDF' } });
    }

    try {
      await sendPurchaseOrderEmail(po, pdfBuffer);
    } catch (emailErr) {
      console.error('[sendPoEmail] Email send failed', emailErr);
      return res.status(400).json({
        success: false,
        error: { code: emailErr.code || 'EMAIL_SEND_FAILED', message: emailErr.message },
      });
    }

    // Auto-advance to SENT now that the supplier has been notified
    const updated = await prisma.purchaseOrder.update({
      where:   { poId },
      data:    { status: 'SENT' },
      include: PO_INCLUDE_LIST,
    });

    writeAudit(req, {
      entityType: ET.ORDER,
      entityId:   poId,
      action:     ACT.UPDATE,
      newValue:   { status: 'SENT', sentVia: 'email', to: po.party?.email || null, poNumber: po.poNumber },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/clone ───────────────────────────────────────────────────────────
// Duplicate any PO as a fresh DRAFT. Items are copied; receivedQty resets to 0.
router.post('/:id/clone', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const src  = await prisma.purchaseOrder.findFirst({
      where:   { poId, shopId: req.shopId },
      include: { items: true },
    });
    if (!src) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }

    const poNumber = await generatePoNumber(req.shopId);

    const cloned = await prisma.purchaseOrder.create({
      data: {
        poNumber,
        shopId:        req.shopId,
        createdBy:     req.user.userId,
        partyId:       src.partyId,
        supplierName:  src.supplierName,
        supplierPhone: src.supplierPhone,
        supplierGstin: src.supplierGstin,
        subtotal:      src.subtotal,
        taxableAmount: src.taxableAmount,
        cgst:          src.cgst,
        sgst:          src.sgst,
        freight:       src.freight,
        otherCharges:  src.otherCharges,
        totalAmount:   src.totalAmount,
        paymentMode:   src.paymentMode,
        notes:         src.notes,
        status:        'DRAFT',
        items: {
          create: src.items.map(it => ({
            inventoryId: it.inventoryId,
            partName:    it.partName,
            hsnCode:     it.hsnCode,
            orderedQty:  it.orderedQty,
            unitPrice:   it.unitPrice,
            taxableAmt:  it.taxableAmt,
            gstRate:     it.gstRate,
            cgst:        it.cgst,
            sgst:        it.sgst,
            total:       it.total,
          })),
        },
      },
      include: { items: true, party: { select: { name: true, phone: true, gstin: true } } },
    });

    writeAudit(req, {
      entityType: ET.ORDER,
      entityId:   cloned.poId,
      action:     ACT.CREATE,
      newValue:   { clonedFrom: src.poNumber, poNumber },
    });

    res.status(201).json({ success: true, data: cloned });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/link-bill ──────────────────────────────────────────────────────
// Link or unlink a purchase bill to this PO. Pass billId: null to unlink.
router.patch('/:id/link-bill', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const poId = parseInt(req.params.id);
    const { billId } = req.body;

    const po = await prisma.purchaseOrder.findFirst({ where: { poId, shopId: req.shopId } });
    if (!po) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }

    if (billId !== null && billId !== undefined) {
      const bill = await prisma.purchaseBill.findFirst({
        where: { billId: parseInt(billId), shopId: req.shopId },
      });
      if (!bill) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Purchase bill not found' } });
      }
    }

    const updated = await prisma.purchaseOrder.update({
      where:   { poId },
      data:    { linkedBillId: billId ? parseInt(billId) : null },
      include: PO_INCLUDE_DETAIL,
    });

    writeAudit(req, {
      entityType: ET.ORDER,
      entityId:   poId,
      action:     ACT.UPDATE,
      newValue:   { linkedBillId: billId || null },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
