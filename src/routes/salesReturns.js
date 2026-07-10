/**
 * salesReturns.js — Sales Return + Credit Note engine
 *
 * Mounted at: /api/shop/returns
 *
 * GET  /invoice/:invoiceId/eligible-items   what on this invoice can still be returned
 * POST /                                    create a sales return (+ its credit note) in one atomic step
 * GET  /                                    list returns (paginated)
 * GET  /:id                                 single return detail
 *
 * Every return is linked to an original Invoice — there is no standalone/manual return.
 * Stock changes go through the existing Movement ledger (types SALES_RETURN_IN /
 * SALES_RETURN_DAMAGED) — no parallel movements table. Store-credit refunds reuse the
 * existing Party.outstanding / PartyLedger mechanism (entryType RETURN_CREDIT) — a
 * negative `outstanding` IS the customer's wallet; there is no separate wallet table.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';
import { runSerializable } from '../lib/serializable-tx.js';
import { nextSeq } from '../lib/sequence.js';
import { financialYearKey, isGstAdjustable, currentGstPeriod, isPeriodLocked } from '../lib/gst-fy.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';
import { writeLedgerEntry } from './parties.js';
import { loadReturnPolicyWindows, resolveReturnPolicyDays } from '../lib/return-policy.js';
import { generateReturnInvoicePdf } from '../services/pdf.js';

const router = Router();

export const VALID_REASONS = ['WRONG_PART', 'DEFECTIVE', 'WARRANTY', 'CHANGED_MIND', 'OTHER'];
const VALID_CONDITIONS   = ['SEALED', 'GOOD', 'DAMAGED', 'USED'];
const RESELLABLE_SET     = new Set(['SEALED', 'GOOD']);
const VALID_REFUND_MODES = ['CASH', 'UPI', 'BANK', 'STORE_CREDIT'];

// ─── GET /invoice/:invoiceId/eligible-items ───────────────────────────────────
// Return-UI helper: each invoice line plus how much of it is still returnable.
router.get('/invoice/:invoiceId/eligible-items', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId, 10);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ success: false, error: { message: 'Invalid invoice id' } });

    const invoice = await prisma.invoice.findFirst({
      where: { invoiceId, shopId: req.shopId },
      include: { items: { include: { inventory: { include: { masterPart: { select: { categoryL1: true } } } } } } },
    });
    if (!invoice) return res.status(404).json({ success: false, error: { message: 'Invoice not found' } });

    const itemIds = invoice.items.map(i => i.itemId);
    const returnedByItem = itemIds.length > 0
      ? await prisma.salesReturnItem.groupBy({ by: ['invoiceItemId'], where: { invoiceItemId: { in: itemIds } }, _sum: { qty: true } })
      : [];
    const returnedMap = new Map(returnedByItem.map(r => [r.invoiceItemId, r._sum.qty || 0]));

    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { returnPolicyDays: true } });
    const shopDefaultDays = shop?.returnPolicyDays ?? 30;
    const windows = await loadReturnPolicyWindows(prisma, req.shopId);
    const daysSinceSale = Math.floor((Date.now() - invoice.createdAt.getTime()) / 86400000);

    const items = invoice.items.map(item => {
      const qtyReturned = returnedMap.get(item.itemId) || 0;
      // Brand/category overrides — see return-policy.js. Falls back to the
      // shop-wide default when neither the item's brand nor its category has one.
      const policyDays = resolveReturnPolicyDays(windows, { brand: item.brand, categoryL1: item.inventory?.masterPart?.categoryL1 }, shopDefaultDays);
      return {
        invoiceItemId: item.itemId,
        inventoryId:   item.inventoryId,
        partName:      item.partName,
        unitPrice:     Number(item.unitPrice),
        discount:      Number(item.discount),
        gstRate:       Number(item.gstRate),
        qtySold:       item.qty,
        qtyReturned,
        qtyReturnable: item.qty - qtyReturned,
        policyDays,
        withinPolicy:  daysSinceSale <= policyDays,
      };
    });

    // Invoice-level fields kept for backward compat (shown before any item is picked) —
    // per-item policyDays/withinPolicy above is the accurate figure once items are selected.
    res.json({
      success: true,
      invoice: {
        invoiceId: invoice.invoiceId, invoiceNumber: invoice.invoiceNumber,
        createdAt: invoice.createdAt, partyId: invoice.partyId, partyName: invoice.partyName,
      },
      items,
      daysSinceSale,
      returnPolicyDays: shopDefaultDays,
      withinPolicy: daysSinceSale <= shopDefaultDays,
    });
  } catch (err) { next(err); }
});

/**
 * createSalesReturn — the full return + credit-note transaction, extracted so it
 * can be called both from POST /api/shop/returns (below) AND from the Exchange
 * flow (exchanges.js), which needs the "old item" leg to always settle as store
 * credit that gets immediately redeemed against the "new item" invoice in the
 * same request — never left as a dangling customer-facing balance.
 *
 * `forExchange: true` skips the "store credit requires a registered customer"
 * check: an exchange's credit note is consumed synchronously via createInvoice's
 * appliedCreditNoteId in the same request, so there's no risk of an unredeemable
 * balance even when the customer has no Party record (a walk-in exchange).
 * Throws { status, message } on validation failure — callers convert that to
 * an HTTP response; anything else propagates as a real error.
 */
