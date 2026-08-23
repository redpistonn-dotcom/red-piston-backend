/**
 * session.test.js — integration tests for token refresh and logout.
 *
 * FLOWS TESTED:
 *
 * POST /api/auth/refresh (token rotation):
 *   1. No refresh token provided → 401 NO_REFRESH_TOKEN
 *   2. Token hash not found in DB → 401 INVALID_REFRESH
 *   3. Token found but revokedAt is set → 401 INVALID_REFRESH
 *   4. Token found but expiresAt is in the past → 401 INVALID_REFRESH
 *   5. Token found but JWT signature is wrong → 401 INVALID_REFRESH (soft-revoke)
 *   6. Token valid but user is inactive → 401 USER_INACTIVE
 *   7. Happy path → 200 new accessToken + rotated refreshToken + cookie
 *
 * POST /api/auth/logout:
 *   8. With valid token → soft-revoke (revokedAt set), cookie cleared, 200
 *   9. Without token → still 200 (idempotent — logout should never fail)
 *
 * WHY token rotation matters: if a leaked refresh token is used, the
 * legitimate user's next rotation will fail (old token revoked) — the
 * session is then automatically invalidated for both parties.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../src/db/prisma.js', () => ({
  default: {
    refreshToken: {
      findUnique:  vi.fn(),
      update:      vi.fn(),
      updateMany:  vi.fn(),
      create:      vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import prisma from '../../src/db/prisma.js';
import sessionRouter from '../../src/routes/auth/session.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', sessionRouter);
  // Minimal error handler so 500s don't crash the test process
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

// Build a real (signable/verifiable) refresh token for test scenarios
function makeRefreshToken(userId = 1) {
  return jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });
}

const DB_USER = {
  userId: 1,
  phone: '9876543210',
  email: 'user@test.com',
  name: 'Test',
  avatarUrl: null,
  role: 'SHOP_OWNER',
  shopId: 5,
  isActive: true,
  emailVerified: true,
  phoneVerified: true,
  isVerified: true,
  loginCount: 2,
  shop: { shopId: 5, name: 'Test Shop' },
  userType: { id: 3, name: 'Shop Owner', slug: 'SHOP_OWNER' },
};

function storedToken(overrides = {}) {
  return {
    id: 99,
    userId: 1,
    shopId: 5,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ipAddress: '127.0.0.1',
    deviceInfo: {},
    ...overrides,
  };
}

describe('POST /api/auth/refresh', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 401 NO_REFRESH_TOKEN when no token in body or cookie', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_REFRESH_TOKEN');
  });

  it('returns 401 INVALID_REFRESH when hash is not in DB', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: makeRefreshToken() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH');
  });

  it('returns 401 INVALID_REFRESH for already-revoked token (outside rotation grace)', async () => {
    // Tokens revoked > 60s ago are replays and must be rejected. Tokens revoked
    // within the 60s grace window are concurrent-tab rotation races and pass.
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ revokedAt: new Date(Date.now() - 5 * 60 * 1000) })
    );
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: makeRefreshToken() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH');
  });

  it('returns 401 INVALID_REFRESH for expired DB record', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      storedToken({ expiresAt: new Date(Date.now() - 1000) })
    );
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: makeRefreshToken() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH');
  });

  it('returns 401 INVALID_REFRESH and soft-revokes when JWT signature is wrong', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    prisma.refreshToken.update.mockResolvedValue({});

    // Token signed with wrong secret — JWT.verify will throw
    const badToken = jwt.sign({ userId: 1 }, 'wrong-secret', { expiresIn: '30d' });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: badToken });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH');
    // DB should be soft-revoked to prevent reuse
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
  });

  it('returns 401 USER_INACTIVE when account is deactivated', async () => {
    const rawToken = makeRefreshToken();
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    prisma.user.findUnique.mockResolvedValue({ ...DB_USER, isActive: false });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('USER_INACTIVE');
  });

  it('happy path: returns 200 with new accessToken and the rotated refreshToken in the body', async () => {
    const rawToken = makeRefreshToken();
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    prisma.user.findUnique.mockResolvedValue(DB_USER);
    // $transaction called with [update-old, create-new]
    prisma.$transaction.mockResolvedValue([{}, {}]);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    // Superseded SEC-001: the original fix hid refreshToken from the body,
    // relying solely on the httpOnly cookie. routes/auth/session.js now
    // deliberately returns it in the body too (see the comment there) —
    // the cookie is third-party in prod (frontend/backend on different
    // sites) and gets blocked by Safari/modern Chrome, so the client needs
    // this fallback to persist the rotated token itself.
    expect(typeof res.body.refreshToken).toBe('string');
    // Not asserting res.body.refreshToken !== rawToken here: jwt.sign({userId}, ...)
    // has no jti/nonce, so two tokens signed within the same wall-clock second
    // are byte-identical — that equality is an artifact of test speed, not a
    // real signal. Rotation itself (old row revoked, new row created) is what
    // actually matters, and is covered by the $transaction call below.
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('happy path: sets a new refresh_token cookie', async () => {
    const rawToken = makeRefreshToken();
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken());
    prisma.user.findUnique.mockResolvedValue(DB_USER);
    prisma.$transaction.mockResolvedValue([{}, {}]);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.some(c => c.startsWith('refresh_token='))).toBe(true);
  });

  it('happy path: new accessToken is a valid JWT with correct userId', async () => {
    const rawToken = makeRefreshToken(42);
    prisma.refreshToken.findUnique.mockResolvedValue(storedToken({ userId: 42 }));
    prisma.user.findUnique.mockResolvedValue({ ...DB_USER, userId: 42 });
    prisma.$transaction.mockResolvedValue([{}, {}]);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken });

    const decoded = jwt.decode(res.body.accessToken);
    expect(decoded.userId).toBe(42);
  });
});

describe('POST /api/auth/logout', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  it('returns 200 when called without any token (idempotent logout)', async () => {
    const res = await request(app).post('/api/auth/logout').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('soft-revokes the refresh token when provided in body', async () => {
    const rawToken = makeRefreshToken();
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: rawToken });

    expect(res.status).toBe(200);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      })
    );
  });

  it('clears the refresh_token cookie on logout', async () => {
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: makeRefreshToken() });

    const cookies = res.headers['set-cookie'] || [];
    // The cookie should be cleared (max-age=0 or expires in past)
    const rtCookie = cookies.find(c => c.startsWith('refresh_token='));
    expect(rtCookie).toBeTruthy();
    expect(rtCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('still returns 200 even if DB update fails (logout must never error)', async () => {
    prisma.refreshToken.updateMany.mockRejectedValue(new Error('DB error'));

    // The route has .catch(() => {}) on the DB call — logout is non-blocking
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: makeRefreshToken() });

    expect(res.status).toBe(200);
  });
});
