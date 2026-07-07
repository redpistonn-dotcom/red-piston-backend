/**
 * parties.js — Udhaar & Credit Management
 *
 * Mounted at: /api/shop/parties
 *
 * GET    /                         list parties (with outstanding balance)
 * POST   /                         create party (customer / supplier)
 * GET    /:id                      get single party
 * PUT    /:id                      update party details
 * DELETE /:id                      soft-delete (isActive = false)
 *
 * Ledger (immutable udhaar trail):
 * GET    /:id/ledger               full ledger for a party
 * POST   /:id/ledger               manually add opening-balance / adjustment
 * POST   /:id/payment              record a payment received
 *
 * Summary:
 * GET    /summary/overdue          parties whose outstanding is > creditDays old
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { writeAudit, ET, ACT } from '../lib/audit.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'];

/**
 * Write one PartyLedger row and update Party.outstanding atomically.
 * Always called inside a Prisma $transaction (tx).
 */
async function writeLedgerEntry(tx, { shopId, partyId, entryType, debitAmount = 0, creditAmount = 0, invoiceId = null, referenceNo = null, notes = null, createdBy = null }) {
  // Atomic increment — avoids read-modify-write race when two transactions hit the same party concurrently
  const updated = await tx.party.update({
    where: { partyId },
    data:  { outstanding: { increment: debitAmount - creditAmount } },
    select: { outstanding: true },
  });
  const balanceAfter = Number(updated.outstanding);

  await tx.partyLedger.create({
    data: {
      shopId,
      partyId,
      entryType,
      debitAmount,
      creditAmount,
      balanceAfter,
      invoiceId:   invoiceId   || null,
      referenceNo: referenceNo || null,
      notes:       notes       || null,
      createdBy:   createdBy   || null,
    },
  });

  return balanceAfter;
}

// ─── GET / — list parties ─────────────────────────────────────────────────────
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { type, search, includeInactive } = req.query;
    const where = { shopId: req.shopId, deletedAt: null };

    if (includeInactive !== 'true') where.isActive = true;
    // BOTH parties act as customers AND suppliers — include them in either filtered view.
    if (type && VALID_TYPES.includes(type)) {
      where.type = type === 'BOTH' ? 'BOTH' : { in: [type, 'BOTH'] };
    }
    if (search) {
      where.OR = [
        { name:  { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { gstin: { contains: search, mode: 'insensitive' } },
      ];
    }

    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10), 0);

    const [parties, total] = await Promise.all([
      prisma.party.findMany({
        where,
        orderBy: [{ outstanding: 'desc' }, { name: 'asc' }],
        take:    limit,
        skip:    offset,
      }),
      prisma.party.count({ where }),
    ]);

    res.set('Cache-Control', 'private, max-age=15, must-revalidate');
    res.json({ success: true, parties, total, limit, offset });
  } catch (err) { next(err); }
});

// ─── POST / — create party ────────────────────────────────────────────────────
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { name, phone, email, gstin, address, type, creditLimit, creditDays, notes, openingBalance } = req.body;

    if (!name?.trim()) return res.status(400).json({ success: false, error: { message: 'Party name is required' } });

    const party = await prisma.$transaction(async (tx) => {
      const p = await tx.party.create({
        data: {
          shopId:      req.shopId,
          name:        name.trim(),
          phone:       phone       || null,
          email:       email       || null,
          gstin:       gstin       || null,
          address:     address     || null,
          type:        type        || 'CUSTOMER',
          creditLimit: creditLimit ? parseFloat(creditLimit) : 0,
          creditDays:  creditDays  ? parseInt(creditDays)    : 30,
          notes:       notes       || null,
          outstanding: 0,
        },
      });

      // Write opening balance if provided
      if (openingBalance && parseFloat(openingBalance) !== 0) {
        const amt = parseFloat(openingBalance);
        await writeLedgerEntry(tx, {
          shopId:    req.shopId,
          partyId:   p.partyId,
          entryType: 'OPENING_BALANCE',
          debitAmount:  amt > 0 ? amt  : 0,
          creditAmount: amt < 0 ? -amt : 0,
          notes:     'Opening balance',
          createdBy: req.user.userId,
        });
        // Re-fetch with updated outstanding
        return tx.party.findUnique({ where: { partyId: p.partyId } });
      }
      return p;
    });

    writeAudit(req, { entityType: ET.PARTY, entityId: party.partyId, action: ACT.CREATE, newValue: { name: party.name, type: party.type, creditLimit: String(party.creditLimit) } });
    res.status(201).json({ success: true, party });
  } catch (err) { next(err); }
});

// ─── GET /:id — single party ──────────────────────────────────────────────────
router.get('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const party = await prisma.party.findFirst({
      where: { partyId: id, shopId: req.shopId },
    });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });
    res.json({ success: true, party });
  } catch (err) { next(err); }
});