export async function createSalesReturn(req, { originalInvoiceId, items, reason, refundMode, notes, forExchange = false }) {
    if (!Number.isFinite(Number(originalInvoiceId))) {
      throw { status: 400, message: 'originalInvoiceId is required' };
    }
    if (!VALID_REASONS.includes(reason)) {
      throw { status: 400, message: `reason must be one of: ${VALID_REASONS.join(', ')}` };
    }
    if (!VALID_REFUND_MODES.includes(refundMode)) {
      throw { status: 400, message: `refundMode must be one of: ${VALID_REFUND_MODES.join(', ')}` };
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw { status: 400, message: 'At least one item is required' };
    }
    for (const it of items) {
      if (!Number.isFinite(Number(it.invoiceItemId)) || !Number.isInteger(Number(it.qty)) || Number(it.qty) <= 0) {
        throw { status: 400, message: 'Each item needs a valid invoiceItemId and a positive integer qty' };
      }
      if (!VALID_CONDITIONS.includes(it.condition)) {
        throw { status: 400, message: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` };
      }
    }

    const invoiceId = parseInt(originalInvoiceId, 10);
    const invoice = await prisma.invoice.findFirst({
      where: { invoiceId, shopId: req.shopId },
      include: { items: { include: { inventory: { include: { masterPart: { select: { categoryL1: true } } } } } } },
    });
    if (!invoice) throw { status: 404, message: 'Original invoice not found' };

    const invoiceItemMap = new Map(invoice.items.map(i => [i.itemId, i]));
    for (const it of items) {
      if (!invoiceItemMap.has(parseInt(it.invoiceItemId, 10))) {
        throw { status: 400, message: `Invoice line ${it.invoiceItemId} does not belong to invoice ${invoice.invoiceNumber}` };
      }
    }

    if (refundMode === 'STORE_CREDIT' && !invoice.partyId && !forExchange) {
      throw { status: 400, message: 'Store credit requires a registered customer — select a party on the return, or choose Cash/UPI/Bank instead' };
    }

    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId }, select: { returnPolicyDays: true } });
    const shopDefaultDays = shop?.returnPolicyDays ?? 30;
    const windows = await loadReturnPolicyWindows(prisma, req.shopId);
    const daysSinceSale = Math.floor((Date.now() - invoice.createdAt.getTime()) / 86400000);
    // Flag for approval if ANY selected item is outside its own (brand/category-
    // resolved) return window — not just the shop-wide default.
    const requiresApproval = items.some(it => {
      const invoiceItem = invoiceItemMap.get(parseInt(it.invoiceItemId, 10));
      const policyDays = resolveReturnPolicyDays(windows, { brand: invoiceItem?.brand, categoryL1: invoiceItem?.inventory?.masterPart?.categoryL1 }, shopDefaultDays);
      return daysSinceSale > policyDays;
    });

    const result = await runSerializable(async (tx) => {
      // Re-check "already returned" totals inside the Serializable transaction — closes
      // the race where two concurrent requests both read "0 returned so far" and both
      // try to return the full original quantity.
      const itemsData = [];
      let taxableValue = 0, cgstTotal = 0, sgstTotal = 0;

      for (const it of items) {
        const invoiceItemId = parseInt(it.invoiceItemId, 10);
        const qty = parseInt(it.qty, 10);
        const invoiceItem = invoiceItemMap.get(invoiceItemId);

        const priorSum = await tx.salesReturnItem.aggregate({
          where: { invoiceItemId },
          _sum: { qty: true },
        });
        const alreadyReturned = priorSum._sum.qty || 0;
        const returnable = invoiceItem.qty - alreadyReturned;
        if (qty > returnable) {
          throw { status: 400, message: `Cannot return ${qty} of ${invoiceItem.partName} — only ${returnable} left returnable` };
        }

        const disposition = RESELLABLE_SET.has(it.condition) ? 'RESELLABLE' : 'DAMAGED_STOCK';
        const unitTaxable = (Number(invoiceItem.unitPrice) - Number(invoiceItem.discount)) * qty;
        const gstRate = Number(invoiceItem.gstRate);
        const itemCgst = unitTaxable * (gstRate / 2 / 100);
        const itemSgst = itemCgst;

        taxableValue += unitTaxable;
        cgstTotal    += itemCgst;
        sgstTotal    += itemSgst;

        itemsData.push({
          inventoryId:   invoiceItem.inventoryId,
          invoiceItemId,
          qty,
          condition:     it.condition,
          disposition,
          unitPrice:     invoiceItem.unitPrice,
          taxableValue:  unitTaxable,
          gstRate,
          cgst:          itemCgst,
          sgst:          itemSgst,
        });
      }

      const fy = financialYearKey(new Date());
      const returnSeq = await nextSeq(tx, req.shopId, `RET-${fy}`);
      const returnNo  = `RET-S${req.shopId}-${fy}-${String(returnSeq).padStart(5, '0')}`;

      const salesReturn = await tx.salesReturn.create({
        data: {
          returnNo,
          shopId:            req.shopId,
          originalInvoiceId: invoiceId,
          partyId:           invoice.partyId,
          reason,
          requiresApproval,
          status:            'COMPLETED',
          refundMode,
          notes:             notes || null,
          createdBy:         req.user.userId,
          items: { create: itemsData },
        },
        include: { items: true },
      });

      // ── Stock disposition + Movement ledger (never optional, never manual) ──
      for (const item of salesReturn.items) {
        if (item.disposition === 'RESELLABLE') {
          await tx.shopInventory.update({
            where: { inventoryId: item.inventoryId },
            data:  { stockQty: { increment: item.qty } },
          });
        } else {
          await tx.shopInventory.update({
            where: { inventoryId: item.inventoryId },
            data:  { damagedQty: { increment: item.qty } },
          });
        }

        await tx.movement.create({
          data: {
            shopId:          req.shopId,
            inventoryId:     item.inventoryId,
            type:            item.disposition === 'RESELLABLE' ? 'SALES_RETURN_IN' : 'SALES_RETURN_DAMAGED',
            qty:             item.qty,
            unitPrice:       item.unitPrice,
            gstRate:         item.gstRate,
            taxableAmount:   item.taxableValue,
            totalAmount:     Number(item.taxableValue) + Number(item.cgst) + Number(item.sgst),
            gstAmount:       Number(item.cgst) + Number(item.sgst),
            invoiceId:       invoiceId,
            partyId:         invoice.partyId,
            partyName:       invoice.partyName,
            referenceNumber: returnNo,
            invoiceNumber:   invoice.invoiceNumber,
            notes:           `${reason} (${item.condition})`,
            correlationId:   returnNo,
            createdBy:       req.user.userId,
          },
        });
      }

      // ── Credit note (always generated — never a standalone entry) ───────────
      const totalAmount = taxableValue + cgstTotal + sgstTotal;
      const period = currentGstPeriod();
      const periodLocked = await isPeriodLocked(tx, req.shopId, period);
      const gstAdjustable = isGstAdjustable(invoice.createdAt, new Date()) && !periodLocked;
      const cnSeq = await nextSeq(tx, req.shopId, `CN-${fy}`);
      const creditNoteNo = `CN-S${req.shopId}-${fy}-${String(cnSeq).padStart(5, '0')}`;

      const isImmediateRefund = refundMode !== 'STORE_CREDIT';
      const creditNote = await tx.creditNote.create({
        data: {
          creditNoteNo,
          shopId:            req.shopId,
          type:              gstAdjustable ? 'GST' : 'COMMERCIAL',
          linkedInvoiceId:   invoiceId,
          partyId:           invoice.partyId,
          taxableValue,
          cgst:              cgstTotal,
          sgst:              sgstTotal,
          totalAmount,
          status:            isImmediateRefund ? 'REFUNDED' : 'UNUSED',
          remainingBalance:  isImmediateRefund ? 0 : totalAmount,
          gstPeriodDeclared: gstAdjustable ? period : null,
          gstBlockReason:    !gstAdjustable
            ? (periodLocked ? `GST period ${period} is locked` : 'Outside the Section 34 declaration deadline')
            : null,
          reason,
        },
      });

      await tx.salesReturn.update({
        where: { returnId: salesReturn.returnId },
        data:  { creditNoteId: creditNote.creditNoteId },
      });

      // ── Store credit → Party.outstanding goes negative (= shop owes customer) ──
      // Skipped when there's no registered party (e.g. a walk-in exchange) — the
      // credit note's own remainingBalance still tracks the amount correctly.
      if (refundMode === 'STORE_CREDIT' && invoice.partyId) {
        await writeLedgerEntry(tx, {
          shopId:      req.shopId,
          partyId:     invoice.partyId,
          entryType:   'RETURN_CREDIT',
          creditAmount: totalAmount,
          invoiceId,
          referenceNo: creditNoteNo,
          notes:       `Credit note ${creditNoteNo} — ${reason}`,
          createdBy:   req.user.userId,
        });
      }

      return { salesReturn, creditNote, returnNo, creditNoteNo };
    });

    writeAudit(req, {
      entityType: ET.SALES_RETURN, entityId: result.salesReturn.returnId, action: ACT.CREATE,
      newValue: { returnNo: result.returnNo, creditNoteNo: result.creditNoteNo, refundMode, reason },
    });

    return result;
}

// ─── POST / — create a sales return + credit note ─────────────────────────────
router.post('/', authenticate, requireShopOwner, requirePermission('billing.create'), async (req, res, next) => {
  try {
    const result = await createSalesReturn(req, req.body);
    res.status(201).json({ success: true, salesReturn: result.salesReturn, creditNote: result.creditNote });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: { message: err.message } });
    next(err);
  }
});

/**
 * createWalkInSalesReturn — the "no original invoice found" fallback. Same
 * return-value shape as createSalesReturn ({ salesReturn, creditNote, returnNo,
 * creditNoteNo }) so the Exchange flow (exchanges.js) can call either one
 * interchangeably for its old-item leg.
 *
 * Differences from the normal (invoice-backed) path:
 *   - Items reference a ShopInventory row directly (inventoryId), not an
 *     InvoiceItem — there is no invoice line to validate qty/price against, so
 *     the price is whatever staff enters (defaults to the part's current
 *     selling price client-side) and GST rate comes from the part's own record.
 *   - requiresApproval is ALWAYS true and isWalkIn is always true — there is no
 *     invoice trail to fall back on, so every one of these is flagged for
 *     manager review (same "flagged, not blocked" philosophy as an out-of-
 *     policy invoice-backed return — see Shop.returnPolicyDays above).
 *   - The credit note is always type=COMMERCIAL (a GST credit note legally
 *     requires a taxable-supply/invoice reference, which doesn't exist here)
 *     and linkedInvoiceId is null.
 */
export async function createWalkInSalesReturn(req, { items, reason, refundMode, notes, partyId, forExchange = false }) {
  if (!VALID_REASONS.includes(reason)) {
    throw { status: 400, message: `reason must be one of: ${VALID_REASONS.join(', ')}` };
  }
  if (!VALID_REFUND_MODES.includes(refundMode)) {
    throw { status: 400, message: `refundMode must be one of: ${VALID_REFUND_MODES.join(', ')}` };
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw { status: 400, message: 'At least one item is required' };
  }
  for (const it of items) {
    if (!Number.isFinite(Number(it.inventoryId)) || !Number.isInteger(Number(it.qty)) || Number(it.qty) <= 0) {
      throw { status: 400, message: 'Each item needs a valid inventoryId and a positive integer qty' };
    }
    if (!VALID_CONDITIONS.includes(it.condition)) {
      throw { status: 400, message: `condition must be one of: ${VALID_CONDITIONS.join(', ')}` };
    }
    if (!(Number(it.unitPrice) > 0)) {
      throw { status: 400, message: 'Each item needs a positive unitPrice' };
    }
  }

  const resolvedPartyId = partyId ? parseInt(partyId, 10) : null;
  if (refundMode === 'STORE_CREDIT' && !resolvedPartyId && !forExchange) {
    throw { status: 400, message: 'Store credit requires a registered customer — search/select a party, or choose Cash/UPI/Bank instead' };
  }

  const inventoryIds = [...new Set(items.map(it => parseInt(it.inventoryId, 10)))];
  const inventoryRows = await prisma.shopInventory.findMany({
    where: { inventoryId: { in: inventoryIds }, shopId: req.shopId },
    include: { masterPart: { select: { gstRate: true } } },
  });
  const invMap = new Map(inventoryRows.map(r => [r.inventoryId, r]));
  for (const id of inventoryIds) {
    if (!invMap.has(id)) throw { status: 400, message: `Inventory item ${id} not found in this shop` };
  }

  const result = await runSerializable(async (tx) => {
    const itemsData = [];
    let taxableValue = 0, cgstTotal = 0, sgstTotal = 0;

    for (const it of items) {
      const inv = invMap.get(parseInt(it.inventoryId, 10));
      const qty = parseInt(it.qty, 10);
      const disposition = RESELLABLE_SET.has(it.condition) ? 'RESELLABLE' : 'DAMAGED_STOCK';
      const unitPrice = Number(it.unitPrice);
      const gstRate = Number(inv.masterPart?.gstRate ?? 18);
      // Staff-entered price is treated as tax-inclusive (matches how a walk-in
      // cash sale is normally quoted) — back out the taxable value from it.
      const unitTaxable = (unitPrice / (1 + gstRate / 100)) * qty;
      const itemCgst = unitTaxable * (gstRate / 2 / 100);
      const itemSgst = itemCgst;

      taxableValue += unitTaxable;
      cgstTotal    += itemCgst;
      sgstTotal    += itemSgst;

      itemsData.push({
        inventoryId:   inv.inventoryId,
        invoiceItemId: null,
        qty,
        condition:     it.condition,
        disposition,
        unitPrice,
        taxableValue:  unitTaxable,
        gstRate,
        cgst:          itemCgst,
        sgst:          itemSgst,
      });
    }

    const fy = financialYearKey(new Date());
    const returnSeq = await nextSeq(tx, req.shopId, `RET-${fy}`);
    const returnNo  = `RET-S${req.shopId}-${fy}-${String(returnSeq).padStart(5, '0')}`;

    const salesReturn = await tx.salesReturn.create({
      data: {
        returnNo,
        shopId:            req.shopId,
        originalInvoiceId: null,
        isWalkIn:          true,
        requiresApproval:  true,
        partyId:           resolvedPartyId,
        reason,
        status:            'COMPLETED',
        refundMode,
        notes:             notes || null,
        createdBy:         req.user.userId,
        items: { create: itemsData },
      },
      include: { items: true },
    });

    for (const item of salesReturn.items) {
      if (item.disposition === 'RESELLABLE') {
        await tx.shopInventory.update({ where: { inventoryId: item.inventoryId }, data: { stockQty: { increment: item.qty } } });
      } else {
        await tx.shopInventory.update({ where: { inventoryId: item.inventoryId }, data: { damagedQty: { increment: item.qty } } });
      }

      await tx.movement.create({
        data: {
          shopId:          req.shopId,
          inventoryId:     item.inventoryId,
          type:            item.disposition === 'RESELLABLE' ? 'SALES_RETURN_IN' : 'SALES_RETURN_DAMAGED',
          qty:             item.qty,
          unitPrice:       item.unitPrice,
          gstRate:         item.gstRate,
          taxableAmount:   item.taxableValue,
          totalAmount:     Number(item.taxableValue) + Number(item.cgst) + Number(item.sgst),
          gstAmount:       Number(item.cgst) + Number(item.sgst),
          partyId:         resolvedPartyId,
          referenceNumber: returnNo,
          notes:           `WALK-IN (no invoice found) — ${reason} (${item.condition})`,
          correlationId:   returnNo,
          createdBy:       req.user.userId,
        },
      });
    }

    const totalAmount = taxableValue + cgstTotal + sgstTotal;
    const cnSeq = await nextSeq(tx, req.shopId, `CN-${fy}`);
    const creditNoteNo = `CN-S${req.shopId}-${fy}-${String(cnSeq).padStart(5, '0')}`;

    const isImmediateRefund = refundMode !== 'STORE_CREDIT';
    const creditNote = await tx.creditNote.create({
      data: {
        creditNoteNo,
        shopId:            req.shopId,
        // Always COMMERCIAL — no original invoice means no valid GST credit note.
        type:              'COMMERCIAL',
        linkedInvoiceId:   null,
        partyId:           resolvedPartyId,
        taxableValue,
        cgst:              cgstTotal,
        sgst:              sgstTotal,
        totalAmount,
        status:            isImmediateRefund ? 'REFUNDED' : 'UNUSED',
        remainingBalance:  isImmediateRefund ? 0 : totalAmount,
        gstPeriodDeclared: null,
        reason,
      },
    });

    await tx.salesReturn.update({
      where: { returnId: salesReturn.returnId },
      data:  { creditNoteId: creditNote.creditNoteId },
    });

    if (refundMode === 'STORE_CREDIT' && resolvedPartyId) {
      await writeLedgerEntry(tx, {
        shopId:      req.shopId,
        partyId:     resolvedPartyId,
        entryType:   'RETURN_CREDIT',
        creditAmount: totalAmount,
        referenceNo: creditNoteNo,
        notes:       `Walk-in credit note ${creditNoteNo} (no invoice) — ${reason}`,
        createdBy:   req.user.userId,
      });
    }

    return { salesReturn, creditNote, returnNo, creditNoteNo };
  });

  writeAudit(req, {
    entityType: ET.SALES_RETURN, entityId: result.salesReturn.returnId, action: ACT.CREATE,
    newValue: { returnNo: result.returnNo, walkIn: true, refundMode, reason },
  });

  return result;
}

// ─── POST /walk-in — create a return with NO original invoice ─────────────────
// Fallback for a customer whose sale can't be located (no name/phone on file,
// paper receipt lost, etc.) — always flagged (requiresApproval + isWalkIn) and
// never a GST-adjusting credit note. See createWalkInSalesReturn above.
router.post('/walk-in', authenticate, requireShopOwner, requirePermission('billing.create'), async (req, res, next) => {
  try {
    const result = await createWalkInSalesReturn(req, req.body);
    res.status(201).json({ success: true, salesReturn: result.salesReturn, creditNote: result.creditNote });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: { message: err.message } });
    next(err);
  }
});

// ─── GET / — list returns ──────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const { reason, partyId, from, to } = req.query;
    const where = { shopId: req.shopId };
    if (reason && VALID_REASONS.includes(reason)) where.reason = reason;
    if (partyId) where.partyId = parseInt(partyId, 10);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

    const [returns, total] = await Promise.all([
      prisma.salesReturn.findMany({
        where,
        include: {
          items: true, creditNote: true, invoice: { select: { invoiceNumber: true } },
          // Lets the frontend show one unified Returns & Exchange list — a return with
          // an exchangeOrder attached renders as "Exchange" instead of a plain return.
          exchangeOrder: { include: { newInvoice: { select: { invoiceNumber: true, items: { select: { partName: true } } } } } },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.salesReturn.count({ where }),
    ]);

    res.json({ success: true, returns, total, limit, offset });
  } catch (err) { next(err); }
});

// ─── GET /:id — single return detail ────────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    const salesReturn = await prisma.salesReturn.findFirst({
      where: { returnId, shopId: req.shopId },
      include: {
        items: { include: { inventory: { include: { masterPart: { select: { partName: true } } } } } },
        creditNote: true,
        invoice: { select: { invoiceNumber: true, createdAt: true, partyName: true } },
      },
    });
    if (!salesReturn) return res.status(404).json({ success: false, error: { message: 'Return not found' } });
    res.json({ success: true, salesReturn });
  } catch (err) { next(err); }
});

// ─── GET /:id/pdf — printable Credit Note / Return Invoice ───────────────────
router.get('/:id/pdf', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const returnId = parseInt(req.params.id, 10);
    if (!Number.isFinite(returnId)) return res.status(400).json({ success: false, error: { message: 'Invalid return id' } });

    const salesReturn = await prisma.salesReturn.findFirst({
      where: { returnId, shopId: req.shopId },
      include: {
        items: {
          include: {
            invoiceItem: { select: { partName: true, hsnCode: true } },
            inventory:   { include: { masterPart: { select: { partName: true, hsnCode: true } } } },
          },
        },
        creditNote: true,
        invoice:    { select: { invoiceNumber: true, partyName: true } },
        party:      { select: { name: true, gstin: true } },
        shop:       true,
      },
    });
    if (!salesReturn) return res.status(404).json({ success: false, error: { message: 'Return not found' } });

    // Attach shop from the request scope (always authoritative)
    const shop = await prisma.shop.findUnique({ where: { shopId: req.shopId } });
    salesReturn.shop = shop;

    const pdfBuffer = await generateReturnInvoicePdf(salesReturn);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="return-${salesReturn.returnNo || returnId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

export default router;
