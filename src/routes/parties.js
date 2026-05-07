import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';

const router = Router();

// GET /api/shop/parties
router.get('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { type } = req.query;
    const where = { shopId: req.shopId, isActive: true };
    if (type) where.type = type;

    const parties = await prisma.party.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    res.json({ parties });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/parties
router.post('/', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { name, phone, gstin, address, type, creditLimit, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const party = await prisma.party.create({
      data: {
        shopId: req.shopId,
        name,
        phone,
        gstin,
        address,
        type: type || 'CUSTOMER',
        creditLimit: creditLimit ? parseFloat(creditLimit) : 0,
        notes,
      },
    });
    res.json({ success: true, party });
  } catch (err) {
    next(err);
  }
});

// GET /api/shop/parties/:id/ledger
router.get('/:id/ledger', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const party = await prisma.party.findUnique({ where: { partyId: req.params.id } });
    if (!party || party.shopId !== req.shopId) return res.status(404).json({ error: 'Party not found' });

    const invoices = await prisma.invoice.findMany({
      where: { shopId: req.shopId, partyId: req.params.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ party, invoices, outstanding: party.outstanding });
  } catch (err) {
    next(err);
  }
});

// POST /api/shop/parties/:id/payment
router.post('/:id/payment', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { amount, mode, reference, notes } = req.body;
    if (!amount || !mode) return res.status(400).json({ error: 'Amount and mode required' });

    const party = await prisma.party.findUnique({ where: { partyId: req.params.id } });
    if (!party || party.shopId !== req.shopId) return res.status(404).json({ error: 'Party not found' });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    // Use a transaction: update outstanding + create a RECEIPT movement for the audit trail
    let updatedParty;
    await prisma.$transaction(async (tx) => {
      updatedParty = await tx.party.update({
        where: { partyId: req.params.id },
        data: { outstanding: { decrement: parsedAmount } },
      });

      // Find any inventory item from this shop to satisfy the FK on movement.inventoryId.
      // RECEIPT movements are financial-only — they carry no stock change.
      // We attach them to the first available inventory row for the shop so referential
      // integrity is maintained without requiring a nullable inventoryId in the schema.
      const anyInv = await tx.shopInventory.findFirst({ where: { shopId: req.shopId } });
      if (anyInv) {
        await tx.movement.create({
          data: {
            shopId: req.shopId,
            inventoryId: anyInv.inventoryId,
            type: 'RECEIPT',
            qty: 0,
            totalAmount: parsedAmount,
            partyId: req.params.id,
            notes: [
              `Payment from ${party.name} via ${mode}`,
              reference && `Ref: ${reference}`,
              notes,
            ].filter(Boolean).join(' · '),
          },
        });
      }
    });

    // Use the updated value from the transaction result, not the stale snapshot
    const newOutstanding = Number(updatedParty.outstanding);
    res.json({ success: true, newOutstanding });
  } catch (err) {
    next(err);
  }
});

export default router;
