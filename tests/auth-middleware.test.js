/**
 * Tests for src/middleware/auth.js
 *
 * Covers:
 *   authenticate     — NO_TOKEN, TOKEN_EXPIRED, wrong algorithm (INVALID_TOKEN),
 *                      valid HS256 token accepted + req.user/shopId/impersonatedBy set,
 *                      USER_INACTIVE (not found + isActive false)
 *   requirePermission — PLATFORM_ADMIN bypasses DB, CASHIER denied billing.override_credit,
 *                       CASHIER allowed billing.create, OWNER allowed everything,
 *                       inactive shopUser blocked, per-user denial override respected
 *
 * Prisma is already module-mocked by tests/setup.js — no local vi.mock needed.
 * JWT_SECRET is set by setup.js: 'test-jwt-secret-at-least-32-chars-long'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

import { authenticate, requirePermission } from '../src/middleware/auth.js';
import prisma from '../src/db/prisma.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const TEST_SECRET = process.env.JWT_SECRET; // set by tests/setup.js

/** Sign a valid HS256 JWT with an optional overrides object. */
function signToken(payload, options = {}) {
  return jwt.sign(payload, TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h', ...options });
}

/**
 * Build a minimal Express-style mock triple.
 * authHeader may be omitted (req will have no Authorization header).
 */
function buildMocks(authHeader) {
  const req = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
    ip: '127.0.0.1',
  };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const next = vi.fn();
  return { req, res, next };
}

/** A reusable active user object returned by prisma.user.findUnique. */
function makeUser(overrides = {}) {
  return {
    userId: 'user-001',
    name: 'Test User',
    email: 'test@example.com',
    isActive: true,
    shopId: 42,
    userType: { id: 10, name: 'Staff', slug: 'staff' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ==========================================================================
// authenticate
// ==========================================================================

describe('authenticate', () => {
  it('rejects a request with no Authorization header — 401 NO_TOKEN', async () => {
    const { req, res, next } = buildMocks(undefined);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'NO_TOKEN' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization header — 401 NO_TOKEN', async () => {
    const { req, res, next } = buildMocks('Basic dXNlcjpwYXNz');

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'NO_TOKEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an expired JWT — 401 TOKEN_EXPIRED', async () => {
    // expiresIn: -1 produces a token whose exp is already in the past
    const token = signToken({ userId: 'user-001' }, { expiresIn: -1 });
    const { req, res, next } = buildMocks(`Bearer ${token}`);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'TOKEN_EXPIRED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an RS256 token against an HS256-only server — 401 INVALID_TOKEN', async () => {
    // Generate an in-process RSA keypair; no file I/O needed
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rs256Token = jwt.sign({ userId: 'user-001' }, privateKey, {
      algorithm: 'RS256',
      expiresIn: '1h',
    });

    const { req, res, next } = buildMocks(`Bearer ${rs256Token}`);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_TOKEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the wrong secret — 401 INVALID_TOKEN', async () => {
    const token = jwt.sign({ userId: 'user-001' }, 'completely-wrong-secret', {
      algorithm: 'HS256',
    });
    const { req, res, next } = buildMocks(`Bearer ${token}`);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_TOKEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a valid HS256 token — sets req.user, req.shopId, req.impersonatedBy, calls next()', async () => {
    const user = makeUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const token = signToken({ userId: user.userId });
    const { req, res, next } = buildMocks(`Bearer ${token}`);

    await authenticate(req, res, next);

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: user.userId } })
    );
    expect(req.user).toBe(user);
    expect(req.shopId).toBe(user.shopId);
    expect(req.impersonatedBy).toBeNull();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('attaches impersonatedBy to req when the JWT carries it', async () => {
    const user = makeUser();
    prisma.user.findUnique.mockResolvedValue(user);

    const token = signToken({ userId: user.userId, impersonatedBy: 'admin-999' });
    const { req, res, next } = buildMocks(`Bearer ${token}`);

    await authenticate(req, res, next);

    expect(req.impersonatedBy).toBe('admin-999');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects when the user is not found in DB — 401 USER_INACTIVE', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const token = signToken({ userId: 'ghost-user' });
    const { req, res, next } = buildMocks(`Bearer ${token}`);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'USER_INACTIVE' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects when user.isActive is false — 401 USER_INACTIVE', async () => {
    prisma.user.findUnique.mockResolvedValue(makeUser({ isActive: false }));

    const token = signToken({ userId: 'user-001' });
    const { req, res, next } = buildMocks(`Bearer ${token}`);

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'USER_INACTIVE' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// requirePermission
// ==========================================================================

describe('requirePermission', () => {
  /**
   * Build a req that has already passed authenticate (req.user populated).
   * userTypeSlug is placed on req.user.userType.slug so requirePermission
   * can decide whether to short-circuit for admins.
   */
  function authedReq(userTypeSlug, shopId = 42) {
    return {
      headers: {},
      ip: '127.0.0.1',
      shopId,
      user: {
        userId: 'user-001',
        isActive: true,
        shopId,
        userType: { id: 5, name: userTypeSlug, slug: userTypeSlug },
      },
    };
  }

  it('PLATFORM_ADMIN bypasses DB lookup and calls next() immediately', async () => {
    const req = authedReq('PLATFORM_ADMIN');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    const middleware = requirePermission('billing.override_credit');
    await middleware(req, res, next);

    expect(prisma.shopUser.findUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('ADMIN slug (alias for PLATFORM_ADMIN) also bypasses all checks', async () => {
    const req = authedReq('ADMIN');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    const middleware = requirePermission('settings.delete');
    await middleware(req, res, next);

    expect(prisma.shopUser.findUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('CASHIER is denied billing.override_credit — 403 PERMISSION_DENIED', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'CASHIER',
      permissions: null,
      isActive: true,
    });

    const middleware = requirePermission('billing.override_credit');
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'PERMISSION_DENIED' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('CASHIER is allowed billing.create (role default) — next() called', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'CASHIER',
      permissions: null,
      isActive: true,
    });

    const middleware = requirePermission('billing.create');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('OWNER is allowed all permissions via wildcard defaults', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'OWNER',
      permissions: null,
      isActive: true,
    });

    const permsToCheck = [
      'billing.override_credit',
      'billing.create',
      'settings.delete',
      'staff.manage',
      'report.view',
      'inventory.delete',
    ];

    for (const perm of permsToCheck) {
      next.mockClear();
      res.status.mockClear();

      const middleware = requirePermission(perm);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('inactive shopUser is denied — 403 FORBIDDEN (staff account not active)', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'OWNER',
      permissions: null,
      isActive: false,
    });

    const middleware = requirePermission('billing.create');
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('missing shopUser row returns 403 FORBIDDEN', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue(null);

    const middleware = requirePermission('billing.view');
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'FORBIDDEN' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('per-user denial override blocks a CASHIER from billing.create despite role default', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'CASHIER',
      permissions: { 'billing.create': false },
      isActive: true,
    });

    const middleware = requirePermission('billing.create');
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'PERMISSION_DENIED' }) })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('per-user grant override allows a CASHIER to access a non-default permission', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'CASHIER',
      permissions: { 'billing.override_credit': true },
      isActive: true,
    });

    const middleware = requirePermission('billing.override_credit');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sets req.shopUserRole on a successful permission check', async () => {
    const req = authedReq('staff');
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    prisma.shopUser.findUnique.mockResolvedValue({
      role: 'CASHIER',
      permissions: null,
      isActive: true,
    });

    const middleware = requirePermission('billing.view');
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.shopUserRole).toBe('CASHIER');
  });
});
