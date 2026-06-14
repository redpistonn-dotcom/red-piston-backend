/**
 * billing.js — POS / Invoicing
 *
 * POST /api/billing/invoice                  create sale invoice
 * GET  /api/billing/invoices                 list invoices (with filters)
 * GET  /api/billing/invoice/:id              single invoice detail
 * GET  /api/billing/invoice/:id/pdf          stream PDF
 * POST /api/billing/invoice/:id/send-whatsapp send PDF link via WhatsApp
 * POST /api/billing/invoice/:id/payment      record payment on credit invoice
 */

import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { generateInvoicePdf } from '../services/pdf.js';
import { sendInvoiceWhatsApp } from '../services/whatsapp.js';
import { nextSeq, currentYYYYMM } from '../lib/sequence.js';

const router = Router();

const VALID_INVOICE_TYPES = ['RETAIL', 'CREDIT', 'ESTIMATE', 'RETURN', 'WORKSHOP'];

// ─── Helper: write one PartyLedger debit row (mirrors parties.js helper) ─────
async function writeLedgerDebit(tx, { shopId, partyId, creditAmount = 0, debitAmount = 0, invoiceId, entryType, notes, createdBy }) {
  const party = await tx.party.findUnique({ where: { partyId }, select: { outstanding: true } });
  const balanceAfter = Number(party.outstanding) + debitAmount - creditAmount;

  await tx.partyLedger.create({
    data: { shopId, partyId, entryType, debitAmount, creditAmount, balanceAfter, invoiceId, notes, createdBy: createdBy || null },
  });

  await tx.party.update({ where: { partyId }, data: { outstanding: balanceAfter } });
  return balanceAfter;
}

