/**
 * auth-dashboard.test.js — GET /api/mechanic/dashboard and GET /api/mechanic/profile
 * commission + rating aggregates added this session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let authState = { userId: 1, shopId: 5 };

vi.mock('../../../src/middleware/auth.js', () => ({
  authenticate: (req, _res, next) => { req.user = { userId: authState.userId }; req.shopId = authState.shopId; next(); },
  requireMechanic: (req, _res, next) => { req.isIndependentMechanic = !authState.shopId; next(); },
}));

vi.mock('../../../src/services/email.js', () => ({
  sendMechanicInviteOtp: vi.fn(), verifyMechanicInviteOtp: vi.fn(),
  sendMechanicWelcomeEmail: vi.fn(), sendEmailOtp: vi.fn(),
}));
vi.mock('../../../src/routes/auth/helpers.js', () => ({
  createSession: vi.fn(), ensureAuthProvider: vi.fn(),
}));
vi.mock('../../../src/services/password.js', () => ({
  generateResetToken: vi.fn(), hashResetToken: vi.fn(), hashPassword: vi.fn(), validatePasswordStrength: vi.fn(),
}));
vi.mock('../../../src/lib/audit.js', () => ({ writeAudit: vi.fn(), ET: {}, ACT: {} }));

import prisma from '../../../src/db/prisma.js';
import mechanicAuthRoutes from '../../../src/routes/mechanic/auth.js';

function sqlRouter(rules) {
  return vi.fn((first, ...rest) => {
    const sql = Array.isArray(first) ? first.join(' ') : String(first);
    const rule = rules.find(r => r.test(sql));
    if (!rule) return Promise.reject(new Error('Unmocked SQL in test: ' + sql.slice(0, 160)));
    return Promise.resolve(typeof rule.impl === 'function' ? rule.impl(sql, rest) : rule.impl);
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mechanic', mechanicAuthRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function unmocked(label) {
  return vi.fn(() => Promise.reject(new Error(`Test forgot to mock ${label}`)));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState = { userId: 1, shopId: 5 };
  prisma.$queryRaw = unmocked('$queryRaw');
  prisma.$queryRawUnsafe = unmocked('$queryRawUnsafe');
});

const COUNT_ROW = {
  pending: '1', in_progress: '2', waiting_parts: '0', ready_for_qc: '0', rework: '0',
  completed_today: '3', active: '3', commission_earned: '1500.00', commission_pending: '500.00',
};

describe('GET /api/mechanic/dashboard', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns commission_earned and commission_pending as numbers', async () => {
    prisma.$queryRawUnsafe = sqlRouter([
      { test: s => s.includes('job_card_feedback'), impl: [{ avg_rating: null, rating_count: '0' }] },
      { test: s => s.includes('FROM job_cards'), impl: [COUNT_ROW] },
    ]);

    const res = await request(app).get('/api/mechanic/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.data.commission_earned).toBe(1500);
    expect(res.body.data.commission_pending).toBe(500);
  });

  it('returns avg_rating rounded to 1 decimal and rating_count as a number', async () => {
    prisma.$queryRawUnsafe = sqlRouter([
      { test: s => s.includes('job_card_feedback'), impl: [{ avg_rating: 4.3333, rating_count: '7' }] },
      { test: s => s.includes('FROM job_cards'), impl: [COUNT_ROW] },
    ]);

    const res = await request(app).get('/api/mechanic/dashboard');

    expect(res.body.data.avg_rating).toBe(4.3);
    expect(res.body.data.rating_count).toBe(7);
  });

  it('returns avg_rating null when the mechanic has no feedback yet', async () => {
    prisma.$queryRawUnsafe = sqlRouter([
      { test: s => s.includes('job_card_feedback'), impl: [{ avg_rating: null, rating_count: '0' }] },
      { test: s => s.includes('FROM job_cards'), impl: [COUNT_ROW] },
    ]);

    const res = await request(app).get('/api/mechanic/dashboard');
    expect(res.body.data.avg_rating).toBeNull();
    expect(res.body.data.rating_count).toBe(0);
  });

  it('defaults commission fields to 0 when null (no commission set on any job)', async () => {
    prisma.$queryRawUnsafe = sqlRouter([
      { test: s => s.includes('job_card_feedback'), impl: [{ avg_rating: null, rating_count: '0' }] },
      { test: s => s.includes('FROM job_cards'), impl: [{ ...COUNT_ROW, commission_earned: null, commission_pending: null }] },
    ]);

    const res = await request(app).get('/api/mechanic/dashboard');
    expect(res.body.data.commission_earned).toBe(0);
    expect(res.body.data.commission_pending).toBe(0);
  });
});

describe('GET /api/mechanic/profile', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('shop mechanic — includes avg_rating alongside job stats', async () => {
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_feedback'), impl: [{ avg_rating: 4.6, rating_count: '5' }] },
      { test: s => s.includes('shop_mechanics'), impl: [{ id: 1, mechanic_role: 'HEAD', name: 'Amit', jobs_completed: '10', jobs_active: '2' }] },
    ]);

    const res = await request(app).get('/api/mechanic/profile');

    expect(res.status).toBe(200);
    expect(res.body.data.avg_rating).toBe(4.6);
    expect(res.body.data.rating_count).toBe(5);
    expect(res.body.data.jobs_completed).toBe(10);
  });

  it('independent mechanic — includes avg_rating too', async () => {
    authState = { userId: 1, shopId: null };
    prisma.$queryRaw = sqlRouter([
      { test: s => s.includes('job_card_feedback'), impl: [{ avg_rating: null, rating_count: '0' }] },
      { test: s => s.includes('FROM users u'), impl: [{ name: 'Amit', mechanic_role: 'INDEPENDENT', jobs_completed: '4', jobs_active: '1' }] },
    ]);

    const res = await request(app).get('/api/mechanic/profile');

    expect(res.status).toBe(200);
    expect(res.body.data.avg_rating).toBeNull();
  });

  it('returns null data (no rating query run) when the profile itself is not found', async () => {
    prisma.$queryRaw = sqlRouter([{ test: s => s.includes('shop_mechanics'), impl: [] }]);
    const res = await request(app).get('/api/mechanic/profile');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});