// ─── PUT /:id — update party ──────────────────────────────────────────────────
router.put('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const party = await prisma.party.findFirst({
      where: { partyId: id, shopId: req.shopId },
    });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });

    const { name, phone, email, gstin, address, type, creditLimit, creditDays, notes } = req.body;
    const data = {};
    if (name        !== undefined) data.name        = name.trim();
    if (phone       !== undefined) data.phone       = phone || null;
    if (email       !== undefined) data.email       = email || null;
    if (gstin       !== undefined) data.gstin       = gstin || null;
    if (address     !== undefined) data.address     = address || null;
    if (type        !== undefined && VALID_TYPES.includes(type)) data.type = type;
    if (creditLimit !== undefined) data.creditLimit = parseFloat(creditLimit);
    if (creditDays  !== undefined) data.creditDays  = parseInt(creditDays);
    if (notes       !== undefined) data.notes       = notes || null;

    const updated = await prisma.party.update({ where: { partyId: id }, data });
    writeAudit(req, { entityType: ET.PARTY, entityId: id, action: ACT.UPDATE, oldValue: { name: party.name }, newValue: data });
    res.json({ success: true, party: updated });
  } catch (err) { next(err); }
});

// ─── DELETE /:id — soft delete ────────────────────────────────────────────────
router.delete('/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const party = await prisma.party.findFirst({
      where: { partyId: id, shopId: req.shopId },
    });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });

    await prisma.party.update({
      where: { partyId: id },
      data:  { isActive: false, deletedAt: new Date() },
    });
    res.json({ success: true, message: 'Party deactivated' });
  } catch (err) { next(err); }
});

// ─── GET /:id/ledger — full udhaar trail ─────────────────────────────────────
// Exported (not just router.get'd here) for the same reason as
// inventory.js's getMovements: Purchase Returns needs to read a supplier's
// ledger to resolve a return, but doesn't need full Parties access. index.js
// registers this exact path with requireSection('parties', 'purchase-returns')
// ahead of the blanket requireSection('parties') that gates everything else
// in this router (create/edit/delete a party, record a payment, etc. stay
// 'parties'-only — this is read access to one party's ledger, not a general
// Parties grant).
export async function getPartyLedger(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const party = await prisma.party.findFirst({
      where: { partyId: id, shopId: req.shopId },
    });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });

    const { limit = 50, offset = 0 } = req.query;

    const [entries, total] = await Promise.all([
      prisma.partyLedger.findMany({
        where: { partyId: id, shopId: req.shopId },
        include: {
          invoice: { select: { invoiceNumber: true, totalAmount: true, invoiceType: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    Math.min(Math.max(parseInt(limit) || 50, 1), 200),
        skip:    Math.max(parseInt(offset) || 0, 0),
      }),
      prisma.partyLedger.count({ where: { partyId: id, shopId: req.shopId } }),
    ]);

    res.json({
      success: true,
      party:   { partyId: party.partyId, name: party.name, outstanding: Number(party.outstanding), creditLimit: Number(party.creditLimit), creditDays: party.creditDays },
      entries,
      total,
    });
  } catch (err) { next(err); }
}

// ─── POST /:id/ledger — manual opening balance / adjustment ──────────────────
router.post('/:id/ledger', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const party = await prisma.party.findFirst({
      where: { partyId: id, shopId: req.shopId },
    });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });

    const VALID_ENTRY_TYPES = ['OPENING_BALANCE', 'ADJUSTMENT'];
    const { entryType, debitAmount, creditAmount, referenceNo, notes } = req.body;

    if (!entryType || !VALID_ENTRY_TYPES.includes(entryType)) {
      return res.status(400).json({ success: false, error: { message: `entryType must be one of: ${VALID_ENTRY_TYPES.join(', ')}` } });
    }
    if ((debitAmount == null || debitAmount === '') && (creditAmount == null || creditAmount === '')) {
      return res.status(400).json({ success: false, error: { message: 'debitAmount or creditAmount is required' } });
    }

    let balanceAfter;
    await prisma.$transaction(async (tx) => {
      balanceAfter = await writeLedgerEntry(tx, {
        shopId:      req.shopId,
        partyId:     id,
        entryType,
        debitAmount:  debitAmount  ? parseFloat(debitAmount)  : 0,
        creditAmount: creditAmount ? parseFloat(creditAmount) : 0,
        referenceNo:  referenceNo || null,
        notes:        notes       || null,
        createdBy:    req.user.userId,
      });
    });

    res.status(201).json({ success: true, newOutstanding: balanceAfter });
  } catch (err) { next(err); }
});

// ─── POST /:id/payment — record payment received ──────────────────────────────
router.post('/:id/payment', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, mode, reference, notes } = req.body;

    if (!amount || !mode) return res.status(400).json({ success: false, error: { message: 'Amount and mode are required' } });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: { message: 'Amount must be a positive number' } });
    }

    const party = await prisma.party.findFirst({
      where: { partyId: id, shopId: req.shopId },
    });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });

    let newOutstanding;
    await prisma.$transaction(async (tx) => {
      // Write ledger entry (credit = reduces outstanding)
      newOutstanding = await writeLedgerEntry(tx, {
        shopId:      req.shopId,
        partyId:     id,
        entryType:   'PAYMENT_RECEIVED',
        creditAmount: parsedAmount,
        referenceNo: reference || null,
        notes:       [
          `Payment via ${mode}`,
          reference && `Ref: ${reference}`,
          notes,
        ].filter(Boolean).join(' · '),
        createdBy: req.user.userId,
      });

      // Create a RECEIPT movement — inventoryId is null (financial-only, no stock change)
      await tx.movement.create({
        data: {
          shopId:      req.shopId,
          inventoryId: null,
          type:        'RECEIPT',
          qty:         0,
          totalAmount: parsedAmount,
          partyId:     parseInt(req.params.id),
          partyName:   party.name,
          paymentMode: mode,
          referenceNumber: reference || null,
          notes:       `Payment from ${party.name} via ${mode}${reference ? ` · Ref: ${reference}` : ''}`,
        },
      });
    });

    res.json({ success: true, newOutstanding });
  } catch (err) { next(err); }
});

