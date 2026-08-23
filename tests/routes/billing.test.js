/**
 * billing.test.js — integration tests for POST /api/billing/invoice
 *
 * FLOW: items[] → stock check → Invoice + InvoiceItems + Movements (in tx)
 *       → optional PartyLedger debit → response
 *
 * WHY test billing: every invoice touches inventory stock, movements,
 * and possibly party outstanding. A bug here silently miscounts stock
 * or corrupts the Udhaar ledger for real customers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../src/db/prisma.js', () => ({
  default: {
    shopInventory: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    invoice:       { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    invoiceItem:   { create: vi.fn() },
    movement:      { create: vi.fn() },
    party:         { findUnique: vi.fn(), update: vi.fn() },
    partyLedger:   { create: vi.fn(), findMany: vi.fn() },
    invoicePayment:{ create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    // GST place-of-supply lookup (billing.js createInvoice) — null keeps the
    // pre-existing intra-state default so it doesn't perturb these tests.
    shop:          { findUnique: vi.fn().mockResolvedValue(null) },
    // $queryRaw is used by nextSeq() inside $transaction — must be in the tx object.
    // We mock it here on `prisma` itself because tests that call
    // $transaction.mockImplementation(fn => fn(prisma)) pass `prisma` as `tx`.
    $queryRaw:     vi.fn().mockResolvedValue([{ last_value: 1 }]),
    $transaction:  vi.fn(),
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate:    (req, _res, next) => { req.user = { userId: 1 }; req.shopId = 5; next(); },
  requireShopOwner:(req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

vi.mock('../../src/services/email.js',     () => ({ sendInvoiceEmail: vi.fn() }));
vi.mock('../../src/services/whatsapp.js',  () => ({ sendInvoiceWhatsApp: vi.fn() }));

import prisma from '../../src/db/prisma.js';
import billingRouter from '../../src/routes/billing.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/billing', billingRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

// Fixtures
const INVENTORY_ITEM = {
  inventoryId: 10, shopId: 5,
  sellingPrice: 500, buyingPrice: 300, stockQty: 20,
  masterPart: { partName: 'Brake Pad', gstRate: 18, hsnCode: '8708' },
};

const CREATED_INVOICE = {
  invoiceId: 'inv-001', shopId: 5, invoiceNumber: 'INV-001',
  subtotal: 1000, totalAmount: 1180, status: 'PAID',
  items: [{ inventoryId: 10, qty: 2, unitPrice: 500, total: 1000 }],
  shop: { name: 'Test Shop' },
};

describe('POST /api/billing/invoice', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when items array is missing', async () => {
    const res = await request(app).post('/api/billing/invoice').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when items array is empty', async () => {
    const res = await request(app).post('/api/billing/invoice').send({ items: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 INSUFFICIENT_STOCK when qty exceeds available stock', async () => {
    prisma.shopInventory.findMany.mockResolvedValue([{ ...INVENTORY_ITEM, stockQty: 1 }]);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    const res = await request(app)
      .post('/api/billing/invoice')
      .send({ items: [{ inventoryId: 10, qty: 5, unitPrice: 500 }] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/stock/i);
  });

  it('happy path: creates invoice and returns it', async () => {
    prisma.shopInventory.findMany.mockResolvedValue([INVENTORY_ITEM]);
    prisma.$transaction.mockResolvedValue(CREATED_INVOICE);

    const res = await request(app)
      .post('/api/billing/invoice')
      .send({ items: [{ inventoryId: 10, qty: 2, unitPrice: 500 }], paymentMode: 'CASH' });

    expect(res.status).toBe(200);
    expect(res.body.invoice ?? res.body.data ?? res.body).toMatchObject(
      expect.objectContaining({ invoiceNumber: expect.any(String) })
    );
  });

  it('passes invoiceType ESTIMATE without touching stock', async () => {
    // ESTIMATE type should NOT reduce stock
    const inventoryBefore = { ...INVENTORY_ITEM };
    prisma.shopInventory.findMany.mockResolvedValue([inventoryBefore]);
    prisma.$transaction.mockResolvedValue({ ...CREATED_INVOICE, status: 'ESTIMATE' });

    const res = await request(app)
      .post('/api/billing/invoice')
      .send({ items: [{ inventoryId: 10, qty: 100 }], invoiceType: 'ESTIMATE' });

    // Should not fail with stock check since it's an estimate
    expect(res.status).not.toBe(400);
  });

  it('generates invoice number atomically via nextSeq inside the transaction', async () => {
    // When the transaction callback is executed (not short-circuited with .mockResolvedValue),
    // nextSeq() must call $queryRaw and the resulting seq (1) must produce '202606-0001' format.
    prisma.shopInventory.findMany.mockResolvedValue([INVENTORY_ITEM]);
    // $queryRaw is mocked to return last_value: 7 → expect '202606-0007' shape
    prisma.$queryRaw.mockResolvedValue([{ last_value: 7 }]);
    prisma.invoice.create.mockResolvedValue({ ...CREATED_INVOICE, invoiceNumber: '202606-0007' });
    prisma.shopInventory.updateMany.mockResolvedValue({ count: 1 });
    prisma.movement.create.mockResolvedValue({});

    // Let the transaction callback actually run (pass prisma as tx)
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    const res = await request(app)
      .post('/api/billing/invoice')
      .send({ items: [{ inventoryId: 10, qty: 2, unitPrice: 500 }], paymentMode: 'CASH' });

    // The $queryRaw upsert must have been called (proves nextSeq ran, not a pre-tx fallback)
    expect(prisma.$queryRaw).toHaveBeenCalled();

    // The invoice.create call must receive an invoiceNumber matching the
    // current RED-S{shopId}-YYYYMM-NNNN format (billing.js line ~271).
    const createCall = prisma.invoice.create.mock.calls[0][0];
    // Mirrors lib/sequence.js currentYYYYMM() — IST, not local system time,
    // so this doesn't flake near a month boundary in a non-IST CI runner.
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const yyyymm = parts.find(p => p.type === 'year').value + parts.find(p => p.type === 'month').value;
    // shopId=5 (from the authenticate mock above), seq=7 (mocked $queryRaw last_value) → 0007
    expect(createCall.data.invoiceNumber).toBe(`RED-S5-${yyyymm}-0007`);
  });
});

describe('POST /api/billing/invoice/:id/payment', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when amount is missing', async () => {
    prisma.invoice.findFirst.mockResolvedValue(CREATED_INVOICE);
    const res = await request(app)
      .post('/api/billing/invoice/inv-001/payment')
      .send({ mode: 'CASH' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when mode is missing', async () => {
    prisma.invoice.findFirst.mockResolvedValue(CREATED_INVOICE);
    const res = await request(app)
      .post('/api/billing/invoice/inv-001/payment')
      .send({ amount: 500 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when invoice not found', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/billing/invoice/bad-id/payment')
      .send({ amount: 500, mode: 'CASH' });
    expect(res.status).toBe(404);
  });

  it('happy path: records payment and returns payments list', async () => {
    prisma.invoice.findFirst.mockResolvedValue(CREATED_INVOICE);
    prisma.$transaction.mockResolvedValue([]);
    prisma.invoicePayment.findMany.mockResolvedValue([
      { id: 1, amount: 1180, mode: 'CASH', receivedAt: new Date() },
    ]);

    const res = await request(app)
      .post('/api/billing/invoice/inv-001/payment')
      .send({ amount: 1180, mode: 'CASH' });

    expect([200, 201]).toContain(res.status);
  });
});

describe('GET /api/billing/invoice/:id', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 for unknown invoice', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/api/billing/invoice/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns invoice when found', async () => {
    prisma.invoice.findFirst.mockResolvedValue(CREATED_INVOICE);
    const res = await request(app).get('/api/billing/invoice/inv-001');
    expect(res.status).toBe(200);
    expect(res.body.invoice ?? res.body.data).toBeTruthy();
  });
});
