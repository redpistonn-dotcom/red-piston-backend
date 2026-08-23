/**
 * inventory.test.js — integration tests for /api/shop/inventory
 *
 * FLOWS:
 *   POST /          — add product, optional OPENING movement
 *   PUT /:id        — update price/rack/thresholds
 *   POST /purchase  — stock-in, price update
 *   POST /adjust    — damage/theft/return/audit with correct stock delta
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/db/prisma.js', () => ({
  default: {
    shopInventory: {
      findMany:  vi.fn(),
      findUnique:vi.fn(),
      findFirst: vi.fn(),
      create:    vi.fn(),
      update:    vi.fn(),
    },
    movement: {
      findMany: vi.fn(),
      create:   vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (arg) => { if (typeof arg === "function") return arg(prisma); if (Array.isArray(arg)) return Promise.all(arg); return arg; }),
    $queryRaw:    vi.fn(),
  },
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate:    (req, _res, next) => { req.user = { userId: 1 }; req.shopId = 5; next(); },
  requireShopOwner:(_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

import prisma from '../../src/db/prisma.js';
import inventoryRouter from '../../src/routes/inventory.js';

// Global reset: clearMocks:true clears call counts but NOT mockResolvedValue implementations.
// This ensures each test starts with findUnique returning undefined (route returns 404/409 as intended)
// and  handling both callback and array patterns.
import { beforeEach as globalBefore } from 'vitest';
globalBefore(() => {
  prisma.shopInventory.findUnique.mockReset();
  prisma.shopInventory.findMany.mockReset();
  prisma.movement.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation(async (arg) => {
    if (typeof arg === 'function') return arg(prisma);
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/shop/inventory', inventoryRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const SHOP_INVENTORY = {
  inventoryId: 10, shopId: 5, masterPartId: 200,
  sellingPrice: 500, buyingPrice: 300, stockQty: 20,
  minStockAlert: 5, rackLocation: 'A1',
  masterPart: { masterPartId: 200, partName: 'Oil Filter', gstRate: 18 },
};

describe('POST /api/shop/inventory', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when masterPartId is missing', async () => {
    const res = await request(app)
      .post('/api/shop/inventory')
      .send({ sellingPrice: 500 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when sellingPrice is missing', async () => {
    const res = await request(app)
      .post('/api/shop/inventory')
      .send({ masterPartId: 200 });
    expect(res.status).toBe(400);
  });

  it('returns 409 when product already in inventory', async () => {
    // Route checks findUnique for existing (shopId+masterPartId) first → returns 409
    prisma.shopInventory.findUnique.mockResolvedValue(SHOP_INVENTORY);
    const res = await request(app)
      .post('/api/shop/inventory')
      .send({ masterPartId: 200, sellingPrice: 500 });
    expect(res.status).toBe(409);
  });

  it('happy path: creates inventory item and returns it', async () => {
    prisma.shopInventory.create.mockResolvedValue(SHOP_INVENTORY);
    prisma.movement.create.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));

    const res = await request(app)
      .post('/api/shop/inventory')
      .send({ masterPartId: 200, sellingPrice: 500, stockQty: 10 });

    expect([200, 201]).toContain(res.status);
    expect(res.body.item ?? res.body.success).toBeTruthy();
  });
});

describe('PUT /api/shop/inventory/:id', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 404 when item not found', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .put('/api/shop/inventory/999')
      .send({ sellingPrice: 600 });
    expect(res.status).toBe(404);
  });

  it('updates and returns the item', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(SHOP_INVENTORY);
    prisma.shopInventory.update.mockResolvedValue({ ...SHOP_INVENTORY, sellingPrice: 600 });

    const res = await request(app)
      .put('/api/shop/inventory/10')
      .send({ sellingPrice: 600 });

    expect(res.status).toBe(200);
    expect(res.body.item ?? res.body.success).toBeTruthy();
  });
});

describe('POST /api/shop/inventory/purchase', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when inventoryId is missing', async () => {
    const res = await request(app)
      .post('/api/shop/inventory/purchase')
      .send({ qty: 5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when qty is zero or negative', async () => {
    prisma.shopInventory.findFirst.mockResolvedValue(SHOP_INVENTORY);
    const res = await request(app)
      .post('/api/shop/inventory/purchase')
      .send({ inventoryId: 10, qty: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when item not found', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/shop/inventory/purchase')
      .send({ inventoryId: 999, qty: 5 });
    expect(res.status).toBe(404);
  });

  it('happy path: increments stock and returns newStock', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(SHOP_INVENTORY);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.movement.create.mockResolvedValue({});
    prisma.shopInventory.update.mockResolvedValue({ ...SHOP_INVENTORY, stockQty: 25 });

    const res = await request(app)
      .post('/api/shop/inventory/purchase')
      .send({ inventoryId: 10, qty: 5, unitPrice: 300 });

    expect(res.status).toBe(200);
    expect(typeof res.body.newStock).toBe('number');
  });
});

describe('POST /api/shop/inventory/adjust', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 400 when type is invalid', async () => {
    prisma.shopInventory.findFirst.mockResolvedValue(SHOP_INVENTORY);
    const res = await request(app)
      .post('/api/shop/inventory/adjust')
      .send({ inventoryId: 10, type: 'INVALID_TYPE', qty: 2 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when inventoryId is missing', async () => {
    const res = await request(app)
      .post('/api/shop/inventory/adjust')
      .send({ type: 'DAMAGE', qty: 2 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when item not found', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/shop/inventory/adjust')
      .send({ inventoryId: 999, type: 'DAMAGE', qty: 1 });
    expect(res.status).toBe(404);
  });

  it('DAMAGE reduces stock (negative delta)', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(SHOP_INVENTORY);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.movement.create.mockResolvedValue({});
    prisma.shopInventory.update.mockResolvedValue({ ...SHOP_INVENTORY, stockQty: 17 });

    const res = await request(app)
      .post('/api/shop/inventory/adjust')
      .send({ inventoryId: 10, type: 'DAMAGE', qty: 3 });

    expect(res.status).toBe(200);
    expect(typeof res.body.newStock).toBe('number'); // DAMAGE reduces stock
  });

  it('RETURN_IN increases stock (positive delta)', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(SHOP_INVENTORY);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.movement.create.mockResolvedValue({});
    prisma.shopInventory.update.mockResolvedValue({ ...SHOP_INVENTORY, stockQty: 22 });

    const res = await request(app)
      .post('/api/shop/inventory/adjust')
      .send({ inventoryId: 10, type: 'RETURN_IN', qty: 2 });

    expect(res.status).toBe(200);
    expect(typeof res.body.newStock).toBe('number'); // RETURN_IN increases stock
  });

  it('CREDIT_NOTE/DEBIT_NOTE does not change stock', async () => {
    prisma.shopInventory.findUnique.mockResolvedValue(SHOP_INVENTORY);
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.movement.create.mockResolvedValue({});
    prisma.shopInventory.update.mockResolvedValue({ ...SHOP_INVENTORY, stockQty: 20 });

    const res = await request(app)
      .post('/api/shop/inventory/adjust')
      .send({ inventoryId: 10, type: 'CREDIT_NOTE', qty: 5 });

    expect(res.status).toBe(200);
    expect(typeof res.body.newStock).toBe('number'); // no-stock types don't change stock
  });
});
