/**
 * otp.test.js — unit tests for the OTP verification route.
 *
 * SECURITY FIX COVERAGE:
 *   SEC-002 — verifyOtpLimiter is now wired to POST /verify-otp.
 *   We verify the phone-format guard, the OTP-format guard, the lock
 *   check, and that the rate-limiter middleware is present in the
 *   handler stack (it is the only Express-layer defence against a
 *   concurrent brute-force that exhausts the DB counter before the
 *   first counter write commits).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('../../src/db/prisma.js', () => ({
  default: {
    otpCode: {
      findFirst: vi.fn(),
      update:   vi.fn().mockResolvedValue({}),
      create:   vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
    },
    refreshToken: {
      deleteMany: vi.fn().mockResolvedValue({}),
      create:     vi.fn().mockResolvedValue({}),
    },
    authProvider: {
      findUnique: vi.fn().mockResolvedValue(null),
      create:     vi.fn().mockResolvedValue({}),
    },
    userType: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../../src/services/otp.js', () => ({
  sendOtp:   vi.fn().mockResolvedValue({}),
  verifyOtp: vi.fn(),
}));

vi.mock('../../src/services/email.js', () => ({
  sendShopOwnerVerificationAlert: vi.fn(),
}));

import prisma from '../../src/db/prisma.js';
import { verifyOtp as mockVerifyOtp } from '../../src/services/otp.js';
import otpRouter from '../../src/routes/auth/otp.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', otpRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: phone not locked
  prisma.otpCode.findFirst.mockResolvedValue(null);
});

// ── Phone format guard ────────────────────────────────────────────────────────
describe('POST /api/auth/verify-otp — phone validation', () => {
  it('rejects missing phone with 400', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ otp: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });

  it('rejects 9-digit phone with 400', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '987654321', otp: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });

  it('rejects non-numeric phone with 400', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: 'abcdefghij', otp: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });

  it('accepts exactly 10 numeric digits', async () => {
    // Will hit the OTP verification logic — stub it to return invalid so we
    // don't need to set up a full user session here.
    mockVerifyOtp.mockResolvedValue({ valid: false, otpRecord: null });
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '9876543210', otp: '123456' });
    // Should fail with INVALID_OTP, not INVALID_PHONE
    expect(res.body.error?.code).not.toBe('INVALID_PHONE');
  });
});

// ── OTP format guard ──────────────────────────────────────────────────────────
describe('POST /api/auth/verify-otp — OTP validation', () => {
  it('rejects 5-digit OTP with INVALID_OTP', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '9876543210', otp: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  it('rejects non-numeric OTP with INVALID_OTP', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '9876543210', otp: 'abcdef' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  it('rejects missing OTP', async () => {
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '9876543210' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });
});

// ── DB lock check ─────────────────────────────────────────────────────────────
describe('POST /api/auth/verify-otp — DB lock', () => {
  it('returns 429 when DB reports phone is locked', async () => {
    // findFirst returns a record → isOtpLocked = true
    prisma.otpCode.findFirst.mockResolvedValueOnce({ id: 1, attempts: 5 });
    const res = await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '9876543210', otp: '123456' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_LOCKED');
  });
});

// ── Incorrect OTP increments attempt counter ──────────────────────────────────
describe('POST /api/auth/verify-otp — attempt counter', () => {
  it('increments the attempt counter on a wrong OTP', async () => {
    mockVerifyOtp.mockResolvedValue({ valid: false, otpRecord: { id: 42 } });
    prisma.otpCode.findFirst
      .mockResolvedValueOnce(null)  // isOtpLocked check → not locked
      .mockResolvedValueOnce({ id: 42, attempts: 1 }); // remaining check

    await request(makeApp())
      .post('/api/auth/verify-otp')
      .send({ phone: '9876543210', otp: '000000' });

    expect(prisma.otpCode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 42 },
        data:  { attempts: { increment: 1 } },
      })
    );
  });
});

// ── SEC-002: verifyOtpLimiter is applied ──────────────────────────────────────
describe('SEC-002: rate limiter applied to verify-otp', () => {
  it('verifyOtpLimiter middleware is in the route stack (route has > 1 handler)', () => {
    // We load the router and inspect the handler count for the POST /verify-otp route.
    // express-rate-limit adds itself as a layer before the async handler.
    const routerStack = otpRouter.stack;
    const verifyRoute = routerStack.find(
      l => l.route?.path === '/verify-otp' && l.route?.methods?.post
    );
    expect(verifyRoute).toBeDefined();
    // The route should have at least 2 handles: [verifyOtpLimiter, asyncHandler]
    expect(verifyRoute.route.stack.length).toBeGreaterThanOrEqual(2);
  });
});