// ─── POST /:id/apply-supplier-credit — consume a supplier's owed credit ──────
// A PurchaseReturn resolved as SUPPLIER_CREDIT raises this party's outstanding
// (positive = supplier owes shop, via PURCHASE_RETURN_CREDIT in purchaseReturns.js).
// This endpoint is how that credit actually gets used — "applied against the
// next purchase from that supplier" per the spec — instead of just sitting as a
// status label. PurchaseBill has no amount-payable/paid tracking in this app, so
// there's no bill to auto-deduct from; this is the shop owner's explicit record
// that they've netted the credit off (e.g. paid the supplier that much less).
router.post('/:id/apply-supplier-credit', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, notes } = req.body;

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: { message: 'Amount must be a positive number' } });
    }

    const party = await prisma.party.findFirst({ where: { partyId: id, shopId: req.shopId } });
    if (!party) return res.status(404).json({ success: false, error: { message: 'Party not found' } });
    if (!['SUPPLIER', 'BOTH'].includes(party.type)) {
      return res.status(400).json({ success: false, error: { message: 'Only a supplier party can have supplier credit applied' } });
    }
    const available = Number(party.outstanding);
    if (available <= 0 || parsedAmount > available + 0.01) {
      return res.status(400).json({ success: false, error: { message: `Only ₹${Math.max(available, 0).toFixed(2)} of supplier credit is available` } });
    }

    let newOutstanding;
    await prisma.$transaction(async (tx) => {
      newOutstanding = await writeLedgerEntry(tx, {
        shopId:       req.shopId,
        partyId:      id,
        entryType:    'SUPPLIER_CREDIT_APPLIED',
        creditAmount: parsedAmount,
        notes:        notes || `Applied ₹${parsedAmount.toFixed(2)} supplier credit against a purchase`,
        createdBy:    req.user.userId,
      });
    });

    writeAudit(req, { entityType: ET.PARTY, entityId: id, action: ACT.UPDATE, newValue: { appliedSupplierCredit: parsedAmount } });
    res.json({ success: true, newOutstanding });
  } catch (err) { next(err); }
});

// ─── GET /summary/overdue — parties past their credit days ───────────────────
// WHY the rewrite: the original code ran 1 query for all parties, then 1 query
// PER party to find its oldest invoice — an N+1 that causes 100+ DB round-trips
// when a shop has 100 parties. Rewritten to exactly 2 queries regardless of N.
router.get('/summary/overdue', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const parties = await prisma.party.findMany({
      where:   { shopId: req.shopId, isActive: true, deletedAt: null, outstanding: { gt: 0 } },
      orderBy: { outstanding: 'desc' },
    });

    if (parties.length === 0) {
      return res.json({ success: true, overdue: [], atRisk: [], total: 0 });
    }

    // Fetch all credit invoices for all parties in ONE query, sorted oldest-first.
    // We then group in JS — the first entry per partyId is the oldest invoice.
    const creditInvoices = await prisma.invoice.findMany({
      where: {
        shopId:  req.shopId,
        partyId: { in: parties.map(p => p.partyId) },
        status:  'CREDIT',
      },
      orderBy: { createdAt: 'asc' },
      select:  { partyId: true, createdAt: true, totalAmount: true, invoiceNumber: true },
    });

    // Group: keep only the oldest invoice per party (array already sorted asc)
    const oldestByParty = {};
    for (const inv of creditInvoices) {
      if (!oldestByParty[inv.partyId]) oldestByParty[inv.partyId] = inv;
    }

    const result = parties
      .map(p => {
        const oldestCredit = oldestByParty[p.partyId];
        if (!oldestCredit) return null;
        const daysSince = Math.floor((Date.now() - new Date(oldestCredit.createdAt).getTime()) / 86400000);
        return {
          partyId:     p.partyId,
          name:        p.name,
          phone:       p.phone,
          outstanding: Number(p.outstanding),
          creditLimit: Number(p.creditLimit),
          creditDays:  p.creditDays,
          daysSince,
          isOverdue:   daysSince > p.creditDays,
          oldestUnpaidInvoice: oldestCredit,
        };
      })
      .filter(Boolean);

    res.json({
      success: true,
      overdue: result.filter(p => p.isOverdue),
      atRisk:  result.filter(p => !p.isOverdue),
      total:   result.length,
    });
  } catch (err) { next(err); }
});

export { writeLedgerEntry };
export default router;
