/**
 * rate-limits.test.js — guards against the rate-limit gap found in the
 * mechanic auth flows: /register-independent and /send-otp previously had
 * no throttling at all. This asserts the limiter middleware is actually
 * wired into the route (by reference), not just present in the file.
 */
import { describe, it, expect, vi } from 'vitest';

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

import { authLimiter, emailOtpSendLimiter } from '../../../src/middleware/rateLimiter.js';
import { publicMechanicAuthRouter } from '../../../src/routes/mechanic/auth.js';

function middlewareStackFor(path, method) {
  const layer = publicMechanicAuthRouter.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  return layer ? layer.route.stack.map(s => s.handle) : null;
}

describe('mechanic auth route rate limiting', () => {
  it('POST /register-independent runs through authLimiter', () => {
    const stack = middlewareStackFor('/register-independent', 'post');
    expect(stack).not.toBeNull();
    expect(stack).toContain(authLimiter);
  });

  it('POST /send-otp runs through emailOtpSendLimiter', () => {
    const stack = middlewareStackFor('/send-otp', 'post');
    expect(stack).not.toBeNull();
    expect(stack).toContain(emailOtpSendLimiter);
  });

  it('the limiter runs before the route handler, not after', () => {
    const stack = middlewareStackFor('/register-independent', 'post');
    const limiterIndex = stack.indexOf(authLimiter);
    expect(limiterIndex).toBeGreaterThanOrEqual(0);
    expect(limiterIndex).toBeLessThan(stack.length - 1);
  });
});
