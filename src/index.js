// Load .env FIRST, overriding any system env vars (fixes Neon vs Supabase conflict)
import { config } from 'dotenv';
config({ override: true });

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: process.env.SENTRY_DSN || '[YOUR_SENTRY_DSN]',
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { httpLogger } from './lib/logger.js';
import { networkLogger } from './middleware/networkLogger.js';
import cookieParser from 'cookie-parser';
import prisma from './db/prisma.js';
import { authenticate, requireSection } from './middleware/auth.js';
import authRoutes from './routes/auth/index.js';
import catalogRoutes from './routes/catalog.js';
import inventoryRoutes, { getMovements } from './routes/inventory.js';
import billingRoutes from './routes/billing.js';
import partiesRoutes, { getPartyLedger } from './routes/parties.js';
import dashboardRoutes from './routes/dashboard.js';
import marketplaceRoutes from './routes/marketplace.js';
import customerRoutes from './routes/customer.js';
import staffRoutes, { publicStaffInviteRouter } from './routes/staff.js';
import adminRoutes from './routes/admin.js';
import fitmentRoutes from './routes/fitments.js';
import shopProfileRoutes from './routes/shop.js';
import workshopRoutes from './routes/workshop.js';
import shopVehicleRoutes from './routes/shopVehicles.js';
import purchaseOrderRoutes from './routes/purchaseOrders.js';
import uploadRoutes from './routes/upload.js';
import purchaseBillRoutes from './routes/purchaseBills.js';
import stockBatchRoutes from './routes/stockBatches.js';
import auditRoutes from './routes/audit.js';
import salesReturnRoutes from './routes/salesReturns.js';
import creditNoteRoutes from './routes/creditNotes.js';
import purchaseReturnRoutes from './routes/purchaseReturns.js';
import exchangeRoutes from './routes/exchanges.js';
import warrantyClaimRoutes from './routes/warrantyClaims.js';
import returnsReportRoutes from './routes/returnsReports.js';
import gstrRoutes from './routes/gstr.js';
import gstPeriodRoutes from './routes/gstPeriods.js';
import returnPolicyWindowRoutes from './routes/returnPolicyWindows.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authLimiter, pdfExtractLimiter } from './middleware/rateLimiter.js';
import { startCleanupJob } from './lib/cleanup.js';
import { startEmailWorker } from './jobs/workers/email.worker.js';
import { startCleanupWorker } from './jobs/workers/cleanup.worker.js';
import { startReconcileWorker } from './jobs/workers/reconciliation.worker.js';
import { startGstr1Worker } from './jobs/workers/gstr1.worker.js';
import { scheduleRecurringJobs } from './jobs/queues.js';
import { startMetricsReporting } from './lib/metrics.js';
import { apiLimiter, mutationLimiter } from './middleware/rateLimiterAll.js';
import { flagMiddleware } from './lib/flags.js';

// ── Boot-time environment validation ─────────────────────────────────────────
// Fail fast with a clear message rather than a cryptic JWT error at runtime.
const JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) {
  console.error('[startup] FATAL: JWT_SECRET must be at least 32 characters. Set a strong random value (e.g. openssl rand -hex 32) and restart.');
  process.exit(1);
}

const app = express();
// Render (and most cloud platforms) sit behind a reverse proxy.
// Without this, express-rate-limit reads X-Forwarded-For as an untrusted header
// and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// ── Security headers (helmet) ─────────────────────────────────────────────────
// Sets X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security etc.
// crossOriginResourcePolicy: 'cross-origin' lets the marketplace load product
// images from S3/CDN origins without triggering CORP blocks.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // CSP disabled: this is a pure JSON API — no HTML pages served.
  // CSP on an API backend only breaks browser preflight/CORS behaviour
  // without providing any XSS protection (there is no DOM to inject into).
  contentSecurityPolicy: false,
}));

app.use(httpLogger);
app.use(networkLogger);

// ── Gzip compression ──────────────────────────────────────────────────────────
// Must be applied before routes so it wraps every response.
app.use(compression({ threshold: 1024 }));

const DOMAIN_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,          // local dev
  /^https?:\/\/([a-z0-9-]+\.)?redpiston\.in$/,             // redpiston.in + any subdomain
  /^https:\/\/red-piston[a-z0-9-]*\.vercel\.app$/,         // Vercel deployments
];

