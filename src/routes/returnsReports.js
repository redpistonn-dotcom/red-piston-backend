/**
 * returnsReports.js — Reports suite for Returns / Exchange / Warranty (Phase 6)
 *
 * Mounted at: /api/shop/returns-reports
 *
 * GET /sales-returns          sales returns grouped by reason | product | staff | date
 * GET /purchase-returns       purchase returns grouped by supplier | reason | resolution
 * GET /exchanges              exchange history — old part vs new part, net settlement
 * GET /warranty-aging         open claims aging + resolved turnaround, by supplier
 * GET /reasons-pareto         Pareto view of top return reasons (?type=sales|purchase)
 * GET /return-rate-by-brand   return rate as % of units sold, by brand
 * GET /inventory-adjustments  all non-sale stock movements with reason + creator
 * GET /credit-note-register   GST vs commercial notes, issued/used/outstanding (?format=json|excel)
 *
 * Read-only aggregation over what Phases 1-5 already built — no new tables,
 * no writes. All endpoints accept ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional).
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';

const router = Router();

function dateRange(query) {
  const where = {};
  if (query.from || query.to) {
    where.gte = query.from ? new Date(query.from) : undefined;
    where.lte = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;
  }
  return Object.keys(where).length ? where : undefined;
}

// ─── GET /sales-returns ─────────────────────────────────────────────────────────
router.get('/sales-returns', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const createdAt = dateRange(req.query);
    const groupBy = ['reason', 'product', 'staff', 'date'].includes(req.query.groupBy) ? req.query.groupBy : 'reason';

    const returns = await prisma.salesReturn.findMany({
      where: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) },
      include: {
        items: { include: { invoiceItem: { select: { partName: true } } } },
        creator: { select: { name: true } },
      },
    });

    const buckets = new Map();
    for (const r of returns) {
      const value = r.items.reduce((s, i) => s + Number(i.taxableValue) + Number(i.cgst) + Number(i.sgst), 0);
      const qty = r.items.reduce((s, i) => s + i.qty, 0);
      const keys = groupBy === 'reason' ? [r.reason]
        : groupBy === 'staff'  ? [r.creator?.name || 'Unknown']
        : groupBy === 'date'   ? [r.createdAt.toISOString().slice(0, 10)]
        : r.items.map(i => i.invoiceItem?.partName || 'Unknown'); // product — one bucket per item

      for (const key of keys) {
        const b = buckets.get(key) || { key, returnCount: 0, qty: 0, value: 0 };
        b.returnCount += 1;
        b.qty += qty;
        b.value += value;
        buckets.set(key, b);
      }
    }

    const rows = [...buckets.values()].sort((a, b) => b.value - a.value);
    res.json({ success: true, groupBy, rows, totalReturns: returns.length });
  } catch (err) { next(err); }
});

// ─── GET /purchase-returns ──────────────────────────────────────────────────────
router.get('/purchase-returns', authenticate, requireShopOwner, requirePermission('purchase.view'), async (req, res, next) => {
  try {
    const createdAt = dateRange(req.query);
    const groupBy = ['supplier', 'reason', 'resolution'].includes(req.query.groupBy) ? req.query.groupBy : 'reason';

    const returns = await prisma.purchaseReturn.findMany({
      where: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) },
      include: { items: true },
    });

    const buckets = new Map();
    for (const r of returns) {
      const key = groupBy === 'supplier' ? (r.supplierName || 'Unknown') : groupBy === 'resolution' ? r.resolution : r.reason;
      const value = r.items.reduce((s, i) => s + Number(i.taxableValue) + Number(i.cgst) + Number(i.sgst), 0);
      const qty = r.items.reduce((s, i) => s + i.qty, 0);
      const b = buckets.get(key) || { key, returnCount: 0, qty: 0, value: 0 };
      b.returnCount += 1;
      b.qty += qty;
      b.value += value;
      buckets.set(key, b);
    }

    const rows = [...buckets.values()].sort((a, b) => b.value - a.value);
    res.json({ success: true, groupBy, rows, totalReturns: returns.length });
  } catch (err) { next(err); }
});

// ─── GET /exchanges ─────────────────────────────────────────────────────────────
router.get('/exchanges', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const createdAt = dateRange(req.query);
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);

    const [exchanges, total] = await Promise.all([
      prisma.exchangeOrder.findMany({
        where: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) },
        include: {
          salesReturn: { select: { returnNo: true, reason: true, items: { include: { invoiceItem: { select: { partName: true } } } } } },
          newInvoice:  { select: { invoiceNumber: true, items: { select: { partName: true, qty: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit, skip: offset,
      }),
      prisma.exchangeOrder.count({ where: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) } }),
    ]);

    const rows = exchanges.map(e => ({
      exchangeNo: e.exchangeNo,
      createdAt: e.createdAt,
      oldPart: e.salesReturn.items.map(i => i.invoiceItem?.partName).filter(Boolean).join(', ') || 'Unknown',
      newPart: e.newInvoice.items.map(i => i.partName).join(', ') || 'Unknown',
      priceDifference: Number(e.priceDifference),
      gstDifference: Number(e.gstDifference),
      netAmount: Number(e.netAmount),
      settlementType: e.settlementType,
    }));

    res.json({ success: true, rows, total, limit, offset });
  } catch (err) { next(err); }
});

// ─── GET /warranty-aging ────────────────────────────────────────────────────────
router.get('/warranty-aging', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const claims = await prisma.warrantyClaim.findMany({
      where: { shopId: req.shopId },
      include: { party: { select: { name: true } }, invoiceItem: { select: { partName: true } } },
      orderBy: { sentDate: 'asc' },
    });

    const now = Date.now();
    const open = [];
    const resolvedTurnarounds = [];
    const bySupplier = new Map();

    for (const c of claims) {
      const supplierKey = c.party?.name || 'Unassigned';
      const bucket = bySupplier.get(supplierKey) || { supplier: supplierKey, openCount: 0, resolvedCount: 0, totalTurnaroundDays: 0 };

      if (c.status === 'REJECTED' || c.status === 'RETURNED_TO_CUSTOMER') {
        const turnaround = c.resolvedDate ? Math.floor((c.resolvedDate.getTime() - c.sentDate.getTime()) / 86400000) : null;
        if (turnaround != null) {
          resolvedTurnarounds.push(turnaround);
          bucket.resolvedCount += 1;
          bucket.totalTurnaroundDays += turnaround;
        }
      } else {
        const daysOpen = Math.floor((now - c.sentDate.getTime()) / 86400000);
        open.push({ claimNo: c.claimNo, partName: c.invoiceItem?.partName || 'Unknown', status: c.status, supplier: supplierKey, daysOpen });
        bucket.openCount += 1;
      }
      bySupplier.set(supplierKey, bucket);
    }

    const avgTurnaroundDays = resolvedTurnarounds.length
      ? Math.round(resolvedTurnarounds.reduce((a, b) => a + b, 0) / resolvedTurnarounds.length)
      : null;

    const bySupplierRows = [...bySupplier.values()].map(b => ({
      ...b,
      avgTurnaroundDays: b.resolvedCount > 0 ? Math.round(b.totalTurnaroundDays / b.resolvedCount) : null,
    }));

    res.json({
      success: true,
      openClaims: open.sort((a, b) => b.daysOpen - a.daysOpen),
      avgTurnaroundDays,
      bySupplier: bySupplierRows,
    });
  } catch (err) { next(err); }
});

// ─── GET /reasons-pareto ────────────────────────────────────────────────────────
router.get('/reasons-pareto', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const createdAt = dateRange(req.query);
    const type = req.query.type === 'purchase' ? 'purchase' : 'sales';

    const rows = type === 'sales'
      ? await prisma.salesReturn.groupBy({
          by: ['reason'],
          where: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) },
          _count: { reason: true },
        })
      : await prisma.purchaseReturn.groupBy({
          by: ['reason'],
          where: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) },
          _count: { reason: true },
        });

    const sorted = rows.map(r => ({ reason: r.reason, count: r._count.reason })).sort((a, b) => b.count - a.count);
    const total = sorted.reduce((s, r) => s + r.count, 0);
    let cumulative = 0;
    const pareto = sorted.map(r => {
      cumulative += r.count;
      return { ...r, percentOfTotal: total ? Math.round((r.count / total) * 1000) / 10 : 0, cumulativePercent: total ? Math.round((cumulative / total) * 1000) / 10 : 0 };
    });

    res.json({ success: true, type, total, pareto });
  } catch (err) { next(err); }
});

// ─── GET /return-rate-by-brand ──────────────────────────────────────────────────
router.get('/return-rate-by-brand', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const createdAt = dateRange(req.query);

    // Units sold by brand — InvoiceItem.brand is a denormalized snapshot from sale time.
    const sold = await prisma.invoiceItem.groupBy({
      by: ['brand'],
      where: { invoice: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) } },
      _sum: { qty: true },
    });

    // Units returned by brand — via the returned line's original InvoiceItem snapshot,
    // so a return is attributed to the brand it was actually sold under.
    const returnedItems = await prisma.salesReturnItem.findMany({
      where: { return: { shopId: req.shopId, ...(createdAt ? { createdAt } : {}) } },
      include: { invoiceItem: { select: { brand: true } } },
    });
    const returnedByBrand = new Map();
    for (const item of returnedItems) {
      const brand = item.invoiceItem?.brand || 'Unknown';
      returnedByBrand.set(brand, (returnedByBrand.get(brand) || 0) + item.qty);
    }

    const rows = sold.map(s => {
      const brand = s.brand || 'Unknown';
      const soldQty = s._sum.qty || 0;
      const returnedQty = returnedByBrand.get(brand) || 0;
      return { brand, soldQty, returnedQty, returnRatePercent: soldQty ? Math.round((returnedQty / soldQty) * 1000) / 10 : 0 };
    }).sort((a, b) => b.returnRatePercent - a.returnRatePercent);

    res.json({ success: true, rows });
  } catch (err) { next(err); }
});

// ─── GET /inventory-adjustments ─────────────────────────────────────────────────
const NON_SALE_TYPES = [
  'SALES_RETURN_IN', 'SALES_RETURN_DAMAGED', 'PURCHASE_RETURN_OUT',
  'WARRANTY_IN', 'WARRANTY_OUT', 'ADJUSTMENT', 'AUDIT', 'DAMAGE', 'THEFT',
];
router.get('/inventory-adjustments', authenticate, requireShopOwner, requirePermission('inventory.view'), async (req, res, next) => {
  try {
    const createdAt = dateRange(req.query);
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);
    const where = { shopId: req.shopId, type: { in: NON_SALE_TYPES }, ...(createdAt ? { createdAt } : {}) };

    const [movements, total] = await Promise.all([
      prisma.movement.findMany({
        where,
        include: { creator: { select: { name: true } }, inventory: { include: { masterPart: { select: { partName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: limit, skip: offset,
      }),
      prisma.movement.count({ where }),
    ]);

    const rows = movements.map(m => ({
      movementId: m.movementId,
      createdAt: m.createdAt,
      type: m.type,
      partName: m.inventory?.masterPart?.partName || 'Unknown',
      qty: m.qty,
      notes: m.notes,
      referenceNumber: m.referenceNumber,
      approver: m.creator?.name || 'Unknown',
    }));

    res.json({ success: true, rows, total, limit, offset });
  } catch (err) { next(err); }
});

// ─── GET /credit-note-register ──────────────────────────────────────────────────
// Mirrors gstr.js's format=json|excel pattern for accountant handoff.
router.get('/credit-note-register', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const { format = 'json', gstPeriod } = req.query;
    const createdAt = dateRange(req.query);
    const where = {
      shopId: req.shopId,
      ...(createdAt ? { issueDate: createdAt } : {}),
      ...(gstPeriod ? { gstPeriodDeclared: gstPeriod } : {}),
    };

    const notes = await prisma.creditNote.findMany({
      where,
      include: { invoice: { select: { invoiceNumber: true } }, party: { select: { name: true } } },
      orderBy: { issueDate: 'desc' },
    });

    const rows = notes.map(n => ({
      creditNoteNo: n.creditNoteNo,
      issueDate: n.issueDate.toISOString().slice(0, 10),
      invoiceNumber: n.invoice?.invoiceNumber || null,
      party: n.party?.name || 'Walk-in',
      type: n.type,
      gstPeriodDeclared: n.gstPeriodDeclared || '',
      taxableValue: Number(n.taxableValue),
      cgst: Number(n.cgst),
      sgst: Number(n.sgst),
      totalAmount: Number(n.totalAmount),
      status: n.status,
      remainingBalance: Number(n.remainingBalance),
      reason: n.reason || '',
    }));

    const summary = {
      totalNotes: rows.length,
      gstCount: rows.filter(r => r.type === 'GST').length,
      commercialCount: rows.filter(r => r.type === 'COMMERCIAL').length,
      totalIssued: rows.reduce((s, r) => s + r.totalAmount, 0),
      totalOutstanding: rows.reduce((s, r) => s + r.remainingBalance, 0),
    };

    if (format === 'excel') {
      try {
        const XLSX = (await import('xlsx')).default;
        const wb = XLSX.utils.book_new();
        const sheetRows = [
          ['Credit Note No', 'Issue Date', 'Invoice No', 'Party', 'Type', 'GST Period', 'Taxable Value', 'CGST', 'SGST', 'Total', 'Status', 'Remaining', 'Reason'],
          ...rows.map(r => [r.creditNoteNo, r.issueDate, r.invoiceNumber, r.party, r.type, r.gstPeriodDeclared, r.taxableValue, r.cgst, r.sgst, r.totalAmount, r.status, r.remainingBalance, r.reason]),
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetRows), 'Credit Notes');
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=credit_note_register.xlsx');
        return res.send(buffer);
      } catch (xlsxErr) {
        console.error('[credit-note-register] xlsx build failed:', xlsxErr?.message);
        res.setHeader('X-Warning', 'xlsx package unavailable; returning JSON');
      }
    }

    res.json({ success: true, summary, rows });
  } catch (err) { next(err); }
});

// ─── GET /exceptions — audit dashboard: things that need a human look ─────────
// Three checks, per the Module 8 "audit dashboard" ask:
//   1. Orphan movements  — a system-generated movement type with no reference
//      back to the invoice/return/claim that caused it (should never happen;
//      surfaces a bug or a row written outside the normal flows).
//   2. Negative stock    — stockQty went below zero (should be prevented at
//      write time, but this is the safety-net check for anything that slipped
//      through).
//   3. Stale open approvals — a return/claim flagged for manager review that's
//      sat unreviewed past STALE_APPROVAL_DAYS.
const TRACEABLE_MOVEMENT_TYPES = ['SALE', 'PURCHASE', 'SALES_RETURN_IN', 'SALES_RETURN_DAMAGED', 'PURCHASE_RETURN_OUT', 'WARRANTY_IN', 'WARRANTY_OUT'];
const MANUAL_MOVEMENT_TYPES = ['ADJUSTMENT', 'DAMAGE', 'THEFT', 'AUDIT', 'OPENING', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RETURN_IN', 'RETURN_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUST'];
const STALE_APPROVAL_DAYS = 3;

router.get('/exceptions', authenticate, requireShopOwner, requirePermission('inventory.view'), async (req, res, next) => {
  try {
    const shopId = req.shopId;
    const staleCutoff = new Date(Date.now() - STALE_APPROVAL_DAYS * 86400000);

    const [systemOrphans, manualOrphans, negativeStockRows, staleReturns, staleWarranty, stalePurchaseReturns] = await Promise.all([
      // System-generated movements that should always carry a reference but don't
      prisma.movement.findMany({
        where: { shopId, type: { in: TRACEABLE_MOVEMENT_TYPES }, referenceNumber: null },
        include: { inventory: { include: { masterPart: { select: { partName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      // Manual adjustments with no reason recorded — no way to audit why stock moved
      prisma.movement.findMany({
        where: { shopId, type: { in: MANUAL_MOVEMENT_TYPES }, OR: [{ notes: null }, { notes: '' }] },
        include: { inventory: { include: { masterPart: { select: { partName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.shopInventory.findMany({
        where: { shopId, stockQty: { lt: 0 } },
        include: { masterPart: { select: { partName: true } } },
        take: 200,
      }),
      prisma.salesReturn.findMany({
        where: { shopId, requiresApproval: true, approvedBy: null, createdAt: { lt: staleCutoff } },
        select: { returnId: true, returnNo: true, reason: true, isWalkIn: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      prisma.warrantyClaim.findMany({
        where: { shopId, status: { notIn: ['REJECTED', 'RETURNED_TO_CUSTOMER'] }, sentDate: { lt: staleCutoff } },
        select: { claimId: true, claimNo: true, status: true, sentDate: true },
        orderBy: { sentDate: 'asc' },
        take: 200,
      }),
      prisma.purchaseReturn.findMany({
        where: { shopId, resolution: 'PENDING', createdAt: { lt: staleCutoff } },
        select: { returnId: true, returnNo: true, supplierName: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    ]);

    const orphanMovements = [...systemOrphans, ...manualOrphans].map(m => ({
      movementId: m.movementId,
      createdAt: m.createdAt,
      type: m.type,
      partName: m.inventory?.masterPart?.partName || 'Unknown',
      qty: m.qty,
      referenceNumber: m.referenceNumber,
      notes: m.notes,
      reason: TRACEABLE_MOVEMENT_TYPES.includes(m.type) ? 'Missing reference number' : 'No reason recorded',
    }));

    const negativeStock = negativeStockRows.map(inv => ({
      inventoryId: inv.inventoryId,
      partName: inv.masterPart?.partName || 'Unknown',
      stockQty: inv.stockQty,
    }));

    const staleApprovals = [
      ...staleReturns.map(r => ({
        kind: 'SALES_RETURN', id: r.returnId, reference: r.returnNo,
        detail: r.isWalkIn ? 'Walk-in return — no invoice' : r.reason, since: r.createdAt,
        daysOpen: Math.floor((Date.now() - r.createdAt.getTime()) / 86400000),
      })),
      ...staleWarranty.map(w => ({
        kind: 'WARRANTY_CLAIM', id: w.claimId, reference: w.claimNo,
        detail: w.status, since: w.sentDate,
        daysOpen: Math.floor((Date.now() - w.sentDate.getTime()) / 86400000),
      })),
      ...stalePurchaseReturns.map(p => ({
        kind: 'PURCHASE_RETURN', id: p.returnId, reference: p.returnNo,
        detail: p.supplierName || 'Unknown supplier', since: p.createdAt,
        daysOpen: Math.floor((Date.now() - p.createdAt.getTime()) / 86400000),
      })),
    ].sort((a, b) => b.daysOpen - a.daysOpen);

    res.json({
      success: true,
      staleApprovalDays: STALE_APPROVAL_DAYS,
      orphanMovements,
      negativeStock,
      staleApprovals,
      counts: { orphanMovements: orphanMovements.length, negativeStock: negativeStock.length, staleApprovals: staleApprovals.length },
    });
  } catch (err) { next(err); }
});

export default router;
