/**
 * cleanup.js — periodic housekeeping for expired rows.
 * Called once on server startup and then every 24 hours.
 * Non-blocking: errors are logged but never crash the server.
 */
import prisma from '../db/prisma.js';

export async function cleanupExpiredTokens() {
  try {
    const now = new Date();
    const [tokens, otps] = await Promise.all([
      prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.otpCode.deleteMany({      where: { expiresAt: { lt: now } } }),
    ]);
    if (tokens.count > 0 || otps.count > 0) {
      console.log(`[Cleanup] Deleted ${tokens.count} expired refresh tokens, ${otps.count} expired OTPs`);
    }
  } catch (err) {
    console.error('[Cleanup] cleanupExpiredTokens failed (non-blocking):', err?.message);
  }
}

/** Start the 24-hour cleanup loop. Call once from index.js on startup. */
export function startCleanupJob() {
  // Initial run 5 minutes after startup so the DB connection is settled
  setTimeout(() => cleanupExpiredTokens(), 5 * 60 * 1000);
  // Then every 24 hours
  setInterval(() => cleanupExpiredTokens(), 24 * 60 * 60 * 1000);
}