// FRONTEND_URL (comma-separated) still works as an escape hatch for one-off domains.
const extraOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (DOMAIN_PATTERNS.some((p) => p.test(origin))) return callback(null, true);
    if (extraOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
// Global Body Parsers with DoS Protection
// Use 100kb strict limit globally. Use route-specific parsers or proxy-level
// buffers (e.g. Nginx client_max_body_size) if larger payloads are needed.
// Purchase-bill PDFs arrive base64-encoded — the raised limit MUST be
// registered BEFORE the global 100kb parser (body-parser is first-wins).
// Rate limiter also applied first — 5 uploads per 10 min per IP (CPU-heavy parse).
app.use('/api/shop/purchase-bills/extract', pdfExtractLimiter);
app.use('/api/shop/purchase-bills/extract', express.json({ limit: '18mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));
app.use(cookieParser());
app.use(apiLimiter);
// Tighter limit on all write operations — 60 mutations/min per IP
app.use((req, _res, next) => {
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') {
    return mutationLimiter(req, _res, next);
  }
  next();
});
app.use(flagMiddleware);

// Health check — exposes process memory so external monitors (UptimeRobot, etc.) can
// alert when heapUsed approaches the Railway container limit (~512 MB on Hobby plan).
app.get('/health', async (req, res) => {
  const mem = process.memoryUsage();
  const toMB = (b) => Math.round(b / 1024 / 1024);
  const heapMB = toMB(mem.heapUsed);
  const rssMB  = toMB(mem.rss);
  // Flag as degraded if heap > 400 MB — gives early warning before OOM kill
  const memPressure = heapMB > 400 ? 'high' : heapMB > 250 ? 'moderate' : 'normal';

  let dbStatus = 'unknown';
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    dbStatus = 'connected';
  } catch (err) {
    dbStatus = 'degraded';
  }
  // Always return 200 — Railway healthcheck must not flip to failed due to transient DB/Redis issues.
  // Degraded state is surfaced in the payload for observability.
  res.status(200).json({
    status: dbStatus === 'connected' && memPressure !== 'high' ? 'ok' : 'degraded',
    db: dbStatus,
    memory: { heapMB, rssMB, pressure: memPressure },
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Routes
//
// Section gates (requireSection): a SHOP_STAFF account now passes the generic
// requireShopOwner check used inside most route files (see middleware/auth.js),
// so without an extra gate here they'd get full access to every one of these
// resource areas regardless of which sections they were actually granted at
// invite time. Inserted as their own middleware layer ahead of the resource's
// router(s) — SHOP_OWNER/ADMIN always pass through untouched. Areas without a
// clean 1:1 section mapping (dashboard, purchase-orders, marketplace/orders,
// audit, vehicles) are intentionally left ungated for now — a granted SHOP_STAFF
// account gets the same access an owner would there; only nav visibility
// (frontend) restricts them from finding those pages. `/api/billing` is shared
// by two different sections (POS billing + GSTR export) since billing.js and
// gstr.js are both mounted at that prefix — gated by either, not a precise split.
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/catalog', catalogRoutes);
// History is its own granted section, distinct from Inventory, but the
// movements endpoint lives under this router — registered here, ahead of
// the blanket inventory gate below, so a staff member with only "history"
// granted isn't 403'd (and shown a silently-empty History page for it).
app.get('/api/shop/inventory/movements', authenticate, requireSection('inventory', 'history'), getMovements);
app.use('/api/shop/inventory', authenticate, requireSection('inventory'));
app.use('/api/shop/inventory', inventoryRoutes);
app.use('/api/shop/inventory', stockBatchRoutes);
app.use('/api/billing', authenticate, requireSection('pos', 'gstr'));
app.use('/api/billing', billingRoutes);
app.use('/api/billing', gstrRoutes);
// Purchase Returns needs to read a supplier's ledger to resolve a return —
// same pattern as movements above: exact-path route ahead of the blanket
// gate, its own combined section check, rest of this router stays
// 'parties'-only.
app.get('/api/shop/parties/:id/ledger', authenticate, requireSection('parties', 'purchase-returns'), getPartyLedger);
app.use('/api/shop/parties', authenticate, requireSection('parties'));
app.use('/api/shop/parties', partiesRoutes);
app.use('/api/shop/dashboard', dashboardRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/shop/staff-invite', publicStaffInviteRouter);
app.use('/api/shop/staff', authenticate, requireSection('staff'));
app.use('/api/shop/staff', staffRoutes);
app.use('/api/shop/profile', shopProfileRoutes);
app.use('/api/shop/workshop', authenticate, requireSection('workshop', 'workshop-mp'));
app.use('/api/shop/workshop', workshopRoutes);
app.use('/api/shop/vehicles', shopVehicleRoutes);
app.use('/api/shop/purchase-orders', purchaseOrderRoutes);
app.use('/api/shop/purchase-bills', purchaseBillRoutes);
app.use('/api/shop/returns', authenticate, requireSection('returns'));
app.use('/api/shop/returns', salesReturnRoutes);
// Also reachable from POS Billing (applying a customer's store credit at
// checkout) — same bug class as History/Inventory: a cashier granted only
// "pos" would otherwise 403 fetching available credit notes and silently
// never see the "apply credit" option work.
app.use('/api/shop/credit-notes', authenticate, requireSection('returns', 'pos'));
app.use('/api/shop/credit-notes', creditNoteRoutes);
app.use('/api/shop/purchase-returns', authenticate, requireSection('purchase-returns'));
app.use('/api/shop/purchase-returns', purchaseReturnRoutes);
app.use('/api/shop/exchanges', authenticate, requireSection('returns'));
app.use('/api/shop/exchanges', exchangeRoutes);
app.use('/api/shop/warranty-claims', authenticate, requireSection('warranty'));
app.use('/api/shop/warranty-claims', warrantyClaimRoutes);
app.use('/api/shop/returns-reports', authenticate, requireSection('reports'));
app.use('/api/shop/returns-reports', returnsReportRoutes);
app.use('/api/shop/gst-periods', authenticate, requireSection('gstr'));
app.use('/api/shop/gst-periods', gstPeriodRoutes);
app.use('/api/shop/return-policy-windows', authenticate, requireSection('shop-settings'));
app.use('/api/shop/return-policy-windows', returnPolicyWindowRoutes);
// Bulk import needs a larger body — only applied to this path
app.use('/api/admin/catalog/bulk-import', express.json({ limit: '5mb' }));
app.use('/api/admin', adminRoutes);
app.use('/api/fitments', fitmentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/audit', auditRoutes);

Sentry.setupExpressErrorHandler(app);

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use(errorHandler);

// One-time, idempotent schema fixes applied on boot (the platform has no manual
// migration step). `chk_movement_qty_positive` was a too-strict manual constraint
// that forbade negative qty, but the app's design stores SIGNED qty for ADJUSTMENT/
// AUDIT (downward stock corrections) — so reducing stock 500'd with a 23514 error.
// Dropping it matches the documented model (computeStock sums signed ADJUSTMENT qty).
async function ensureSchemaFixes() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE movements DROP CONSTRAINT IF EXISTS chk_movement_qty_positive');
    console.log('[schema] ensured movements qty constraint allows signed adjustments');
  } catch (err) {
    console.error('[schema] ensureSchemaFixes constraint failed (non-fatal):', err?.message);
  }
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2)');
    await prisma.$executeRawUnsafe('ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS oem_number VARCHAR(255)');
    await prisma.$executeRawUnsafe('ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS igst DECIMAL(10,2) DEFAULT 0');
    await prisma.$executeRawUnsafe('ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2)');
    await prisma.$executeRawUnsafe('ALTER TABLE master_parts ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2)');
    await prisma.$executeRawUnsafe('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS custom_items_meta JSONB');
    await prisma.$executeRawUnsafe('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS marketplace_order_id INTEGER');
    await prisma.$executeRawUnsafe('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS igst DECIMAL(10,2) DEFAULT 0');
    await prisma.$executeRawUnsafe('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vehicle_reg VARCHAR(255)');
    await prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0');
    await prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ');
    console.log('[schema] ensured all recent invoice & inventory columns + user login_count/last_login_at');
  } catch (err) {
    console.error('[schema] ensureSchemaFixes column additions failed (non-fatal):', err?.message);
  }
  // ── Purchase Returns tables ────────────────────────────────────────────────
  // These were only ever created by a hand-run SQL file, so on a DB where that
  // wasn't applied the Purchase Returns page 500s while everything else works.
  // Create them idempotently at boot so the feature works everywhere.
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS purchase_returns (
        return_id               SERIAL PRIMARY KEY,
        return_no               VARCHAR(60) NOT NULL UNIQUE,
        shop_id                 INTEGER NOT NULL REFERENCES shops(shop_id),
        original_bill_id        INTEGER NOT NULL REFERENCES purchase_bills(bill_id),
        party_id                INTEGER REFERENCES parties(party_id),
        supplier_name           VARCHAR(255),
        supplier_gstin          VARCHAR(20),
        reason                  VARCHAR(30) NOT NULL,
        resolution              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        supplier_credit_note_no VARCHAR(60),
        status                  VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
        notes                   TEXT,
        credit_ledger_posted    BOOLEAN NOT NULL DEFAULT FALSE,
        version                 INTEGER NOT NULL DEFAULT 0,
        created_by              INTEGER,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await prisma.$executeRawUnsafe('ALTER TABLE purchase_returns ADD COLUMN IF NOT EXISTS credit_ledger_posted BOOLEAN NOT NULL DEFAULT FALSE');
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_purchase_returns_shop_created ON purchase_returns (shop_id, created_at DESC)');
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_purchase_returns_shop_resol ON purchase_returns (shop_id, resolution)');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS purchase_return_items (
        item_id            SERIAL PRIMARY KEY,
        return_id          INTEGER NOT NULL REFERENCES purchase_returns(return_id) ON DELETE CASCADE,
        inventory_id       INTEGER NOT NULL REFERENCES shop_inventory(inventory_id),
        source_movement_id INTEGER NOT NULL REFERENCES movements(movement_id),
        qty                INTEGER NOT NULL,
        unit_price         NUMERIC(10,2) NOT NULL,
        taxable_value      NUMERIC(10,2) NOT NULL,
        gst_rate           NUMERIC(5,2) NOT NULL,
        cgst               NUMERIC(10,2) NOT NULL,
        sgst               NUMERIC(10,2) NOT NULL,
        igst               NUMERIC(10,2) NOT NULL DEFAULT 0
      )`);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items (return_id)');
    console.log('[schema] ensured purchase_returns + purchase_return_items tables exist');
  } catch (err) {
    console.error('[schema] ensureSchemaFixes purchase-returns tables failed (non-fatal):', err?.message);
  }
}

// Prevent Redis quota errors (and similar transient infra faults) from crashing
// the process. Workers already log these via their own .on('error') handlers;
// this is the last-resort safety net for any path that slips through.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message ?? String(reason);
  if (msg.includes('max requests limit exceeded') || msg.includes('ReplyError') || msg.includes('ECONNREFUSED')) {
    console.error('[App] Suppressed Redis/infra unhandledRejection (non-fatal):', msg);
    return;
  }
  console.error('[App] Unhandled rejection:', reason);
});

async function startWorkersIfRedisAvailable() {
  if (!process.env.REDIS_URL) {
    startCleanupJob();
    console.log("[App] Legacy cleanup started (no REDIS_URL)");
    return;
  }

  // Quick Redis health check before starting workers.
  // If quota exceeded or unreachable, skip workers — app runs normally without them.
  try {
    const { default: IORedis } = await import('ioredis');
    const url = new URL(process.env.REDIS_URL);
    const conn = new IORedis({
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      family: 4,
      tls: url.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 1,
      connectTimeout: 4000,
      lazyConnect: true,
    });
    await conn.connect();
    await conn.ping();
    await conn.quit();
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.warn(`[App] Redis unavailable — workers disabled (app runs normally). Reason: ${msg}`);
    startCleanupJob();
    return;
  }

  const workers = [];
  workers.push(startEmailWorker(), startCleanupWorker(), startReconcileWorker(), startGstr1Worker());
  scheduleRecurringJobs().catch(err => console.error("[App] Failed to schedule jobs:", err));
  console.log("[App] BullMQ workers started");
}

startWorkersIfRedisAvailable();
startMetricsReporting();
ensureSchemaFixes().finally(() => {
  const server = app.listen(PORT, () => {
    console.log(`RedPiston backend running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[email] RESEND_API_KEY set: ${!!process.env.RESEND_API_KEY}`);
    console.log(`[email] RESEND_SENDER_EMAIL set: ${!!process.env.RESEND_SENDER_EMAIL}`);
  });

  // Graceful shutdown — drain in-flight requests before exiting.
  // Render / Docker send SIGTERM on deploy; SIGINT handles Ctrl+C in dev.
  function gracefulShutdown(signal) {
    console.log(`[shutdown] ${signal} received — closing server`);
    server.close(async () => {
      try { await Promise.all(workers.filter(Boolean).map(w => w.close())); } catch {}
      try { await prisma.$disconnect(); } catch {}
      console.log("[shutdown] Clean exit");
      process.exit(0);
    });
    setTimeout(() => { console.error('[shutdown] Forced exit after 10 s'); process.exit(1); }, 10_000);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
});


