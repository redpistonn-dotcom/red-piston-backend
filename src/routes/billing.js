import { Router } from 'express';
import prisma from '../db/prisma.js';
import { authenticate, requireShopOwner } from '../middleware/auth.js';
import { generateInvoicePdf } from '../services/pdf.js';
import { sendInvoiceWhatsApp } from '../services/whatsapp.js';

const router = Router();

// Generate invoice number: YYYYMM-XXXX
async function generateInvoiceNumber(shopId) {
  const now = new Date();
  const prefix = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastInvoice = await prisma.invoice.findFirst({
    where: { shopId, invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: 'desc' },
  });
  let seq = 1;
  if (lastInvoice) {
    const lastSeq = parseInt(lastInvoice.invoiceNumber.split('-')[1]);
    seq = lastSeq + 1;
  }
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

// POST /api/billing/invoice
router.post('/invoice', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { items, partyId, partyName, partyPhone, partyGstin, paymentMode, cashAmount, upiAmount, creditAmount, notes } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'No items in invoice' });

    const invoiceNumber = await generateInvoiceNumber(req.shopId);

    // Validate stock and calculate totals
    let subtotal = 0, cgst = 0, sgst = 0;
    const processedItems = [];

    for (const item of items) {
      const inv = await prisma.shopInventory.findUnique({
        where: { inventoryId: item.inventoryId },
        include: { masterPart: true },
      });
      if (!inv || inv.shopId !== req.shopId) throw { status: 400, message: `Invalid inventory item: ${item.inventoryId}` };

      const currentStock = inv.stockQty; // use cached for speed
      if (currentStock < item.qty) throw { status: 400, message: `Insufficient stock for ${inv.masterPart.partName}: have ${currentStock}, need ${item.qty}` };

      const unitPrice = parseFloat(item.unitPrice || inv.sellingPrice);
      const discount = parseFloat(item.discount || 0);
      const taxableAmt = (unitPrice - discount) * item.qty;
      const gstRate = parseFloat(inv.masterPart.gstRate || 18);
      const itemCgst = taxableAmt * (gstRate / 2 / 100);
      const itemSgst = itemCgst;
      const itemTotal = taxableAmt + itemCgst + itemSgst;

      subtotal += taxableAmt;
      cgst += itemCgst;
      sgst += itemSgst;

      processedItems.push({
        inventoryId: item.inventoryId,
        partName: inv.masterPart.partName,
        hsnCode: inv.masterPart.hsnCode,
        qty: item.qty,
        unitPrice,
        discount,
        taxableAmt,
        gstRate,
        cgst: itemCgst,
        sgst: itemSgst,
        total: itemTotal,
        buyingPrice: parseFloat(inv.buyingPrice || 0),
      });
    }

    const totalAmount = subtotal + cgst + sgst;

    // Create invoice + movements in a transaction
    const invoice = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          invoiceNumber,
          shopId: req.shopId,
          partyId,
          partyName,
          partyPhone,
          partyGstin,
          subtotal,
          taxableAmount: subtotal,
          cgst,
          sgst,
          totalAmount,
          paymentMode: paymentMode || 'CASH',
          cashAmount: cashAmount ? parseFloat(cashAmount) : null,
          upiAmount: upiAmount ? parseFloat(upiAmount) : null,
          creditAmount: creditAmount ? parseFloat(creditAmount) : null,
          status: paymentMode === 'CREDIT' ? 'CREDIT' : 'PAID',
          notes,
          items: {
            create: processedItems.map(item => ({
              inventoryId: item.inventoryId,
              partName: item.partName,
              hsnCode: item.hsnCode,
              qty: item.qty,
              unitPrice: item.unitPrice,
              discount: item.discount,
              taxableAmt: item.taxableAmt,
              gstRate: item.gstRate,
              cgst: item.cgst,
              sgst: item.sgst,
              total: item.total,
            })),
          },
        },
        include: { items: true, shop: true },
      });

      // Create sale movements and update stock for each item
      for (const item of processedItems) {
        const profit = item.taxableAmt - (item.buyingPrice * item.qty);
        await tx.movement.create({
          data: {
            shopId: req.shopId,
            inventoryId: item.inventoryId,
            type: 'SALE',
            qty: item.qty,
            unitPrice: item.unitPrice,
            totalAmount: item.total,
            gstAmount: item.cgst + item.sgst,
            profit,
            invoiceId: inv.invoiceId,
            partyId,
          },
        });
        await tx.shopInventory.update({
          where: { inventoryId: item.inventoryId },
          data: { stockQty: { decrement: item.qty } },
        });
      }

      // If credit sale, update party outstanding
      if (partyId && creditAmount && parseFloat(creditAmount) > 0) {
        await tx.party.update({
          where: { partyId },
          data: { outstanding: { increment: parseFloat(creditAmount) } },
        });
      }

      return inv;
    });

    res.json({ success: true, invoice });
  } catch (err) {
    next(err);
  }
});

