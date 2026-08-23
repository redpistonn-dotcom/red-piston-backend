/**
 * jobs.test.js — mechanic job-card routes added/changed this session:
 *   POST   /jobs                    — push notification when self-assigning vs assigning to a team member
 *   PATCH  /jobs/:id/status         — WhatsApp preview in the response
 *   POST   /jobs/:id/part-requests  — WhatsApp "extra work found" preview
 *   PATCH  /jobs/:id/assign         — push notification to the new assignee
 *   PATCH  /jobs/:id/commission     — HEAD/creator-only commission setting
 *   POST   /jobs/:id/calls          — call log + customer-decision + WhatsApp confirmation
 *   GET    /jobs/:id/calls          — call log listing
 *   GET    /jobs/:id                — now includes `calls`
 *   POST   /push/register-token
 *
 * Approach: prisma's raw-SQL methods are mocked with a tiny "SQL router" that
 * matches on a snippet of the query text, so tests don't depend on the exact
 * call order inside a handler — only on what SQL shape is expected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Auth state, mutable per test ────────────────────────────────────────────
let authState = { userId: 1, shopId: 5, mechanicRecord: { mechanic_role: 'MEMBER' } };

vi.mock('../../../src/middleware/auth.js', () => ({
  authenticate: (req, _res, next) => { req.user = { userId: authState.userId }; req.shopId = authState.shopId; next(); },
  requireMechanic: (req, _res, next) => {
    req.mechanicRecord = authState.mechanicRecord;
    req.isIndependentMechanic = !authState.shopId;
    next();
  },
  requireMechanicSection: () => (_req, _res, next) => next(),
}));

const sendPushToUser = vi.fn();
const registerPushToken = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/push.js', () => ({
  sendPushToUser: (...args) => sendPushToUser(...args),
  registerPushToken: (...args) => registerPushToken(...args),
}));

vi.mock('../../../src/lib/audit.js', () => ({
  writeAudit: vi.fn(),
  ET: { ORDER: 'ORDER' },
  ACT: { UPDATE: 'UPDATE', CREATE: 'CREATE' },
}));

vi.mock('../../../src/lib/sequence.js', () => ({
  nextSeq: vi.fn().mockResolvedValue(1),
  currentYYYYMM: () => '202601',
}));

import prisma from '../../../src/db/prisma.js';
import jobsRouter from '../../../src/routes/mechanic/jobs.js';

function sqlRouter(rules) {
  return vi.fn((first, ...rest) => {
    const sql = Array.isArray(first) ? first.join(' ') : String(first);
    const rule = rules.find(r => r.test(sql));
    if (!rule) return Promise.reject(new Error('Unmocked SQL in test: ' + sql.slice(0, 160)));
    const result = typeof rule.impl === 'function' ? rule.impl(sql, rest) : rule.impl;
    return Promise.resolve(result);
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mechanic', jobsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const BASE_JOB = {
  job_id: 10, shop_id: 5, status: 'RECEIVED', created_by: 1, assigned_to_user_id: 1,
  job_number: 'JOB-202601-0001', customer_name: 'Rahul Kumar', customer_phone: '9876543210',
  vehicle_make: 'Maruti', vehicle_model: 'Swift', vehicle_reg: 'KA01AB1234',
  mechanic_commission: null, commission_note: null,
};

function unmocked(label) {
  return vi.fn(() => Promise.reject(new Error(`Test forgot to mock ${label} for this call`)));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState = { userId: 1, shopId: 5, mechanicRecord: { mechanic_role: 'MEMBER' } };
  // Every raw-SQL method starts as a loud failure — each test must set up
  // exactly the query shapes its code path will hit. Prevents a mock left
  // over from a previous test silently answering the wrong query.
  prisma.$queryRaw = unmocked('$queryRaw');
  prisma.$queryRawUnsafe = unmocked('$queryRawUnsafe');
  prisma.$executeRaw = unmocked('$executeRaw');
  prisma.$executeRawUnsafe = unmocked('$executeRawUnsafe');
});

// ────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/mechanic/jobs/:id/commission', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('rejects a non-numeric amount', async () => {
    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
  });

  it('rejects a negative amount', async () => {
    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: -50 });
    expect(res.status).toBe(400);
  });

  it('accepts zero as a valid amount', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('shop_id'), impl: [BASE_JOB] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);
    authState.mechanicRecord = { mechanic_role: 'HEAD' };
    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 0 });
    expect(res.status).toBe(200);
  });

  it('rejects a note longer than 255 characters', async () => {
    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 100, note: 'x'.repeat(256) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOTE_TOO_LONG');
  });

  it('404s when the job does not exist in this shop', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('shop_id'), impl: [] }]);
    authState.mechanicRecord = { mechanic_role: 'HEAD' };
    const res = await request(app).patch('/api/mechanic/jobs/999/commission').send({ amount: 100 });
    expect(res.status).toBe(404);
  });

  it('403s a shop mechanic who is not HEAD', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('shop_id'), impl: [BASE_JOB] }]);
    authState.mechanicRecord = { mechanic_role: 'MEMBER' };
    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 100 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('403s an independent mechanic who did not create the job', async () => {
    authState = { userId: 2, shopId: null, mechanicRecord: null };
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('created_by'), impl: [{ ...BASE_JOB, shop_id: null, created_by: 99 }] }]);
    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 100 });
    expect(res.status).toBe(403);
  });

  it('200s for a HEAD mechanic and writes the update + timeline', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('shop_id'), impl: [BASE_JOB] }]);
    const executeRaw = vi.fn().mockResolvedValue(undefined);
    prisma.$executeRaw = executeRaw;
    authState.mechanicRecord = { mechanic_role: 'HEAD' };

    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 500, note: 'For engine work' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ jobId: 10, mechanicCommission: 500, commissionNote: 'For engine work' });
    expect(executeRaw).toHaveBeenCalledTimes(2); // UPDATE job_cards + INSERT timeline
  });

  it('200s for an independent mechanic who created the job', async () => {
    authState = { userId: 1, shopId: null, mechanicRecord: null };
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('created_by'), impl: [{ ...BASE_JOB, shop_id: null, created_by: 1 }] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);

    const res = await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 300 });
    expect(res.status).toBe(200);
  });

  it('sends a push to the assigned mechanic when commission is set', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('shop_id'), impl: [{ ...BASE_JOB, assigned_to_user_id: 42 }] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);
    authState.mechanicRecord = { mechanic_role: 'HEAD' };

    await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 500 });

    expect(sendPushToUser).toHaveBeenCalledWith(42, expect.objectContaining({ title: 'Commission set for your job' }));
  });

  it('does not push when the job has no assigned mechanic', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('shop_id'), impl: [{ ...BASE_JOB, assigned_to_user_id: null }] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);
    authState.mechanicRecord = { mechanic_role: 'HEAD' };

    await request(app).patch('/api/mechanic/jobs/10/commission').send({ amount: 500 });
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/mechanic/jobs/:id/calls', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  function mockLoadJob(job = BASE_JOB) {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [job] }]);
  }

  it('rejects an invalid purpose', async () => {
    mockLoadJob();
    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'CHIT_CHAT', outcome: 'DISCUSSED' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PURPOSE');
  });

  it('rejects an invalid outcome', async () => {
    mockLoadJob();
    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'GENERAL', outcome: 'MAYBE' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OUTCOME');
  });

  it('rejects notes over 1000 characters', async () => {
    mockLoadJob();
    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'GENERAL', outcome: 'DISCUSSED', notes: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOTE_TOO_LONG');
  });

  it('404s when the job is not assigned to this mechanic', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [] }]);
    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'GENERAL', outcome: 'DISCUSSED' });
    expect(res.status).toBe(404);
  });

  it('404s when partRequestId does not belong to this job', async () => {
    mockLoadJob();
    prisma.$queryRaw = sqlRouter([{ test: s => s.includes('job_card_part_requests'), impl: [] }]);
    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'EXTRA_WORK_APPROVAL', outcome: 'APPROVED', partRequestId: 5 });
    expect(res.status).toBe(404);
  });

  it('logs a GENERAL call with no part request and returns a WhatsApp preview', async () => {
    mockLoadJob();
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('INSERT INTO job_card_calls'), impl: [{ id: 1, job_id: 10, purpose: 'GENERAL', outcome: 'DISCUSSED' }] },
    ]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined); // timeline write

    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'GENERAL', outcome: 'DISCUSSED', notes: 'Discussed schedule' });

    expect(res.status).toBe(201);
    expect(res.body.data.whatsapp.text).toContain('Discussed schedule');
    expect(res.body.data.whatsapp.link).toMatch(/^https:\/\/wa\.me\//);
  });

  it('APPROVED outcome with a part request updates customer_decision and confirms in the WhatsApp text', async () => {
    mockLoadJob();
    const partRequest = { id: 5, job_id: 10, description: 'Brake pad', qty_requested: 2, unit_price: 500 };
    let updateCalled = false;
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_part_requests') && s.includes('SELECT'), impl: [partRequest] },
      { test: s => s.includes('INSERT INTO job_card_calls'), impl: [{ id: 1 }] },
    ]);
    prisma.$executeRaw = vi.fn().mockImplementation((strings) => {
      if (strings.join(' ').includes('customer_decision')) updateCalled = true;
      return Promise.resolve(undefined);
    });

    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'EXTRA_WORK_APPROVAL', outcome: 'APPROVED', partRequestId: 5 });

    expect(res.status).toBe(201);
    expect(updateCalled).toBe(true);
    expect(res.body.data.whatsapp.text).toContain("you've approved: Brake pad x2");
  });

  it('REJECTED outcome confirms decline in the WhatsApp text', async () => {
    mockLoadJob();
    const partRequest = { id: 5, job_id: 10, description: 'Brake pad', qty_requested: 2, unit_price: 500 };
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_part_requests') && s.includes('SELECT'), impl: [partRequest] },
      { test: s => s.includes('INSERT INTO job_card_calls'), impl: [{ id: 1 }] },
    ]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);

    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'EXTRA_WORK_APPROVAL', outcome: 'REJECTED', partRequestId: 5 });

    expect(res.status).toBe(201);
    expect(res.body.data.whatsapp.text).toContain("you've declined: Brake pad");
  });

  it('NO_ANSWER outcome with a part request does NOT update customer_decision', async () => {
    mockLoadJob();
    const partRequest = { id: 5, job_id: 10, description: 'Brake pad', qty_requested: 2, unit_price: 500 };
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_part_requests') && s.includes('SELECT'), impl: [partRequest] },
      { test: s => s.includes('INSERT INTO job_card_calls'), impl: [{ id: 1 }] },
    ]);
    const executeRaw = vi.fn().mockResolvedValue(undefined);
    prisma.$executeRaw = executeRaw;

    const res = await request(app).post('/api/mechanic/jobs/10/calls').send({ purpose: 'EXTRA_WORK_APPROVAL', outcome: 'NO_ANSWER', partRequestId: 5 });

    expect(res.status).toBe(201);
    // Only the timeline INSERT should have run — no customer_decision UPDATE.
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/mechanic/jobs/:id/calls', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('404s when the job is not the mechanic’s own', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [] }]);
    const res = await request(app).get('/api/mechanic/jobs/10/calls');
    expect(res.status).toBe(404);
  });

  it('returns the call log for the job', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [BASE_JOB] }]);
    prisma.$queryRaw = sqlRouter([{ test: () => true, impl: [{ id: 1, purpose: 'GENERAL', outcome: 'DISCUSSED' }] }]);
    const res = await request(app).get('/api/mechanic/jobs/10/calls');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/mechanic/jobs/:id/status — WhatsApp preview', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('rejects an invalid status', async () => {
    const res = await request(app).patch('/api/mechanic/jobs/10/status').send({ status: 'NOT_A_STATUS' });
    expect(res.status).toBe(400);
  });

  it('404s when the job is not assigned to this mechanic', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [] }]);
    const res = await request(app).patch('/api/mechanic/jobs/10/status').send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(404);
  });

  it('422s an invalid transition', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [{ ...BASE_JOB, status: 'DELIVERED' }] }]);
    const res = await request(app).patch('/api/mechanic/jobs/10/status').send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('returns a WhatsApp preview matching the new status on success', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [{ ...BASE_JOB, status: 'RECEIVED' }] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);

    const res = await request(app).patch('/api/mechanic/jobs/10/status').send({ status: 'IN_PROGRESS' });

    expect(res.status).toBe(200);
    expect(res.body.data.whatsapp.text).toContain('Work has started on your vehicle.');
    expect(res.body.data.whatsapp.link).toMatch(/^https:\/\/wa\.me\/919876543210/);
  });

  it('returns a null WhatsApp link when the customer has no phone on file', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [{ ...BASE_JOB, status: 'RECEIVED', customer_phone: null }] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);

    const res = await request(app).patch('/api/mechanic/jobs/10/status').send({ status: 'IN_PROGRESS' });
    expect(res.body.data.whatsapp.link).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/mechanic/jobs/:id/part-requests — WhatsApp preview', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('rejects a missing description', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [BASE_JOB] }]);
    const res = await request(app).post('/api/mechanic/jobs/10/part-requests').send({});
    expect(res.status).toBe(400);
  });

  it('returns a WhatsApp "extra work found" preview including qty and cost', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [BASE_JOB] }]);
    prisma.$queryRaw = sqlRouter([{
      test: s => s.includes('INSERT INTO job_card_part_requests'),
      impl: [{ id: 9, description: 'Clutch cable', qty_requested: 1, unit_price: 250 }],
    }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined); // timeline write

    const res = await request(app).post('/api/mechanic/jobs/10/part-requests').send({ description: 'Clutch cable', qtyRequested: 1, unitPrice: 250 });

    expect(res.status).toBe(201);
    expect(res.body.data.whatsapp.text).toContain('Clutch cable x1');
    expect(res.body.data.whatsapp.text).toContain('₹250.00');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('PATCH /api/mechanic/jobs/:id/assign — push on reassignment', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('rejects a missing memberId', async () => {
    const res = await request(app).patch('/api/mechanic/jobs/10/assign').send({});
    expect(res.status).toBe(400);
  });

  it('403s when the target is not a registered team member', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('mechanic_team'), impl: [] }]);
    const res = await request(app).patch('/api/mechanic/jobs/10/assign').send({ memberId: 42 });
    expect(res.status).toBe(403);
  });

  it('sends a push to the newly assigned member on success', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: s => s.includes('mechanic_team'), impl: [{ owner_user_id: 1, member_user_id: 42 }] }]);
    prisma.$executeRawUnsafe = sqlRouter([{ test: s => s.includes('UPDATE job_cards'), impl: 1 }]);

    const res = await request(app).patch('/api/mechanic/jobs/10/assign').send({ memberId: 42 });

    expect(res.status).toBe(200);
    expect(sendPushToUser).toHaveBeenCalledWith(42, expect.objectContaining({ title: 'Job reassigned to you' }));
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/mechanic/jobs — push on team assignment', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  const validBody = { customerName: 'Rahul Kumar', vehicleMake: 'Maruti', vehicleModel: 'Swift' };

  it('does not push when the mechanic self-assigns (default)', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [{ job_id: 10, job_number: 'JOB-202601-0001', status: 'RECEIVED', created_at: new Date() }] }]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);

    const res = await request(app).post('/api/mechanic/jobs').send(validBody);

    expect(res.status).toBe(201);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('pushes to the team member when the job is assigned to someone else', async () => {
    authState = { userId: 1, shopId: null, mechanicRecord: null }; // independent mechanic — assignedTo path allowed
    prisma.$queryRawUnsafe = sqlRouter([
      { test: s => s.includes('mechanic_team'), impl: [{ owner_user_id: 1, member_user_id: 42 }] },
      { test: s => s.includes('INSERT INTO job_cards'), impl: [{ job_id: 10, job_number: 'JOB-202601-0001', status: 'RECEIVED', created_at: new Date() }] },
    ]);
    prisma.$executeRaw = vi.fn().mockResolvedValue(undefined);

    const res = await request(app).post('/api/mechanic/jobs').send({ ...validBody, assignedTo: '42' });

    expect(res.status).toBe(201);
    expect(sendPushToUser).toHaveBeenCalledWith(42, expect.objectContaining({ title: 'New job assigned' }));
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/mechanic/push/register-token', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('rejects a missing token', async () => {
    const res = await request(app).post('/api/mechanic/push/register-token').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
  });

  it('rejects a non-string token', async () => {
    const res = await request(app).post('/api/mechanic/push/register-token').send({ token: 12345 });
    expect(res.status).toBe(400);
  });

  it('registers the token and defaults platform to WEB', async () => {
    const res = await request(app).post('/api/mechanic/push/register-token').send({ token: 'fcm-token-abc' });
    expect(res.status).toBe(200);
    expect(registerPushToken).toHaveBeenCalledWith(1, 'fcm-token-abc', 'WEB');
  });

  it('passes through an explicit platform', async () => {
    await request(app).post('/api/mechanic/push/register-token').send({ token: 'tok', platform: 'ANDROID' });
    expect(registerPushToken).toHaveBeenCalledWith(1, 'tok', 'ANDROID');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/mechanic/jobs/:id — includes calls', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('includes an empty calls array when there are none', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [BASE_JOB] }]);
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_items'), impl: [] },
      { test: s => s.includes('job_card_timeline'), impl: [] },
      { test: s => s.includes('job_card_photos'), impl: [] },
      { test: s => s.includes('job_card_calls'), impl: [] },
    ]);

    const res = await request(app).get('/api/mechanic/jobs/10');
    expect(res.status).toBe(200);
    expect(res.body.data.calls).toEqual([]);
  });

  it('includes populated call rows', async () => {
    prisma.$queryRawUnsafe = sqlRouter([{ test: () => true, impl: [BASE_JOB] }]);
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_items'), impl: [] },
      { test: s => s.includes('job_card_timeline'), impl: [] },
      { test: s => s.includes('job_card_photos'), impl: [] },
      { test: s => s.includes('job_card_calls'), impl: [{ id: 1, purpose: 'GENERAL', outcome: 'DISCUSSED' }] },
    ]);

    const res = await request(app).get('/api/mechanic/jobs/10');
    expect(res.body.data.calls).toHaveLength(1);
  });
});
