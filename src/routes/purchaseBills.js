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

    // Prevent duplicate extraction: if an identical invoice number already exists for
    // this shop, return the existing bill's data so the review UI can resume it.
    if (extracted.invoiceNumber) {
      const existing = await prisma.purchaseBill.findFirst({
        where: { shopId: req.shopId, invoiceNumber: extracted.invoiceNumber },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        if (existing.status === 'IMPORTED') {
          return res.status(409).json({ success: false, error: { message: `Invoice ${extracted.invoiceNumber} has already been imported into inventory.` } });
        }
        // PENDING_REVIEW duplicate — return the existing bill so the user can continue reviewing it
        return res.json({ success: true, billId: existing.billId, extracted: existing.extracted, duplicate: true });
      }
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

    // Validate all items up-front before touching the DB
    const validItems = [];
    for (const item of items) {
      const partName = String(item.partName || '').trim().slice(0, 200);
      const qty = parseInt(item.qty, 10);
      const rate = parseFloat(item.rateExclGst ?? item.rate);
      const sellingPrice = parseFloat(item.sellingPrice);
      if (!partName || !Number.isFinite(qty) || qty <= 0 || qty > 100000
        || !Number.isFinite(rate) || rate <= 0 || rate > 10000000
        || !Number.isFinite(sellingPrice) || sellingPrice <= 0 || sellingPrice > 10000000) {
        errors.push({ partName: partName || '(blank)', error: 'invalid name/qty/rate/sellingPrice' });
        continue;
      }
      validItems.push({ ...item, partName, qty, rate, sellingPrice });
    }

    if (!validItems.length && errors.length > 0) {
      return res.status(400).json({ success: false, error: { message: 'No valid items to import', errors } });
    }

    // Process each valid item; each item gets its own mini-transaction so one
    // bad item doesn't roll back all the others.
    for (const item of validItems) {
      const { partName, qty, rate, sellingPrice } = item;
      try {
        await prisma.$transaction(async (tx) => {
          // 1. Match existing MasterPart by name or create
          let master = await tx.masterPart.findFirst({
            where: { partName: { equals: partName, mode: 'insensitive' } },
          });
          if (!master) {
            master = await tx.masterPart.create({
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
          const existing = await tx.shopInventory.findUnique({
            where: { shopId_masterPartId: { shopId: req.shopId, masterPartId: master.masterPartId } },
          });
          let inv;
          let movementType;
          if (existing) {
            inv = await tx.shopInventory.update({
              where: { inventoryId: existing.inventoryId },
              data: { stockQty: { increment: qty }, buyingPrice: rate, sellingPrice, lastPurchasedAt: new Date() },
            });
            movementType = 'PURCHASE';
          } else {
            inv = await tx.shopInventory.create({
              data: { shopId: req.shopId, masterPartId: master.masterPartId, sellingPrice, buyingPrice: rate, stockQty: qty, lastPurchasedAt: new Date() },
            });
            movementType = 'OPENING';
          }
          await tx.movement.create({
            data: {
              shopId: req.shopId, inventoryId: inv.inventoryId, createdBy: req.user.userId,
              type: movementType, qty, unitPrice: rate, totalAmount: rate * qty,
              referenceNumber: bill.invoiceNumber || null,
              notes: supplierNote || 'Imported from uploaded bill',
            },
          });
          results.push({ partName, inventoryId: inv.inventoryId, masterPartId: master.masterPartId, qty, status: movementType });
        });
      } catch (err) {
        console.error('[purchase-bills/import] item failed:', partName, err?.message);
        errors.push({ partName, error: 'database error' });
      }
    }

    if (results.length > 0) {
      await prisma.purchaseBill.update({
        where: { billId },
        data: { status: 'IMPORTED', importedAt: new Date() },
      });
    } else {
      // All items failed — tell the client clearly
      return res.status(207).json({
        success: false,
        error: { message: 'All items failed to import — check errors for details' },
        imported: 0, errors,
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

// Extract the Cloudinary public_id from a delivery URL.
// Handles both /image/upload/ and /raw/upload/ with optional version segment.
// Decodes %2F so folder paths like "bills/shop-1/file" are preserved correctly.
function cloudinaryPublicId(url) {
  const m = url.match(/\/(?:image|raw|video)\/upload\/(?:v\d+\/)?(.+?)(\.[^./]+)?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── GET /api/shop/purchase-bills/pdf-proxy — server-side PDF fetch ──────────
// Cascades through strategies so both old (image/upload) and new (raw/upload)
// Cloudinary PDFs open correctly. Old uploads are blocked by unsigned delivery
// so we fall back to private_download_url which generates a time-limited
// authenticated download link that bypasses Cloudinary's delivery restrictions.
router.get('/pdf-proxy', authenticate, requireShopOwner, async (req, res) => {
  const url = (req.query.url || '').trim();
  const CLOUDINARY_HOST = 'res.cloudinary.com';
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Invalid or missing url parameter' });
  }

  // Non-Cloudinary URL: simple authenticated proxy (S3, Supabase, etc.)
  if (!url.includes(CLOUDINARY_HOST)) {
    try {
      const r = await fetch(url);
      if (!r.ok) return res.status(404).send('PDF not available');
      const buf = Buffer.from(await r.arrayBuffer());
      res.set('Content-Type', r.headers.get('content-type') || 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="bill.pdf"');
      res.set('Cache-Control', 'private, max-age=3600');
      return res.send(buf);
    } catch (err) {
      console.error('[pdf-proxy] non-cloudinary fetch failed:', err.message);
      return res.status(502).send('Failed to fetch PDF');
    }
  }
  const tryFetch = async (fetchUrl) => {
    try {
      const r = await fetch(fetchUrl);
      return r.ok ? r : null;
    } catch { return null; }
  };
  try {
    // 1. Try raw/upload directly (new uploads stored as resource_type: raw)
    const rawUrl = url.includes('/raw/upload/') ? url : url.replace('/image/upload/', '/raw/upload/');
    let result = await tryFetch(rawUrl);

    // 2. Try original URL as-is
    if (!result && rawUrl !== url) result = await tryFetch(url);

    // 3. fl_attachment flag
    if (!result && url.includes('/image/upload/')) {
      result = await tryFetch(url.replace('/image/upload/', '/image/upload/fl_attachment/'));
    }

    // 4. Cloudinary private_download_url — generates a time-limited signed download
    //    link authenticated entirely via URL params (no Authorization header needed;
    //    adding one actually breaks signature verification → 404).
    if (!result) {
      const pid = cloudinaryPublicId(url);
      if (pid) {
        try {
          // Try as raw first, then as image (old uploads)
          for (const rtype of ['raw', 'image']) {
            const dlUrl = cloudinary.utils.private_download_url(pid, 'pdf', {
              resource_type: rtype,
              type: 'upload',
              expires_at: Math.floor(Date.now() / 1000) + 120,
            });
            const r = await tryFetch(dlUrl); // NO auth headers — signed URL only
            if (r) { result = r; break; }
          }
        } catch (e) {
          console.error('[pdf-proxy] private_download_url error:', e.message);
        }
      }
    }

    if (!result) {
      console.error('[pdf-proxy] all strategies failed for:', url);
      return res.status(404).send('PDF not available');
    }
    const buf = Buffer.from(await result.arrayBuffer());
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="bill.pdf"');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) {
    console.error('[purchase-bills/pdf-proxy]', err);
    res.status(502).send('Failed to fetch PDF');
  }
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
