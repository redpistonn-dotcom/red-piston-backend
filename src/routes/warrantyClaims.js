/**
 * warrantyClaims.js — Warranty Claim lifecycle
 *
 * Mounted at: /api/shop/warranty-claims
 *
 * POST  /               open a claim against an original invoice line
 * GET   /                list claims (paginated, filterable by status)
 * GET   /:id             single claim detail
 * PATCH /:id/status       advance the claim through its lifecycle
 *
 * Unlike a Sales Return, the claimed item isn't refunded — it moves through a
 * claim lifecycle (SENT_TO_SUPPLIER → APPROVED/REJECTED → REPLACEMENT_RECEIVED
 * → RETURNED_TO_CUSTOMER) before resolution, which can take days or weeks.
 * Every status change writes an AuditLog row via writeAudit — no separate
 * claim-history table, same as every other mutation in this codebase.
 *
 * The claimed unit itself was never part of counted stock (it left at the
 * original sale) and isn't added back — it's neither sellable nor sitting in
 * the shop's own damaged bin while the OEM has it. Stock only moves at
 * REPLACEMENT_RECEIVED (a genuinely new unit arrives) and RETURNED_TO_CUSTOMER
 * (that unit immediately leaves again) — both written to Movement for a
 * complete audit trail even though they net to zero on stockQty.
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';
import { nextSeq } from '../lib/sequence.js';
import { financialYearKey } from '../lib/gst-fy.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

const VALID_STATUSES = ['SENT_TO_SUPPLIER', 'APPROVED', 'REJECTED', 'REPLACEMENT_RECEIVED', 'RETURNED_TO_CUSTOMER'];
// State machine — REJECTED and RETURNED_TO_CUSTOMER are terminal. A paid replacement
// after rejection is a normal new sale (createInvoice), not a claim-status transition.
const VALID_TRANSITIONS = {
  SENT_TO_SUPPLIER:      ['APPROVED', 'REJECTED'],
  APPROVED:              ['REPLACEMENT_RECEIVED'],
  REPLACEMENT_RECEIVED:  ['RETURNED_TO_CUSTOMER'],
  REJECTED:              [],
  RETURNED_TO_CUSTOMER:  [],
};

// ─── POST / — open a claim ──────────────────────────────────────────────────────
router.post('/', authenticate, requireShopOwner, requirePermission('billing.create'), async (req, res, next) => {
  try {
    const { originalInvoiceId, invoiceItemId, qty, partyId, notes } = req.body;

    if (!Number.isFinite(Number(originalInvoiceId)) || !Number.isFinite(Number(invoiceItemId))) {
      return res.status(400).json({ success: false, error: { message: 'originalInvoiceId and invoiceItemId are required' } });
    }
    const claimQty = qty ? parseInt(qty, 10) : 1;
    if (!Number.isInteger(claimQty) || claimQty <= 0) {
      return res.status(400).json({ success: false, error: { message: 'qty must be a positive integer' } });
    }

    const invoiceId = parseInt(originalInvoiceId, 10);
    const invoice = await prisma.invoice.findFirst({ where: { invoiceId, shopId: req.shopId } });
    if (!invoice) return res.status(404).json({ success: false, error: { message: 'Original invoice not found' } });

    const invoiceItem = await prisma.invoiceItem.findFirst({
      where: { itemId: parseInt(invoiceItemId, 10), invoiceId },
      include: { inventory: { include: { masterPart: { select: { warrantyMonths: true, partName: true } } } } },
    });
    if (!invoiceItem) return res.status(400).json({ success: false, error: { message: 'Invoice line does not belong to this invoice' } });
    if (claimQty > invoiceItem.qty) {
      return res.status(400).json({ success: false, error: { message: `Cannot claim ${claimQty} units — only ${invoiceItem.qty} were sold on this line` } });
    }

    if (partyId) {
      const party = await prisma.party.findFirst({ where: { partyId: parseInt(partyId, 10), shopId: req.shopId } });
      if (!party) return res.status(400).json({ success: false, error: { message: 'Party not found' } });
    }

    const daysSinceSale = Math.floor((Date.now() - invoice.createdAt.getTime()) / 86400000);
    const warrantyMonths = invoiceItem.inventory.masterPart.warrantyMonths;
    // Permissive when unset — most catalog rows never had a warranty period recorded.
    // Never blocks; staff can still judge and proceed regardless.
    const withinWarranty = warrantyMonths == null ? true : daysSinceSale <= warrantyMonths * 30;

    const fy = financialYearKey(new Date());
    const claim = await prisma.$transaction(async (tx) => {
      const seq = await nextSeq(tx, req.shopId, `WC-${fy}`);
      const claimNo = `WC-S${req.shopId}-${fy}-${String(seq).padStart(5, '0')}`;

      return tx.warrantyClaim.create({
        data: {
          claimNo,
          shopId:            req.shopId,
          originalInvoiceId: invoiceId,
          invoiceItemId:     invoiceItem.itemId,
          inventoryId:       invoiceItem.inventoryId,
          qty:               claimQty,
          partyId:           partyId ? parseInt(partyId, 10) : null,
          notes:             notes || null,
          createdBy:         req.user.userId,
        },
      });
    });

    writeAudit(req, {
      entityType: ET.SALES_RETURN, entityId: claim.claimId, action: ACT.CREATE,
      newValue: { claimNo: claim.claimNo, invoiceItemId: invoiceItem.itemId, qty: claimQty },
    });

    res.status(201).json({ success: true, claim, daysSinceSale, warrantyMonths, withinWarranty });
  } catch (err) { next(err); }
});

// ─── GET / — list claims ────────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const { status, partyId, from, to } = req.query;
    const where = { shopId: req.shopId };
    if (status && VALID_STATUSES.includes(status)) where.status = status;
    if (partyId) where.partyId = parseInt(partyId, 10);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

    const [claims, total] = await Promise.all([
      prisma.warrantyClaim.findMany({
        where,
        include: {
          invoice: { select: { invoiceNumber: true } },
          invoiceItem: { select: { partName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.warrantyClaim.count({ where }),
    ]);

    res.json({ success: true, claims, total, limit, offset });
  } catch (err) { next(err); }
});

// ─── GET /:id — single claim detail ─────────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const claimId = parseInt(req.params.id, 10);
    const claim = await prisma.warrantyClaim.findFirst({
      where: { claimId, shopId: req.shopId },
      include: {
        invoice: { select: { invoiceNumber: true, createdAt: true, partyName: true } },
        invoiceItem: true,
        batch: true,
      },
    });
    if (!claim) return res.status(404).json({ success: false, error: { message: 'Claim not found' } });
    res.json({ success: true, claim });
  } catch (err) { next(err); }
});

// ─── PATCH /:id/status — advance the claim lifecycle ───────────────────────────
router.patch('/:id/status', authenticate, requireShopOwner, requirePermission('billing.create'), async (req, res, next) => {
  try {
    const claimId = parseInt(req.params.id, 10);
    const { status, version, notes } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}` } });
    }
    if (!Number.isInteger(Number(version))) {
      return res.status(400).json({ success: false, error: { message: 'version is required for optimistic concurrency' } });
    }

    const claim = await prisma.warrantyClaim.findFirst({ where: { claimId, shopId: req.shopId } });
    if (!claim) return res.status(404).json({ success: false, error: { message: 'Claim not found' } });

    const allowed = VALID_TRANSITIONS[claim.status] ?? [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        error: { message: `Cannot move from ${claim.status} to ${status}. Allowed next: ${allowed.join(', ') || 'none (terminal state)'}` },
      });
    }

    await prisma.$transaction(async (tx) => {
      // ── Stock only moves at these two transitions — see file header for why ──
      if (status === 'REPLACEMENT_RECEIVED') {
        await tx.shopInventory.update({
          where: { inventoryId: claim.inventoryId },
          data:  { stockQty: { increment: claim.qty } },
        });
        await tx.movement.create({
          data: {
            shopId: req.shopId, inventoryId: claim.inventoryId, type: 'WARRANTY_IN',
            qty: claim.qty, referenceNumber: claim.claimNo, notes: 'Warranty replacement received from supplier',
            correlationId: claim.claimNo, createdBy: req.user.userId,
          },
        });
      } else if (status === 'RETURNED_TO_CUSTOMER') {
        const deducted = await tx.shopInventory.updateMany({
          where: { inventoryId: claim.inventoryId, stockQty: { gte: claim.qty } },
          data:  { stockQty: { decrement: claim.qty } },
        });
        if (deducted.count === 0) {
          throw { status: 400, message: 'Insufficient stock to hand over the replacement — it may have already been sold' };
        }
        await tx.movement.create({
          data: {
            shopId: req.shopId, inventoryId: claim.inventoryId, type: 'WARRANTY_OUT',
            qty: claim.qty, referenceNumber: claim.claimNo, invoiceId: claim.originalInvoiceId,
            notes: 'Warranty replacement handed to customer', correlationId: claim.claimNo, createdBy: req.user.userId,
          },
        });
      }

      const updated = await tx.warrantyClaim.updateMany({
        where: { claimId, shopId: req.shopId, version: parseInt(version, 10) },
        data:  {
          status,
          notes: notes || undefined,
          resolvedDate: (status === 'REJECTED' || status === 'RETURNED_TO_CUSTOMER') ? new Date() : undefined,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw { status: 409, message: 'This claim was updated elsewhere — reload and try again' };
      }
    });

    const updatedClaim = await prisma.warrantyClaim.findUnique({ where: { claimId } });
    writeAudit(req, {
      entityType: ET.SALES_RETURN, entityId: claimId, action: ACT.UPDATE,
      oldValue: { status: claim.status }, newValue: { status },
    });

    res.json({ success: true, claim: updatedClaim });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: { message: err.message } });
    next(err);
  }
});

export default router;
