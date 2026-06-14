/**
 * Purchase Bills — supplier invoice upload → parse → review → stock-in.
 *
 * Flow:
 *   1. POST /extract   — PDF (base64) in, parsed line items out. Bill row
 *                        stored with status PENDING_REVIEW; the original PDF
 *                        is archived to Cloudinary under bills/<shopId>/.
 *   2. POST /:id/import — shop-owner-verified items in. Each item is matched
 *                        to a MasterPart (or one is created), then upserted
 *                        into ShopInventory with a PURCHASE/OPENING Movement.
 *   3. GET  /           — all bills for this shop (newest first).
 *
 * Parsing is text-layer based (zero API cost) and ALWAYS validated against
 * the invoice's printed taxable total — the response carries `sumMatches` so
 * the review UI can warn when items may be missing.
 */
import { Router } from 'express';
import express from 'express';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { parseTallyInvoice, parseGenericInvoice } from '../services/billParser.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const MAX_PDF_BYTES = 12 * 1024 * 1024;

// ─── POST /api/shop/purchase-bills/extract ────────────────────────────────────
// Body: { fileBase64, fileName } — raised body limit scoped to this route only.
router.post('/extract', express.json({ limit: '18mb' }), authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { fileBase64, fileName } = req.body;
    if (!fileBase64) {
      return res.status(400).json({ success: false, error: { message: 'fileBase64 is required' } });
    }
    const buffer = Buffer.from(fileBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > MAX_PDF_BYTES) {
      return res.status(413).json({ success: false, error: { message: 'PDF too large (max 12 MB)' } });
    }
    if (buffer.slice(0, 5).toString() !== '%PDF-') {
      return res.status(400).json({ success: false, error: { message: 'Only PDF invoices are supported right now. For photos/scans, support is coming.' } });
    }

    // Try the precise Tally parser first (best accuracy for that format), then
    // fall back to the generic heuristic parser for any other DIGITAL invoice.
    let extracted;
    try {
      extracted = await parseTallyInvoice(buffer);
      if (!extracted.items.length) {
        const generic = await parseGenericInvoice(buffer).catch(() => null);
        if (generic && (generic.items.length || generic.supplierGstin || generic.invoiceNumber)) extracted = generic;
      }
    } catch (err) {
      console.error('[purchase-bills/extract] tally parse failed, trying generic:', err?.message);
      try {
        extracted = await parseGenericInvoice(buffer);
      } catch (e2) {
        console.error('[purchase-bills/extract] generic parse failed:', e2);
        return res.status(422).json({ success: false, error: { message: 'Could not read this PDF. It may be a scanned image or an unsupported format.' } });
      }
    }
    if (!extracted.items.length) {
      return res.status(422).json({ success: false, error: { message: 'No line items could be read automatically. If this is a scanned/photo invoice (no text layer) it can\'t be parsed — add the items manually.' } });
    }

    // Archive the original PDF (best-effort — extraction result is not blocked on it)
    let fileUrl = null;
    try {
      const up = await cloudinary.uploader.upload(
        `data:application/pdf;base64,${buffer.toString('base64')}`,
        // resource_type 'raw' (not 'image') — Cloudinary blocks PDF *delivery* for
        // image-type uploads by default, which made "View PDF" return 401. Raw files
        // are delivered directly so the link opens.
        { folder: `bills/shop-${req.shopId}`, resource_type: 'raw', use_filename: true, filename_override: fileName || 'bill.pdf' }
      );
      fileUrl = up.secure_url;
    } catch (err) {
      console.error('[purchase-bills/extract] cloudinary archive failed:', err?.message);
    }

    const bill = await prisma.purchaseBill.create({
      data: {
        shopId: req.shopId,
        fileUrl,
        fileName: fileName || null,
        supplierName: extracted.supplierName,
        supplierGstin: extracted.supplierGstin,
        invoiceNumber: extracted.invoiceNumber,
        invoiceDate: extracted.invoiceDate,
        taxableTotal: extracted.taxableTotal,
        grandTotal: extracted.grandTotal,
        itemCount: extracted.items.length,
        extracted,
        sumMatches: extracted.sumMatches,
      },
    });

    res.json({ success: true, billId: bill.billId, extracted });
  } catch (err) { next(err); }
});

