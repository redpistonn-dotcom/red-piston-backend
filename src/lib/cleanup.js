/**
 * cleanup.js — periodic housekeeping for expired rows + DB keepalive.
 * Called once on server startup. Non-blocking: errors never crash the server.
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

/**
 * Ping the database every 4 minutes with a trivial query so the Postgres
 * connection pool never goes cold between real requests. On Render free tier
 * (and serverless Postgres like Neon/Supabase), an idle connection can drop
 * after ~5 minutes — the next real request then pays a 500ms–2s reconnect
 * penalty. This keepalive costs almost nothing (a single round trip with no
 * disk I/O) but eliminates that penalty entirely.
 */
async function pingDb() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.warn('[DB] keepalive ping failed (non-blocking):', err?.message);
  }
}

/** Start the 24-hour cleanup loop + DB keepalive. Call once from index.js. */
export function startCleanupJob() {
  // DB keepalive every 4 minutes — keeps the connection warm without hammering
  setInterval(pingDb, 4 * 60 * 1000);

  // Initial cleanup 5 minutes after startup so the DB connection is settled
  setTimeout(() => cleanupExpiredTokens(), 5 * 60 * 1000);
  // Then every 24 hours
  setInterval(() => cleanupExpiredTokens(), 24 * 60 * 60 * 1000);
}