// ─── POST /api/billing/invoice ────────────────────────────────────────────────
router.post('/invoice', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const {
      items, partyId, partyName, partyPhone, partyGstin,
      billingAddress,
      invoiceType,
      paymentMode, cashAmount, upiAmount, creditAmount,
      upiReference,
      marketplaceOrderId,
      notes,
    } = req.body;

    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in invoice' });

    const invType = invoiceType && VALID_INVOICE_TYPES.includes(invoiceType)
      ? invoiceType
      : (paymentMode === 'CREDIT' ? 'CREDIT' : 'RETAIL');

    // invoiceNumber is generated INSIDE the transaction below via nextSeq()
    // so the counter increment and the invoice INSERT are in the same atomic unit.

    // ── Validate stock + calculate line-item totals ───────────────────────────
    let subtotal = 0, cgst = 0, sgst = 0;
    const processedItems = [];

    for (const item of items) {
      const inv = await prisma.shopInventory.findUnique({
        where:   { inventoryId: item.inventoryId },
        include: { masterPart: true },
      });
      if (!inv || inv.shopId !== req.shopId) {
        throw { status: 400, message: `Invalid inventory item: ${item.inventoryId}` };
      }

      // Pre-flight stock check — provides a user-friendly error message.
      // NOTE: the authoritative atomic guard happens inside the transaction below via
      // updateMany({ where: { stockQty: { gte: qty } } }) — this pre-flight check is
      // only for early UX feedback; it does NOT prevent the race.
      if (invType !== 'ESTIMATE' && inv.stockQty < item.qty) {
        throw { status: 400, message: `Insufficient stock for ${inv.masterPart.partName}: have ${inv.stockQty}, need ${item.qty}` };
      }

      const itemQty = parseInt(item.qty);
      if (!Number.isFinite(itemQty) || itemQty <= 0) {
        throw { status: 400, message: `Invalid quantity for ${inv.masterPart.partName}` };
      }
      const unitPrice  = parseFloat(item.unitPrice || inv.sellingPrice);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw { status: 400, message: `Invalid unit price for ${inv.masterPart.partName}` };
      }
      // Negative discount would silently become a price increase
      const discount   = Math.max(0, parseFloat(item.discount) || 0);
      const taxableAmt = (unitPrice - discount) * itemQty;
      const gstRate    = parseFloat(inv.masterPart.gstRate || 18);
      const itemCgst   = taxableAmt * (gstRate / 2 / 100);
      const itemSgst   = itemCgst;
      const itemTotal  = taxableAmt + itemCgst + itemSgst;

      subtotal += taxableAmt;
      cgst     += itemCgst;
      sgst     += itemSgst;

      processedItems.push({
        inventoryId: item.inventoryId,
        partName:    inv.masterPart.partName,
        brand:       inv.masterPart.brand,
        hsnCode:     inv.masterPart.hsnCode,
        qty:         itemQty,
        unitPrice,
        discount,
        taxableAmt,
        gstRate,
        cgst:        itemCgst,
        sgst:        itemSgst,
        total:       itemTotal,
        buyingPrice: parseFloat(inv.buyingPrice || 0),
      });
    }

    const totalAmount  = subtotal + cgst + sgst;
    const creditAmt    = creditAmount ? parseFloat(creditAmount) : 0;
    const isCreditSale = creditAmt > 0;
    const paidAmount   = totalAmount - creditAmt;

    // ── Create invoice + movements in a single transaction ───────────────────
    const invoice = await prisma.$transaction(async (tx) => {
      // Generate invoice number INSIDE the transaction so the counter increment
      // and the invoice INSERT are in the same atomic unit.  If the transaction
      // rolls back (e.g. stock check fails) the counter rolls back too.
      const yyyymm = currentYYYYMM();
      const seq = await nextSeq(tx, req.shopId, `INV-${yyyymm}`);
      const invoiceNumber = `${yyyymm}-${String(seq).padStart(4, '0')}`;

      const inv = await tx.invoice.create({
        data: {
          invoiceNumber,
          shopId:            req.shopId,
          partyId:           partyId           || null,
          invoiceType:       invType,
          partyName:         partyName         || null,
          partyPhone:        partyPhone        || null,
          partyGstin:        partyGstin        || null,
          billingAddress:    billingAddress    || null,
          subtotal,
          taxableAmount:     subtotal,
          cgst,
          sgst,
          totalAmount,
          paymentMode:       paymentMode       || 'CASH',
          cashAmount:        cashAmount        ? parseFloat(cashAmount)  : null,
          upiAmount:         upiAmount         ? parseFloat(upiAmount)   : null,
          creditAmount:      creditAmt > 0     ? creditAmt               : null,
          paidAmount,
          isCreditSale,
          upiReference:      upiReference      || null,
          marketplaceOrderId: marketplaceOrderId || null,
          status:            isCreditSale ? 'CREDIT' : 'PAID',
          notes:             notes             || null,
          createdBy:         req.user.userId,
          items: {
            create: processedItems.map(item => ({
              inventoryId: item.inventoryId,
              partName:    item.partName,
              brand:       item.brand,
              hsnCode:     item.hsnCode,
              qty:         item.qty,
              unitPrice:   item.unitPrice,
              discount:    item.discount,
              taxableAmt:  item.taxableAmt,
              gstRate:     item.gstRate,
              cgst:        item.cgst,
              sgst:        item.sgst,
              total:       item.total,
            })),
          },
        },
        include: { items: true, shop: true },
      });

      // ── Create SALE movements + decrement stock (skip for ESTIMATE) ─────────
      if (invType !== 'ESTIMATE') {
        for (const item of processedItems) {
          const profit = item.taxableAmt - (item.buyingPrice * item.qty);
          await tx.movement.create({
            data: {
              shopId:       req.shopId,
              inventoryId:  item.inventoryId,
              type:         invType === 'RETURN' ? 'RETURN_OUT' : 'SALE',
              qty:          item.qty,
              unitPrice:    item.unitPrice,
              gstRate:      item.gstRate,
              taxableAmount: item.taxableAmt,
              totalAmount:  item.total,
              gstAmount:    item.cgst + item.sgst,
              profit,
              invoiceId:    inv.invoiceId,
              partyId:      partyId || null,
              referenceNumber: invoiceNumber,
              createdBy:    req.user.userId,
            },
          });

          if (invType === 'RETURN') {
            await tx.shopInventory.update({
              where: { inventoryId: item.inventoryId },
              data:  { stockQty: { increment: item.qty } },
            });
          } else {
            // Atomic decrement: only succeeds when stockQty >= qty at the moment of
            // the UPDATE, eliminating the TOCTOU race between the pre-flight check
            // above and the actual decrement. If count === 0 another request beat us
            // to the last units and we must abort the transaction.
            const deducted = await tx.shopInventory.updateMany({
              where: { inventoryId: item.inventoryId, stockQty: { gte: item.qty } },
              data:  { stockQty: { decrement: item.qty }, lastSoldAt: new Date() },
            });
            if (deducted.count === 0) {
              throw { status: 400, message: `Insufficient stock for ${item.partName} — it was just sold to another customer` };
            }
          }
        }
      }

      // ── Write PartyLedger debit if credit sale ──────────────────────────────
      if (isCreditSale && partyId) {
        await writeLedgerDebit(tx, {
          shopId:      req.shopId,
          partyId,
          debitAmount: creditAmt,
          invoiceId:   inv.invoiceId,
          entryType:   'SALE_CREDIT',
          notes:       `Credit sale — Invoice ${invoiceNumber}`,
          createdBy:   req.user.userId,
        });
      }

      return inv;
    });

    res.json({ success: true, invoice });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ─── GET /api/billing/invoices ────────────────────────────────────────────────
