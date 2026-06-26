/**
 * gstr.js — GSTR-1 export route
 *
 * Mounted at: /api/billing  (registered in index.js after billingRoutes)
 *
 * Routes:
 *   GET /api/billing/gstr1?from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|excel
 *
 * GSTR-1 sections produced:
 *   B2B   — invoices with partyGstin, one row per invoice
 *   B2CS  — B2C invoices under ₹2.5 lakh, aggregated by GST rate
 *   HSN   — invoice items grouped by HSN code
 *
 * Excel format: three sheets (B2B, B2CS, HSN) via the `xlsx` npm package.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

const B2CS_THRESHOLD = 250000; // ₹2.5 lakh

// ─── Helper: build the three GSTR-1 sections from raw invoice + item data ────

function buildGstr1Sections(invoices) {
  const b2b   = [];
  const b2csMap = new Map(); // key = gstRate string
  const hsnMap  = new Map(); // key = hsnCode

  for (const inv of invoices) {
    const invoiceValue  = Number(inv.totalAmount);
    const taxableValue  = Number(inv.taxableAmount);
    const cgst          = Number(inv.cgst);
    const sgst          = Number(inv.sgst);
    const dateStr       = inv.createdAt instanceof Date
      ? inv.createdAt.toISOString().slice(0, 10)
      : String(inv.createdAt).slice(0, 10);

    if (inv.partyGstin) {
      // B2B — one row per invoice (business buyer with GSTIN)
      b2b.push({
        gstin:         inv.partyGstin,
        invoiceNumber: inv.invoiceNumber,
        date:          dateStr,
        invoiceValue,
        taxableValue,
        cgst,
        sgst,
        // hsnCode taken from the first item (representative; proper B2B has item-level detail)
        hsnCode:       inv.items[0]?.hsnCode || null,
      });
    } else if (invoiceValue < B2CS_THRESHOLD) {
      // B2CS — aggregate by GST rate
      for (const item of inv.items) {
        const rateKey = String(Number(item.gstRate));
        const existing = b2csMap.get(rateKey) || { gstRate: Number(item.gstRate), taxableValue: 0, cgst: 0, sgst: 0 };
        existing.taxableValue += Number(item.taxableAmt);
        existing.cgst         += Number(item.cgst);
        existing.sgst         += Number(item.sgst);
        b2csMap.set(rateKey, existing);
      }
    }

    // HSN summary — always, regardless of B2B/B2C
    for (const item of inv.items) {
      const key = item.hsnCode || 'UNKNOWN';
      const existing = hsnMap.get(key) || {
        hsnCode:      item.hsnCode || '',
        description:  item.partName,
        uqc:          'NOS',
        qty:          0,
        taxableValue: 0,
        cgst:         0,
        sgst:         0,
      };
      existing.qty          += Number(item.qty);
      existing.taxableValue += Number(item.taxableAmt);
      existing.cgst         += Number(item.cgst);
      existing.sgst         += Number(item.sgst);
      hsnMap.set(key, existing);
    }
  }

  return {
    b2b,
    b2cs: [...b2csMap.values()].sort((a, b) => a.gstRate - b.gstRate),
    hsn:  [...hsnMap.values()].sort((a, b) => b.taxableValue - a.taxableValue),
  };
}

// ─── Helper: build an xlsx workbook buffer with three sheets ─────────────────

async function buildExcel(b2b, b2cs, hsn, periodLabel) {
  // Dynamic import — xlsx may not be installed in all environments.
  const XLSX = (await import('xlsx')).default;

  const wb = XLSX.utils.book_new();

  // Sheet 1 — B2B
  const b2bRows = [
    ['GSTIN of Recipient', 'Invoice Number', 'Invoice Date', 'Invoice Value', 'Taxable Value', 'CGST', 'SGST', 'HSN Code'],
    ...b2b.map(r => [r.gstin, r.invoiceNumber, r.date, r.invoiceValue, r.taxableValue, r.cgst, r.sgst, r.hsnCode || '']),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2bRows), 'B2B');

  // Sheet 2 — B2CS
  const b2csRows = [
    ['GST Rate (%)', 'Taxable Value', 'CGST', 'SGST'],
    ...b2cs.map(r => [r.gstRate, r.taxableValue.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2)]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2csRows), 'B2CS');

  // Sheet 3 — HSN Summary
  const hsnRows = [
    ['HSN Code', 'Description', 'UQC', 'Qty', 'Taxable Value', 'CGST', 'SGST'],
    ...hsn.map(r => [r.hsnCode, r.description, r.uqc, r.qty, r.taxableValue.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2)]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hsnRows), 'HSN Summary');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── GET /api/billing/gstr1 ───────────────────────────────────────────────────

router.get('/gstr1', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { format = 'json' } = req.query;
    const shopId = req.shopId;

    if (!req.query.from || !req.query.to) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_DATES', message: 'from and to query params are required (YYYY-MM-DD)' },
      });
    }

    const from = new Date(req.query.from);
    const to   = new Date(req.query.to + 'T23:59:59.999Z');

    if (isNaN(from) || isNaN(to) || from > to) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_DATES', message: 'from and to must be valid dates with from <= to' },
      });
    }

    // Fetch invoices with their line items in the date range
    const invoices = await prisma.invoice.findMany({
      where: {
        shopId,
        status:    { not: 'CANCELLED' },
        createdAt: { gte: from, lte: to },
      },
      select: {
        invoiceId:     true,
        invoiceNumber: true,
        partyGstin:    true,
        totalAmount:   true,
        taxableAmount: true,
        cgst:          true,
        sgst:          true,
        createdAt:     true,
        items: {
          select: {
            hsnCode:    true,
            partName:   true,
            qty:        true,
            taxableAmt: true,
            gstRate:    true,
            cgst:       true,
            sgst:       true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const { b2b, b2cs, hsn } = buildGstr1Sections(invoices);

    writeAudit(req, {
      entityType: ET.BILL,
      entityId:   null,
      action:     ACT.EXPORT,
      newValue:   { format, from: req.query.from, to: req.query.to, invoiceCount: invoices.length },
    });

    if (format === 'excel') {
      // Period label for filename e.g. "062026"
      const periodLabel = `${String(from.getMonth() + 1).padStart(2, '0')}${from.getFullYear()}`;
      try {
        const buffer = await buildExcel(b2b, b2cs, hsn, periodLabel);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=GSTR1_${periodLabel}.xlsx`);
        return res.send(buffer);
      } catch (xlsxErr) {
        // xlsx package not available — fall through to JSON with a warning header
        console.error('[GSTR1] xlsx build failed:', xlsxErr?.message);
        res.setHeader('X-Warning', 'xlsx package unavailable; returning JSON');
        // fall through to JSON response below
      }
    }

    res.json({
      success:      true,
      period:       { from: req.query.from, to: req.query.to },
      invoiceCount: invoices.length,
      b2b,
      b2cs,
      hsn,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
