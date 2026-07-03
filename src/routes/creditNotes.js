/**
 * creditNotes.js — Credit Note register
 *
 * Mounted at: /api/shop/credit-notes
 *
 * GET /                list credit notes (filterable by type/status/GST period — for CA handoff)
 * GET /:id             single credit note detail
 *
 * Credit notes themselves are only ever created by salesReturns.js (POST /api/shop/returns) —
 * "a credit note must always be generated against an existing invoice, never created manually."
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner, requirePermission } from '../middleware/auth.js';

const router = Router();

// ─── GET / — list / register ───────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const { type, status, partyId, gstPeriod, from, to, available } = req.query;
    const where = { shopId: req.shopId };
    if (type && ['GST', 'COMMERCIAL'].includes(type)) where.type = type;
    if (status && ['UNUSED', 'PARTIALLY_USED', 'FULLY_USED', 'REFUNDED'].includes(status)) where.status = status;
    // ?available=true — redeemable notes only (used by POS to offer "apply credit" for a party)
    if (available === 'true') where.status = { in: ['UNUSED', 'PARTIALLY_USED'] };
    if (partyId) where.partyId = parseInt(partyId, 10);
    if (gstPeriod) where.gstPeriodDeclared = gstPeriod;
    if (from || to) {
      where.issueDate = {};
      if (from) where.issueDate.gte = new Date(from);
      if (to)   where.issueDate.lte = new Date(to);
    }

    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);

    const [creditNotes, total, summary] = await Promise.all([
      prisma.creditNote.findMany({
        where,
        include: { invoice: { select: { invoiceNumber: true } }, party: { select: { name: true, phone: true } } },
        orderBy: { issueDate: 'desc' },
        take:    limit,
        skip:    offset,
      }),
      prisma.creditNote.count({ where }),
      // Register summary — outstanding balance still owed to customers via store credit
      prisma.creditNote.aggregate({
        where: { shopId: req.shopId, status: { in: ['UNUSED', 'PARTIALLY_USED'] } },
        _sum: { remainingBalance: true },
      }),
    ]);

    res.json({
      success: true,
      creditNotes,
      total,
      limit,
      offset,
      outstandingCreditBalance: Number(summary._sum.remainingBalance || 0),
    });
  } catch (err) { next(err); }
});

// ─── GET /:id — single credit note ─────────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const creditNoteId = parseInt(req.params.id, 10);
    const creditNote = await prisma.creditNote.findFirst({
      where: { creditNoteId, shopId: req.shopId },
      include: {
        invoice: { select: { invoiceNumber: true, createdAt: true } },
        party:   { select: { name: true, phone: true } },
        salesReturn: { include: { items: true } },
      },
    });
    if (!creditNote) return res.status(404).json({ success: false, error: { message: 'Credit note not found' } });
    res.json({ success: true, creditNote });
  } catch (err) { next(err); }
});

export default router;
