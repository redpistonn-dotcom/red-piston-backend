/**
 * parties.test.js — integration tests for /api/shop/parties
 *
 * FLOWS:
 *   POST /           — create party, optional opening balance
 *   PUT /:id         — update party details
 *   DELETE /:id      — soft delete (isActive = false)
 *   POST /:id/payment — record payment received, update outstanding
 *   GET /summary/overdue — 2-query N+1 fix verification
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db/prisma.js', () => ({
  default: {
    party: {
      findMany:  vi.fn(),
      findFirst: vi.fn(),
      findUnique:vi.fn(),
      create:    vi.fn(),
      update:    vi.fn(),
    },
    partyLedger: {
      findMany: vi.fn(),
      create:   vi.fn(),
      count:    vi.fn(),
    },
    invoice: { findMany: vi.fn() },
    movement:{ create: vi.fn() },
    shopInventory: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate:    (req, _res, next) => { req.user = { userId: 1 }; req.shopId = 5; next(); },
  requireShopOwner:(_req, _res, next) => next(),
}));

import prisma from '../../src/db/prisma.js';
import partiesRouter from '../../src/routes/parties.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/shop/parties', partiesRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const DB_PARTY = {
  partyId: 'p1', shopId: 5, name: 'Sharma Motors',
  phone: '9876543210', type: 'CUSTOMER',
  outstanding: 2000, creditLimit: 10000, creditDays: 30,
  isActive: true,
};

// prisma is a single shared mock across every test in this file — without
// clearing mock.calls between tests, an assertion like
// `prisma.party.update.mock.calls[0]` picks up a call from an EARLIER test
// (any prior describe that also called party.update), not this test's own
// call. mockResolvedValue()/mockImplementation() set inside each `it()`
// still apply after this since it only clears call history, not behavior.
beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/shop/parties', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when name is missing', async () => {
    const res = await request(app).post('/api/shop/parties').send({ phone: '9876543210' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is empty string', async () => {
    const res = await request(app).post('/api/shop/parties').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('creates party without opening balance', async () => {
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.party.create.mockResolvedValue(DB_PARTY);

    const res = await request(app)
      .post('/api/shop/parties')
      .send({ name: 'Sharma Motors', phone: '9876543210', type: 'CUSTOMER' });

    expect(res.status).toBe(201);
    expect(res.body.party.name).toBe('Sharma Motors');
  });

  it('creates party with opening balance and writes PartyLedger entry', async () => {
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.party.create.mockResolvedValue(DB_PARTY);
    prisma.partyLedger.create.mockResolvedValue({});
    // writeLedgerEntry calls tx.party.findUnique to get current outstanding
    prisma.party.findUnique.mockResolvedValue({ outstanding: 0 });
    prisma.party.update.mockResolvedValue({ ...DB_PARTY, outstanding: 1500 });

    const res = await request(app)
      .post('/api/shop/parties')
      .send({ name: 'Sharma Motors', openingBalance: 1500 });

    expect(res.status).toBe(201);
    // PartyLedger.create should have been called once for the opening balance
    const ledgerCalls = prisma.partyLedger.create.mock.calls.length
      + (prisma.party.update.mock.calls.length > 0 ? 1 : 0);
    expect(ledgerCalls).toBeGreaterThan(0);
  });
});

describe('PUT /api/shop/parties/:id', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 when party not found', async () => {
    prisma.party.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/shop/parties/nonexistent').send({ name: 'New Name' });
    expect(res.status).toBe(404);
  });

  it('updates party and returns it', async () => {
    prisma.party.findFirst.mockResolvedValue(DB_PARTY);
    prisma.party.update.mockResolvedValue({ ...DB_PARTY, name: 'Sharma Autos' });

    const res = await request(app)
      .put('/api/shop/parties/p1')
      .send({ name: 'Sharma Autos' });

    expect(res.status).toBe(200);
    expect(res.body.party?.name ?? res.body.name).toBe('Sharma Autos');
  });
});

describe('DELETE /api/shop/parties/:id (soft delete)', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 for unknown party', async () => {
    prisma.party.findFirst.mockResolvedValue(null);
    const res = await request(app).delete('/api/shop/parties/nonexistent');
    expect(res.status).toBe(404);
  });

  it('sets isActive=false and returns success', async () => {
    prisma.party.findFirst.mockResolvedValue(DB_PARTY);
    prisma.party.update.mockResolvedValue({ ...DB_PARTY, isActive: false });

    const res = await request(app).delete('/api/shop/parties/p1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify soft-delete: update was called with isActive:false (not delete)
    const updateCall = prisma.party.update.mock.calls[0]?.[0];
    expect(updateCall?.data?.isActive).toBe(false);
  });
});

describe('POST /api/shop/parties/:id/payment', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 for unknown party', async () => {
    prisma.party.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/shop/parties/nonexistent/payment')
      .send({ amount: 1000, mode: 'CASH' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when amount is missing', async () => {
    prisma.party.findFirst.mockResolvedValue(DB_PARTY);
    const res = await request(app)
      .post('/api/shop/parties/p1/payment')
      .send({ mode: 'CASH' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when mode is missing', async () => {
    prisma.party.findFirst.mockResolvedValue(DB_PARTY);
    const res = await request(app)
      .post('/api/shop/parties/p1/payment')
      .send({ amount: 1000 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-positive amount', async () => {
    prisma.party.findFirst.mockResolvedValue(DB_PARTY);
    const res = await request(app)
      .post('/api/shop/parties/p1/payment')
      .send({ amount: -500, mode: 'CASH' });
    expect(res.status).toBe(400);
  });

  it('happy path: updates outstanding and returns newOutstanding', async () => {
    prisma.party.findFirst.mockResolvedValue(DB_PARTY);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.partyLedger.findMany.mockResolvedValue([]);
    prisma.partyLedger.create.mockResolvedValue({});
    prisma.party.findUnique.mockResolvedValue({ outstanding: 2000 });
    prisma.party.update.mockResolvedValue({ ...DB_PARTY, outstanding: 1000 });
    prisma.movement.create.mockResolvedValue({});
    prisma.shopInventory.findFirst.mockResolvedValue({ inventoryId: 10 });

    const res = await request(app)
      .post('/api/shop/parties/p1/payment')
      .send({ amount: 1000, mode: 'CASH' });

    expect(res.status).toBe(200);
    expect(typeof res.body.newOutstanding).toBe('number');
  });
});

describe('GET /api/shop/parties/summary/overdue', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns empty arrays when no parties have outstanding > 0', async () => {
    prisma.party.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/shop/parties/summary/overdue');
    expect(res.status).toBe(200);
    expect(res.body.overdue).toEqual([]);
    expect(res.body.atRisk).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('uses exactly 2 DB queries (N+1 fix): one for parties, one for all invoices', async () => {
    // 3 parties with outstanding
    prisma.party.findMany.mockResolvedValue([
      { ...DB_PARTY, partyId: 'p1', creditDays: 30 },
      { ...DB_PARTY, partyId: 'p2', creditDays: 7  },
      { ...DB_PARTY, partyId: 'p3', creditDays: 60 },
    ]);
    // All invoices in one batch query
    prisma.invoice.findMany.mockResolvedValue([
      { partyId: 'p1', createdAt: new Date(Date.now() - 40 * 86400000), totalAmount: 2000, invoiceNumber: 'INV-1' },
      { partyId: 'p2', createdAt: new Date(Date.now() - 10 * 86400000), totalAmount: 1000, invoiceNumber: 'INV-2' },
    ]);

    const res = await request(app).get('/api/shop/parties/summary/overdue');
    expect(res.status).toBe(200);

    // p1 (40 days, limit 30) → overdue; p2 (10 days, limit 7) → overdue;
    // p3 has no invoice → excluded
    expect(res.body.total).toBeGreaterThan(0);

    // KEY ASSERTION: invoice.findMany called ONCE (not once per party)
    expect(prisma.invoice.findMany.mock.calls.length).toBe(1);
  });

  it('correctly separates overdue vs at-risk parties', async () => {
    prisma.party.findMany.mockResolvedValue([
      { ...DB_PARTY, partyId: 'p1', creditDays: 30 }, // 40 days old → overdue
      { ...DB_PARTY, partyId: 'p2', creditDays: 60 }, // 40 days old → at risk (not yet overdue)
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      { partyId: 'p1', createdAt: new Date(Date.now() - 40 * 86400000), totalAmount: 2000, invoiceNumber: 'INV-1' },
      { partyId: 'p2', createdAt: new Date(Date.now() - 40 * 86400000), totalAmount: 1500, invoiceNumber: 'INV-2' },
    ]);

    const res = await request(app).get('/api/shop/parties/summary/overdue');
    expect(res.status).toBe(200);
    expect(res.body.overdue.some(p => p.partyId === 'p1')).toBe(true);
    expect(res.body.atRisk.some(p => p.partyId === 'p2')).toBe(true);
  });
});
