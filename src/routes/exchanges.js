/**
 * exchanges.js — Exchange Order engine
 *
 * Mounted at: /api/shop/exchanges
 *
 * POST /   create an exchange — orchestrates a Sales Return (old item) + a normal
 *          Invoice (new item), settling the net difference in one request
 * GET  /   list exchanges (paginated)
 * GET  /:id single exchange detail
 *
 * Design: an exchange is NOT a third parallel engine. The "old item" leg is a
 * standard Sales Return whose refund is ALWAYS store credit (never cash/UPI —
 * there is no reason to hand over cash for the old item and then immediately
 * take most of it back for the new one). That credit note is redeemed in the
 * same request against the "new item" invoice via the existing appliedCreditNoteId
 * mechanism in billing.js. The GST/discount math for the new item reuses
 * computeItemTotals so it never drifts from what a normal sale computes.
 *
 * Atomicity: the return and the new invoice are each internally atomic (their
 * own transactions), but they are NOT wrapped in one shared transaction — if the
 * new-item sale fails (e.g. out of stock) after the return already committed,
 * the shop is left with a valid return + credit note and no new sale. This is
 * intentionally recoverable, not silent corruption: the credit note is real and
 * can be applied to a normal follow-up sale from the POS screen.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';
import { createSalesReturn, createWalkInSalesReturn, VALID_REASONS } from './salesReturns.js';
import { createInvoice, computeItemTotals } from './billing.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';
import { generateExchangeInvoicePdf } from '../services/pdf.js';

const router = Router();

// ─── POST / — create an exchange ───────────────────────────────────────────────
router.post('/', authenticate, requireShopOwner, requirePermission('billing.create'), async (req, res, next) => {
  try {
    const {
      originalInvoiceId, returnItems, walkInItems, walkInPartyId, returnReason, returnNotes,
      newItems, partyName, partyPhone, partyGstin,
      paymentMode, cashAmount, upiAmount, creditAmount,
      notes,
    } = req.body;

    if (!VALID_REASONS.includes(returnReason)) {
      return res.status(400).json({ success: false, error: { message: `returnReason must be one of: ${VALID_REASONS.join(', ')}` } });
    }
    // Exactly one of the two old-item sources: a matched invoice (normal path)
    // or a manual walk-in item list (no invoice could be found — see
    // NewReturnExchangeModal's "Process without one" fallback).
    const isWalkIn = !originalInvoiceId;
    if (isWalkIn) {
      if (!Array.isArray(walkInItems) || walkInItems.length === 0) {
        return res.status(400).json({ success: false, error: { message: 'At least one item being returned is required' } });
      }
    } else if (!Array.isArray(returnItems) || returnItems.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'At least one item being returned is required' } });
    }
    if (!Array.isArray(newItems) || newItems.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'At least one new item is required' } });
    }

    // ── Leg 1: return the old item — always as store credit, consumed below ──
    let returnResult;
    try {
      returnResult = isWalkIn
        ? await createWalkInSalesReturn(req, {
            items: walkInItems, reason: returnReason,
            refundMode: 'STORE_CREDIT', notes: returnNotes, partyId: walkInPartyId, forExchange: true,
          })
        : await createSalesReturn(req, {
            originalInvoiceId, items: returnItems, reason: returnReason,
            refundMode: 'STORE_CREDIT', notes: returnNotes, forExchange: true,
          });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, error: { message: `Return leg failed: ${err.message}` } });
      throw err;
    }
    const { salesReturn, creditNote, returnNo } = returnResult;

    // ── Price the new item(s) with the exact same math a normal sale uses ────
    const { subtotal: newSubtotal, cgst: newCgst, sgst: newSgst } = await computeItemTotals(req.shopId, newItems, 'EXCHANGE');
    const newTotal = newSubtotal + newCgst + newSgst;
    const appliedCreditAmount = Math.min(Number(creditNote.totalAmount), newTotal);

    // ── Leg 2: sell the new item, redeeming the credit note from leg 1 ───────
    // invoiceType: 'EXCHANGE' (not 'RETAIL') so the printed/PDF document is
    // clearly labeled and distinguishable from an ordinary sale — see
    // GET /:id/pdf below for the combined old-item/new-item Exchange Invoice.
    let newInvoice;
    try {
      newInvoice = await createInvoice(req, {
        items: newItems,
        partyId:   salesReturn.partyId || undefined,
        partyName, partyPhone, partyGstin,
        invoiceType: 'EXCHANGE',
        paymentMode: paymentMode || 'CASH',
        cashAmount, upiAmount, creditAmount,
        notes: notes || `Exchange ${returnNo}`,
        appliedCreditNoteId: creditNote.creditNoteId,
        appliedCreditAmount,
      });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({
          success: false,
          error: { message: `New item sale failed: ${err.message}. The return (${returnNo}) already completed — credit note ${creditNote.creditNoteNo} is available to apply on a follow-up sale.` },
        });
      }
      throw err;
    }

    // ── Header row linking both legs ──────────────────────────────────────────
    const priceDifference = newSubtotal - Number(creditNote.taxableValue);
    const gstDifference   = (newCgst + newSgst) - (Number(creditNote.cgst) + Number(creditNote.sgst));
    const netAmount        = newTotal - Number(creditNote.totalAmount);
    const settlementType   = netAmount > 0.01 ? 'COLLECT' : netAmount < -0.01 ? 'REFUND' : 'EVEN';
    const exchangeNo        = returnNo.replace('RET-', 'EXC-');

    const exchangeOrder = await prisma.exchangeOrder.create({
      data: {
        exchangeNo,
        shopId:          req.shopId,
        salesReturnId:   salesReturn.returnId,
        newInvoiceId:    newInvoice.invoiceId,
        priceDifference,
        gstDifference,
        netAmount,
        settlementType,
        createdBy:       req.user.userId,
      },
    });

    writeAudit(req, {
      entityType: ET.SALES_RETURN, entityId: exchangeOrder.exchangeId, action: ACT.CREATE,
      newValue: { exchangeNo, returnNo, newInvoiceNumber: newInvoice.invoiceNumber, settlementType, netAmount: String(netAmount) },
    });

    res.status(201).json({ success: true, exchangeOrder, salesReturn, creditNote, newInvoice });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: { message: err.message } });
    next(err);
  }
});

// ─── GET / — list exchanges ─────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

    const [exchanges, total] = await Promise.all([
      prisma.exchangeOrder.findMany({
        where: { shopId: req.shopId },
        include: {
          salesReturn: { select: { returnNo: true, reason: true, items: true } },
          newInvoice:  { select: { invoiceNumber: true, totalAmount: true, items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.exchangeOrder.count({ where: { shopId: req.shopId } }),
    ]);

    res.json({ success: true, exchanges, total, limit, offset });
  } catch (err) { next(err); }
});

// Shared include shape for both the JSON detail endpoint and the PDF route —
// pulls everything a combined "Exchange Invoice" document needs: the old
// item(s) (with product name resolved from either the original invoice line
// or, for a walk-in return, the inventory/master-part record), the credit
// note that paid for them, the original invoice reference, and the new
// item(s) sold.
const EXCHANGE_DETAIL_INCLUDE = {
  salesReturn: {
    include: {
      items: {
        include: {
          invoiceItem: { select: { partName: true, hsnCode: true, brand: true } },
          inventory:   { include: { masterPart: { select: { partName: true, hsnCode: true, brand: true } } } },
        },
      },
      creditNote: true,
      invoice:  { select: { invoiceNumber: true, createdAt: true } },
      party:    { select: { name: true, phone: true, gstin: true } },
    },
  },
  newInvoice: { include: { items: true } },
  shop: true,
};

// ─── GET /:id — single exchange detail ─────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const exchangeId = parseInt(req.params.id, 10);
    const exchangeOrder = await prisma.exchangeOrder.findFirst({
      where: { exchangeId, shopId: req.shopId },
      include: EXCHANGE_DETAIL_INCLUDE,
    });
    if (!exchangeOrder) return res.status(404).json({ success: false, error: { message: 'Exchange not found' } });
    res.json({ success: true, exchangeOrder });
  } catch (err) { next(err); }
});

// ─── GET /:id/pdf — printable Exchange Invoice ─────────────────────────────────
// Combines the old item (returned, credited) and the new item (issued) with a
// price-difference / settlement summary into one document — distinct from the
// generic per-invoice PDF at /api/billing/invoice/:id/pdf, which only ever
// knows about one side of the transaction.
router.get('/:id/pdf', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const exchangeId = parseInt(req.params.id, 10);
    const exchangeOrder = await prisma.exchangeOrder.findFirst({
      where: { exchangeId, shopId: req.shopId },
      include: EXCHANGE_DETAIL_INCLUDE,
    });
    if (!exchangeOrder) return res.status(404).json({ error: 'Exchange not found' });

    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId } });
    exchangeOrder.shop = shop || exchangeOrder.shop;

    const pdfBuffer = await generateExchangeInvoicePdf(exchangeOrder);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="exchange-${exchangeOrder.exchangeNo}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

export default router;