router.get('/invoices', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { startDate, endDate, partyId, paymentMode, invoiceType, status, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };

    if (startDate)   where.createdAt = { gte: new Date(startDate) };
    if (endDate)     where.createdAt = { ...where.createdAt, lte: new Date(endDate) };
    if (partyId)     where.partyId   = partyId;
    if (paymentMode) where.paymentMode = paymentMode;
    if (invoiceType) where.invoiceType = invoiceType;
    if (status)      where.status     = status;

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          items:   { include: { inventory: { include: { masterPart: true } } } },
          party:   { select: { name: true, phone: true } },
          payments: { orderBy: { receivedAt: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({ success: true, invoices, total });
  } catch (err) { next(err); }
});

// ─── GET /api/billing/invoice/:id ────────────────────────────────────────────
router.get('/invoice/:id', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where:   { invoiceId: req.params.id, shopId: req.shopId },
      include: {
        items:    { include: { inventory: { include: { masterPart: true } } } },
        party:    { select: { name: true, phone: true, gstin: true, creditDays: true } },
        payments: { orderBy: { receivedAt: 'desc' } },
        shop:     true,
      },
    });
    if (!invoice) return res.status(404).json({ success: false, error: { message: 'Invoice not found' } });
    res.json({ success: true, invoice });
  } catch (err) { next(err); }
});

// ─── GET /api/billing/invoice/:id/pdf ────────────────────────────────────────
// Accessible by the shop owner OR the marketplace customer linked to this invoice.
router.get('/invoice/:id/pdf', authenticate, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where:   { invoiceId: req.params.id },
      include: { items: true, shop: true },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const isShopOwner = req.user.shopId === invoice.shopId;
    let isLinkedCustomer = false;
    if (!isShopOwner && invoice.marketplaceOrderId) {
      const order = await prisma.marketplaceOrder.findFirst({
        where: { orderId: invoice.marketplaceOrderId, customerId: req.user.userId },
        select: { orderId: true },
      });
      isLinkedCustomer = !!order;
    }
    if (!isShopOwner && !isLinkedCustomer) return res.status(404).json({ error: 'Invoice not found' });

    const pdfBuffer = await generateInvoicePdf(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoiceNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

// ─── GET /api/billing/customer/invoices — customer's own invoice history ──────
// Returns invoices linked to marketplace orders placed by the authenticated user.
router.get('/customer/invoices', authenticate, async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const parsedLimit  = Math.min(Math.max(parseInt(limit)  || 20, 1), 100);
    const parsedOffset = Math.max(parseInt(offset) || 0, 0);

    const orders = await prisma.marketplaceOrder.findMany({
      where:  { customerId: req.user.userId },
      select: { orderId: true },
    });

    if (orders.length === 0) return res.json({ success: true, invoices: [], total: 0 });

    const orderIds = orders.map(o => o.orderId);
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where:   { marketplaceOrderId: { in: orderIds } },
        include: {
          items: true,
          shop:  { select: { shopName: true, address: true } },
        },
        orderBy: { createdAt: 'desc' },
        take:    parsedLimit,
        skip:    parsedOffset,
      }),
      prisma.invoice.count({ where: { marketplaceOrderId: { in: orderIds } } }),
    ]);

    res.json({ success: true, invoices, total });
  } catch (err) {
    console.error('[GET /billing/customer/invoices]', err);
    next(err);
  }
});

