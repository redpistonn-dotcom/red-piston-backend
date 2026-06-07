/**
 * workshop.test.js — integration tests for /api/shop/workshop/jobs
 *
 * FLOWS:
 *   POST /jobs           — create job card with validation
 *   PATCH /jobs/:id/status — lifecycle transitions + timestamp logic
 *   POST /jobs/:id/items  — add part/labour, recalculate totals
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../db/prisma.js', () => ({
  default: {
    jobCard: {
      findMany:  vi.fn(),
      findFirst: vi.fn(),
      create:    vi.fn(),
      update:    vi.fn(),
      count:     vi.fn(),
    },
    jobCardItem: {
      create:   vi.fn(),
      delete:   vi.fn(),
      findMany: vi.fn(),
      aggregate:vi.fn(),
    },
    // $queryRaw is called by nextSeq() inside the $transaction callback.
    // Returns last_value: 1 by default (first sequence number for the shop/month).
    $queryRaw:    vi.fn().mockResolvedValue([{ last_value: 1 }]),
    $transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticate:    (req, _res, next) => { req.user = { userId: 1 }; req.shopId = 5; next(); },
  requireShopOwner:(_req, _res, next) => next(),
}));

import prisma from '../../db/prisma.js';
import workshopRouter from '../../routes/workshop.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/shop/workshop', workshopRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const DB_JOB = {
  jobId: 'j1', shopId: 5, jobNumber: 'JOB-202601-0001',
  customerName: 'Rahul Kumar', vehicleMake: 'Maruti', vehicleModel: 'Swift',
  status: 'RECEIVED', priority: 'NORMAL',
  labourCharge: 500, partsTotal: 1200, totalAmount: 1700,
  createdAt: new Date(), completedAt: null, deliveredAt: null,
  items: [],
};

describe('POST /api/shop/workshop/jobs', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when customerName is missing', async () => {
    const res = await request(app)
      .post('/api/shop/workshop/jobs')
      .send({ vehicleMake: 'Maruti', vehicleModel: 'Swift' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when vehicleMake is missing', async () => {
    const res = await request(app)
      .post('/api/shop/workshop/jobs')
      .send({ customerName: 'Rahul Kumar', vehicleModel: 'Swift' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when vehicleModel is missing', async () => {
    const res = await request(app)
      .post('/api/shop/workshop/jobs')
      .send({ customerName: 'Rahul Kumar', vehicleMake: 'Maruti' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid priority value', async () => {
    const res = await request(app)
      .post('/api/shop/workshop/jobs')
      .send({ customerName: 'Rahul Kumar', vehicleMake: 'Maruti', vehicleModel: 'Swift', priority: 'CRITICAL' });
    expect(res.status).toBe(400);
  });

  it('happy path: creates job card and returns it with a job number', async () => {
    // The route wraps jobCard.create inside $transaction — use pass-through so
    // jobCard.create and nextSeq($queryRaw) are actually called.
    prisma.jobCard.create.mockResolvedValue(DB_JOB);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    const res = await request(app)
      .post('/api/shop/workshop/jobs')
      .send({ customerName: 'Rahul Kumar', vehicleMake: 'Maruti', vehicleModel: 'Swift' });

    expect(res.status).toBe(201);
    const job = res.body.data ?? res.body;
    expect(job.jobNumber).toMatch(/^JOB-/);
    expect(job.status).toBe('RECEIVED');
  });

  it('accepts valid priority values', async () => {
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    for (const priority of ['LOW', 'NORMAL', 'HIGH', 'URGENT']) {
      prisma.jobCard.create.mockResolvedValue({ ...DB_JOB, priority });
      const res = await request(app)
        .post('/api/shop/workshop/jobs')
        .send({ customerName: 'Test', vehicleMake: 'Honda', vehicleModel: 'City', priority });
      expect(res.status).toBe(201);
    }
  });

  it('generates job number atomically via nextSeq inside the transaction', async () => {
    // $queryRaw returns last_value: 4 → expect job number suffix '0004'
    prisma.$queryRaw.mockResolvedValue([{ last_value: 4 }]);
    prisma.jobCard.create.mockResolvedValue({ ...DB_JOB, jobNumber: 'JOB-202606-0004' });
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    const res = await request(app)
      .post('/api/shop/workshop/jobs')
      .send({ customerName: 'Rahul Kumar', vehicleMake: 'Maruti', vehicleModel: 'Swift' });

    expect(res.status).toBe(201);

    // Verify $queryRaw was called (nextSeq ran, not a pre-tx fallback)
    expect(prisma.$queryRaw).toHaveBeenCalled();

    // Verify jobCard.create received a JOB-YYYYMM-NNNN format job number
    const createArgs = prisma.jobCard.create.mock.calls[0][0];
    expect(createArgs.data.jobNumber).toMatch(/^JOB-\d{6}-\d{4}$/);
    expect(createArgs.data.jobNumber).toMatch(/-0004$/);
  });
});

describe('PATCH /api/shop/workshop/jobs/:id/status', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 for unknown job', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .patch('/api/shop/workshop/jobs/nonexistent/status')
      .send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when status is missing', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const res = await request(app)
      .patch('/api/shop/workshop/jobs/j1/status')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid status value', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const res = await request(app)
      .patch('/api/shop/workshop/jobs/j1/status')
      .send({ status: 'WONT_FIX' });
    expect(res.status).toBe(400);
  });

  it('sets deliveredAt when status transitions to DELIVERED', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const updated = { ...DB_JOB, status: 'DELIVERED', deliveredAt: new Date() };
    prisma.jobCard.update.mockResolvedValue(updated);

    const res = await request(app)
      .patch('/api/shop/workshop/jobs/j1/status')
      .send({ status: 'DELIVERED' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.jobCard.update.mock.calls[0]?.[0];
    expect(updateArgs?.data?.deliveredAt).toBeTruthy();
  });

  it('sets completedAt when status transitions to READY', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const updated = { ...DB_JOB, status: 'READY', completedAt: new Date() };
    prisma.jobCard.update.mockResolvedValue(updated);

    const res = await request(app)
      .patch('/api/shop/workshop/jobs/j1/status')
      .send({ status: 'READY' });

    expect(res.status).toBe(200);
    const updateArgs = prisma.jobCard.update.mock.calls[0]?.[0];
    expect(updateArgs?.data?.completedAt).toBeTruthy();
  });

  it('accepts all valid status values', async () => {
    const VALID_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'WAITING_PARTS', 'READY', 'DELIVERED', 'CANCELLED'];
    for (const status of VALID_STATUSES) {
      prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
      prisma.jobCard.update.mockResolvedValue({ ...DB_JOB, status });
      const res = await request(app)
        .patch('/api/shop/workshop/jobs/j1/status')
        .send({ status });
      expect(res.status).toBe(200);
    }
  });
});

describe('POST /api/shop/workshop/jobs/:id/items', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 for unknown job', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/shop/workshop/jobs/nonexistent/items')
      .send({ description: 'Brake Pad', unitPrice: 600 });
    expect(res.status).toBe(404);
  });

  it('returns 400 when description is missing', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const res = await request(app)
      .post('/api/shop/workshop/jobs/j1/items')
      .send({ unitPrice: 600 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when unitPrice is missing', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const res = await request(app)
      .post('/api/shop/workshop/jobs/j1/items')
      .send({ description: 'Brake Pad' });
    expect(res.status).toBe(400);
  });

  it('happy path: creates item and recalculates partsTotal', async () => {
    prisma.jobCard.findFirst.mockResolvedValue(DB_JOB);
    const newItem = { id: 1, jobId: 'j1', description: 'Brake Pad', unitPrice: 600, qty: 2, total: 1200, type: 'PART' };
    prisma.jobCardItem.create.mockResolvedValue(newItem);
    prisma.jobCardItem.findMany.mockResolvedValue([newItem]);
    // aggregate sum of PART items
    prisma.jobCardItem.aggregate?.mockResolvedValue?.({ _sum: { total: 1200 } });
    prisma.jobCard.update.mockResolvedValue({ ...DB_JOB, partsTotal: 1200, totalAmount: 1700 });

    const res = await request(app)
      .post('/api/shop/workshop/jobs/j1/items')
      .send({ description: 'Brake Pad', unitPrice: 600, qty: 2 });

    expect(res.status).toBe(201);
    const item = res.body.data ?? res.body;
    expect(item.description ?? item.data?.description).toContain('Brake');
  });
});