// GET /api/billing/invoice/:id/pdf
router.get('/invoice/:id/pdf', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { invoiceId: req.params.id },
      include: { items: true, shop: true },
    });
    if (!invoice || invoice.shopId !== req.shopId) return res.status(404).json({ error: 'Invoice not found' });

    const pdfBuffer = await generateInvoicePdf(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoice.invoiceNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// POST /api/billing/invoice/:id/send-whatsapp
router.post('/invoice/:id/send-whatsapp', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { invoiceId: req.params.id },
      include: { items: true, shop: true },
    });
    if (!invoice || invoice.shopId !== req.shopId) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.partyPhone) return res.status(400).json({ error: 'No phone number for this customer' });

    const pdfUrl = invoice.pdfUrl || `${process.env.FRONTEND_URL}/api/billing/invoice/${invoice.invoiceId}/pdf`;
    const result = await sendInvoiceWhatsApp(invoice.partyPhone, invoice.partyName, invoice.invoiceNumber, invoice.totalAmount, pdfUrl);

    res.json({ success: result.success });
  } catch (err) {
    next(err);
  }
});

// POST /api/billing/invoice/:id/payment — record a payment against a credit invoice
router.post('/invoice/:id/payment', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { amount, mode, reference, note } = req.body;

    if (!amount || !mode) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_FIELDS', message: 'amount and mode are required' },
      });
    }

    const invoice = await prisma.invoice.findFirst({
      where: { invoiceId: req.params.id, shopId: req.shopId },
    });
    if (!invoice) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Invoice not found' } });
    }

    const parsedAmount = parseFloat(amount);

    await prisma.$transaction(async (tx) => {
      await tx.invoicePayment.create({
        data: {
          invoiceId: invoice.invoiceId,
          amount: parsedAmount,
          mode,
          reference: reference || null,
          note: note || null,
        },
      });

      // Reduce party outstanding if this invoice had a credit component
      if (invoice.partyId && invoice.status === 'CREDIT') {
        await tx.party.update({
          where: { partyId: invoice.partyId },
          data: { outstanding: { decrement: parsedAmount } },
        });
      }

      // Mark invoice as PAID if the full amount is covered (simple check: update always; UI handles partial)
      const totalPaid = await tx.invoicePayment.aggregate({
        where: { invoiceId: invoice.invoiceId },
        _sum: { amount: true },
      });
      const paidSoFar = parseFloat(totalPaid._sum.amount || 0);
      if (paidSoFar >= parseFloat(invoice.totalAmount)) {
        await tx.invoice.update({
          where: { invoiceId: invoice.invoiceId },
          data: { status: 'PAID' },
        });
      }
    });

    const payments = await prisma.invoicePayment.findMany({
      where: { invoiceId: invoice.invoiceId },
      orderBy: { receivedAt: 'desc' },
    });

    res.status(201).json({ success: true, data: payments });
  } catch (err) {
    next(err);
  }
});

// GET /api/billing/invoices
router.get('/invoices', authenticate, requireShopOwner, async (req, res, next) => {
  try {
    const { startDate, endDate, partyId, paymentMode, limit = 50, offset = 0 } = req.query;
    const where = { shopId: req.shopId };
    if (startDate) where.createdAt = { gte: new Date(startDate) };
    if (endDate) where.createdAt = { ...where.createdAt, lte: new Date(endDate) };
    if (partyId) where.partyId = partyId;
    if (paymentMode) where.paymentMode = paymentMode;

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: { items: { include: { inventory: { include: { masterPart: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({ invoices, total });
  } catch (err) {
    next(err);
  }
});

export default router;