// ─── POST /api/billing/invoice/:id/send-whatsapp ─────────────────────────────
router.post('/invoice/:id/send-whatsapp', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where:   { invoiceId: req.params.id },
      include: { items: true, shop: true },
    });
    if (!invoice || invoice.shopId !== req.shopId) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.partyPhone) return res.status(400).json({ error: 'No phone number for this customer' });

    const pdfUrl = invoice.pdfUrl || `${process.env.FRONTEND_APP_URL}/api/billing/invoice/${invoice.invoiceId}/pdf`;
    const result = await sendInvoiceWhatsApp(
      invoice.partyPhone,
      invoice.partyName,
      invoice.invoiceNumber,
      invoice.totalAmount,
      pdfUrl
    );

    // Track when WhatsApp was sent
    if (result.success) {
      await prisma.invoice.update({
        where: { invoiceId: invoice.invoiceId },
        data:  { whatsappSentAt: new Date() },
      });
    }

    res.json({ success: result.success });
  } catch (err) { next(err); }
});

// ─── POST /api/billing/invoice/:id/payment ───────────────────────────────────
router.post('/invoice/:id/payment', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { amount, mode, reference, note } = req.body;

    if (!amount || !mode) {
      return res.status(400).json({ success: false, error: { message: 'amount and mode are required' } });
    }

    const invoice = await prisma.invoice.findFirst({
      where: { invoiceId: req.params.id, shopId: req.shopId },
    });
    if (!invoice) return res.status(404).json({ success: false, error: { message: 'Invoice not found' } });

    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ success: false, error: { message: 'Amount must be a positive number' } });
    }

    await prisma.$transaction(async (tx) => {
      await tx.invoicePayment.create({
        data: {
          invoiceId: invoice.invoiceId,
          amount:    parsedAmount,
          mode,
          reference: reference || null,
          note:      note      || null,
        },
      });

      // Write ledger credit (reduces outstanding) if party linked
      if (invoice.partyId && invoice.status === 'CREDIT') {
        await writeLedgerDebit(tx, {
          shopId:       req.shopId,
          partyId:      invoice.partyId,
          creditAmount: parsedAmount,
          invoiceId:    invoice.invoiceId,
          entryType:    'PAYMENT_RECEIVED',
          notes:        `Payment received — Invoice ${invoice.invoiceNumber} via ${mode}`,
          createdBy:    req.user.userId,
        });
      }

      // Mark invoice PAID if full amount covered
      const totalPaid = await tx.invoicePayment.aggregate({
        where: { invoiceId: invoice.invoiceId },
        _sum:  { amount: true },
      });
      const paidSoFar = parseFloat(totalPaid._sum.amount || 0);
      if (paidSoFar >= parseFloat(invoice.totalAmount)) {
        await tx.invoice.update({
          where: { invoiceId: invoice.invoiceId },
          data:  { status: 'PAID', paidAmount: paidSoFar },
        });
      }
    });

    const payments = await prisma.invoicePayment.findMany({
      where:   { invoiceId: invoice.invoiceId },
      orderBy: { receivedAt: 'desc' },
    });

    res.status(201).json({ success: true, data: payments });
  } catch (err) { next(err); }
});

export default router;