// ─── POST /api/shop/purchase-bills/:id/import ─────────────────────────────────
// Body: { items: [{ partName, hsnCode, qty, rate, sellingPrice }] }
// Items are the shop-owner-VERIFIED rows from the review screen (possibly edited).
router.post('/:id/import', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const billId = parseInt(req.params.id, 10);
    const bill = await prisma.purchaseBill.findFirst({ where: { billId, shopId: req.shopId } });
    if (!bill) return res.status(404).json({ success: false, error: { message: 'Bill not found' } });
    if (bill.status === 'IMPORTED') {
      return res.status(409).json({ success: false, error: { message: 'This bill has already been imported' } });
    }

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ success: false, error: { message: 'No items to import' } });
    if (items.length > 200) return res.status(400).json({ success: false, error: { message: 'Max 200 items per import' } });

    const results = [];
    const errors = [];
    const supplierNote = [bill.supplierName, bill.invoiceNumber ? `Bill: ${bill.invoiceNumber}` : null]
      .filter(Boolean).join(' · ');

    for (const item of items) {
      const partName = String(item.partName || '').trim();
      const qty = parseInt(item.qty, 10);
      const rate = parseFloat(item.rate);
      const sellingPrice = parseFloat(item.sellingPrice);
      if (!partName || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate <= 0
        || !Number.isFinite(sellingPrice) || sellingPrice <= 0) {
        errors.push({ partName: partName || '(blank)', error: 'invalid name/qty/rate/sellingPrice' });
        continue;
      }
      try {
        // 1. Match an existing MasterPart by exact name (case-insensitive), else create one
        let master = await prisma.masterPart.findFirst({
          where: { partName: { equals: partName, mode: 'insensitive' } },
        });
        if (!master) {
          master = await prisma.masterPart.create({
            data: {
              partName,
              hsnCode: item.hsnCode || null,
              source: 'BILL_IMPORT',
              status: 'PENDING',
              contributedByShopId: req.shopId,
              isUniversal: false,
              requiresFitment: false,
            },
          });
        }

        // 2. Upsert shop inventory + movement
        const existing = await prisma.shopInventory.findUnique({
          where: { shopId_masterPartId: { shopId: req.shopId, masterPartId: master.masterPartId } },
        });
        let inv;
        let movementType;
        if (existing) {
          inv = await prisma.shopInventory.update({
            where: { inventoryId: existing.inventoryId },
            data: {
              stockQty: { increment: qty },
              buyingPrice: rate,
              sellingPrice,
              lastPurchasedAt: new Date(),
            },
          });
          movementType = 'PURCHASE';
        } else {
          inv = await prisma.shopInventory.create({
            data: {
              shopId: req.shopId,
              masterPartId: master.masterPartId,
              sellingPrice,
              buyingPrice: rate,
              stockQty: qty,
              lastPurchasedAt: new Date(),
            },
          });
          movementType = 'OPENING';
        }
        await prisma.movement.create({
          data: {
            shopId: req.shopId,
            inventoryId: inv.inventoryId,
            createdBy: req.user.userId,
            type: movementType,
            qty,
            unitPrice: rate,
            totalAmount: rate * qty,
            referenceNumber: bill.invoiceNumber || null,
            notes: supplierNote || 'Imported from uploaded bill',
          },
        });
        results.push({ partName, inventoryId: inv.inventoryId, masterPartId: master.masterPartId, qty, status: movementType });
      } catch (err) {
        console.error('[purchase-bills/import] item failed:', partName, err?.message);
        errors.push({ partName, error: 'database error' });
      }
    }

    if (results.length) {
      await prisma.purchaseBill.update({
        where: { billId },
        data: { status: 'IMPORTED', importedAt: new Date() },
      });
    }

    writeAudit(req, {
      entityType: ET.BILL,
      entityId:   billId,
      action:     ACT.IMPORT,
      newValue: {
        billId,
        supplierName: bill.supplierName,
        invoiceNumber: bill.invoiceNumber,
        imported: results.length,
        errorCount: errors.length,
      },
    });

    res.json({ success: true, imported: results.length, errorCount: errors.length, results, errors });
  } catch (err) { next(err); }
});

// ─── GET /api/shop/purchase-bills ─────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const bills = await prisma.purchaseBill.findMany({
      where: { shopId: req.shopId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        billId: true, fileUrl: true, fileName: true, supplierName: true,
        invoiceNumber: true, invoiceDate: true, taxableTotal: true, grandTotal: true,
        itemCount: true, sumMatches: true, status: true, importedAt: true, createdAt: true,
      },
    });
    res.json({ success: true, bills });
  } catch (err) { next(err); }
});

// ─── GET /api/shop/purchase-bills/:id — full bill incl. extracted items ──────
router.get('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const bill = await prisma.purchaseBill.findFirst({
      where: { billId: parseInt(req.params.id, 10), shopId: req.shopId },
    });
    if (!bill) return res.status(404).json({ success: false, error: { message: 'Bill not found' } });
    res.json({ success: true, bill });
  } catch (err) { next(err); }
});

export default router;
