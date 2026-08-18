// Load .env FIRST, overriding any system env vars (fixes Neon vs Supabase conflict)
import { config } from 'dotenv';
config({ override: true });

// Prisma $queryRaw returns PostgreSQL integer/bigint columns as JS BigInt.
// Express JSON serializer can't handle BigInt → global patch converts to Number.
BigInt.prototype.toJSON = function () { return Number(this); };

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
import mechanicShopAdminRoutes from './routes/mechanic/shop-admin.js';
import mechanicAuthRoutes, { publicMechanicAuthRouter } from './routes/mechanic/auth.js';
import mechanicJobRoutes from './routes/mechanic/jobs.js';
import mechanicCustomerRoutes from './routes/mechanic/customers.js';
import mechanicTeamRoutes from './routes/mechanic/team.js';
import workshopQuotationRoutes from './routes/workshop/quotation.js';
import workshopBayRoutes from './routes/workshop/bays.js';
import workshopFeedbackRoutes from './routes/workshop/feedback.js';
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
// alert when heapUsed approaches the Render container limit (512 MB on the Free plan).
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
  // Always return 200 — Render healthcheck must not flip to failed due to transient DB/Redis issues.
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
// Mechanic routes — separate user type, not SHOP_STAFF
app.use('/api/mechanic-auth', publicMechanicAuthRouter);
app.use('/api/shop/mechanics', authenticate, requireSection('staff'), mechanicShopAdminRoutes);
app.use('/api/mechanic', authenticate, mechanicAuthRoutes);
app.use('/api/mechanic', authenticate, mechanicJobRoutes);
app.use('/api/mechanic', authenticate, mechanicCustomerRoutes);
app.use('/api/mechanic', authenticate, mechanicTeamRoutes);
app.use('/api/shop/workshop', authenticate, requireSection('workshop', 'workshop-mp'), workshopQuotationRoutes);
app.use('/api/shop/workshop', authenticate, requireSection('workshop', 'workshop-mp'), workshopBayRoutes);
app.use('/api/shop/workshop', authenticate, requireSection('workshop', 'workshop-mp'), workshopFeedbackRoutes);
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
    await prisma.$executeRawUnsafe('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS freight DECIMAL(10,2) NOT NULL DEFAULT 0');
    await prisma.$executeRawUnsafe('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS other_charges DECIMAL(10,2) NOT NULL DEFAULT 0');
    console.log('[schema] ensured all recent invoice & inventory columns + user login_count/last_login_at + purchase_orders freight/other_charges');
  } catch (err) {
    console.error('[schema] ensureSchemaFixes column additions failed (non-fatal):', err?.message);
  }
  // ── Mechanic tables & job-card extensions ─────────────────────────────────
  try {
    // Seed MECHANIC user type (idempotent — ON CONFLICT DO NOTHING)
    await prisma.$executeRawUnsafe(`
      INSERT INTO user_types (slug, name)
      VALUES ('MECHANIC', 'Mechanic')
      ON CONFLICT (slug) DO NOTHING
    `);

    // shop_mechanics — one row per mechanic per shop
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS shop_mechanics (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        shop_id           INTEGER NOT NULL REFERENCES shops(shop_id),
        mechanic_role     VARCHAR(10) NOT NULL DEFAULT 'MEMBER',
        head_mechanic_id  INTEGER REFERENCES shop_mechanics(id),
        employee_id       VARCHAR(50),
        designation       VARCHAR(100),
        skills            TEXT[],
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        approval_status   VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        invited_by        INTEGER REFERENCES users(user_id),
        joined_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(shop_id, user_id)
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_shop_mechanics_shop ON shop_mechanics(shop_id)');
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_shop_mechanics_user ON shop_mechanics(user_id)');
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_shop_mechanics_head ON shop_mechanics(head_mechanic_id)');

    // mechanic_invites — pending invite rows
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS mechanic_invites (
        id                SERIAL PRIMARY KEY,
        shop_id           INTEGER NOT NULL REFERENCES shops(shop_id),
        email             VARCHAR(255) NOT NULL,
        mechanic_role     VARCHAR(10) NOT NULL DEFAULT 'MEMBER',
        head_mechanic_id  INTEGER REFERENCES shop_mechanics(id),
        invited_by        INTEGER NOT NULL REFERENCES users(user_id),
        status            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        verified_at       TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(shop_id, email)
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_mechanic_invites_shop ON mechanic_invites(shop_id)');

    // shops: mechanic join code (mechanics use this to self-register)
    await prisma.$executeRawUnsafe('ALTER TABLE shops ADD COLUMN IF NOT EXISTS mechanic_join_code VARCHAR(10) UNIQUE');

    // job_cards: new columns for mechanic assignment + QC + approval
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS assigned_to_user_id INTEGER REFERENCES users(user_id)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_status VARCHAR(20)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_by INTEGER REFERENCES users(user_id)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_at TIMESTAMPTZ');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_notes TEXT');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT \'PENDING\'');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS approval_method VARCHAR(20)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(user_id)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS approval_remarks TEXT');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS mechanic_invoice_id INTEGER');
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_job_cards_assigned_user ON job_cards(assigned_to_user_id)');

    // job_card_timeline — every mutation logged
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS job_card_timeline (
        id            SERIAL PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES job_cards(job_id) ON DELETE CASCADE,
        actor_user_id INTEGER REFERENCES users(user_id),
        event         VARCHAR(50) NOT NULL,
        from_status   VARCHAR(30),
        to_status     VARCHAR(30),
        note          TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_job_card_timeline_job ON job_card_timeline(job_id, created_at DESC)');

    // job_card_photos — before/during/after repair
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS job_card_photos (
        id           SERIAL PRIMARY KEY,
        job_id       INTEGER NOT NULL REFERENCES job_cards(job_id) ON DELETE CASCADE,
        stage        VARCHAR(20) NOT NULL DEFAULT 'DURING',
        url          TEXT NOT NULL,
        uploaded_by  INTEGER REFERENCES users(user_id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_job_card_photos_job ON job_card_photos(job_id)');

    // invoice_items: taxable_value column (used by mechanic invoice generation)
    await prisma.$executeRawUnsafe('ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS taxable_value DECIMAL(10,2)');

    // shop_mechanics: granular privilege grants (mirrors ShopUser.sections for
    // staff) — which of the mechanic-specific sections this mechanic has.
    await prisma.$executeRawUnsafe("ALTER TABLE shop_mechanics ADD COLUMN IF NOT EXISTS sections TEXT[] NOT NULL DEFAULT '{}'");
    // mechanic_invites: carry the owner's section picks through to acceptance
    // (mechanic/auth.js accept copies this onto the new shop_mechanics row).
    await prisma.$executeRawUnsafe("ALTER TABLE mechanic_invites ADD COLUMN IF NOT EXISTS sections TEXT[] NOT NULL DEFAULT '{}'");

    // sections — DB-backed privilege registry replacing the hardcoded
    // SECTION_KEYS list (lib/section-permissions.js) and giving MECHANIC its
    // own set. appliesTo controls which invite/edit UI a section shows up in.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS sections (
        id          SERIAL PRIMARY KEY,
        key         VARCHAR(50) NOT NULL UNIQUE,
        label       VARCHAR(100) NOT NULL,
        applies_to  TEXT[] NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const SHOP_STAFF_SECTIONS = [
      ['dashboard', 'Dashboard'], ['inventory', 'Inventory'], ['pos', 'POS Billing'],
      ['parties', 'Parties'], ['workshop', 'Job Cards'], ['workshop-mp', 'Parts Listing'],
      ['history', 'History'], ['reports', 'Reports'], ['orders', 'Orders'],
      ['gstr', 'GSTR-1 Export'], ['audit', 'Audit Log'], ['staff', 'Staff'],
      ['shop-settings', 'Shop Settings'], ['returns', 'Returns & Exchange'],
      ['purchase-returns', 'Purchase Returns'], ['warranty', 'Warranty'],
    ];
    for (const [key, label] of SHOP_STAFF_SECTIONS) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO sections (key, label, applies_to) VALUES ($1, $2, ARRAY['SHOP_STAFF'])
        ON CONFLICT (key) DO NOTHING
      `, key, label);
    }
    // New mechanic-specific privileges (Section 6.2 — previously excluded from
    // the mechanic app, now grantable per-mechanic rather than blanket-on).
    const MECHANIC_SECTIONS = [
      ['parts-inventory', 'Basic Inventory (search stock, add parts to job)'],
      ['invoices', 'Basic Invoice Generation'],
    ];
    for (const [key, label] of MECHANIC_SECTIONS) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO sections (key, label, applies_to) VALUES ($1, $2, ARRAY['MECHANIC'])
        ON CONFLICT (key) DO NOTHING
      `, key, label);
    }

    // mechanic_team — independent mechanics can add other users as team members
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS mechanic_team (
        id              SERIAL PRIMARY KEY,
        owner_user_id   INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        member_user_id  INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(owner_user_id, member_user_id)
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_mechanic_team_owner ON mechanic_team(owner_user_id)');
    await prisma.$executeRawUnsafe('ALTER TABLE mechanic_team ADD COLUMN IF NOT EXISTS member_name TEXT');
    await prisma.$executeRawUnsafe('ALTER TABLE mechanic_team ADD COLUMN IF NOT EXISTS member_phone TEXT');
    try { await prisma.$executeRawUnsafe('ALTER TABLE mechanic_team ALTER COLUMN member_user_id DROP NOT NULL'); } catch {}
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mechanic_team_owner_phone ON mechanic_team(owner_user_id, member_phone) WHERE member_phone IS NOT NULL`);

    // Independent mechanic profile fields
    await prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS mechanic_shop_name TEXT');
    await prisma.$executeRawUnsafe('ALTER TABLE users ADD COLUMN IF NOT EXISTS mechanic_shop_location TEXT');

    console.log('[schema] ensured mechanic tables + job_card extensions + timeline + photos + sections registry');
  } catch (err) {
    console.error('[schema] mechanic schema fixes failed (non-fatal):', err?.message);
  }

  // ── Extended job-card fields: check-in, quotation, bays, part-requests, feedback ─
  try {
    // Vehicle check-in
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS fuel_level VARCHAR(20)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS accessories_received TEXT[]');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS spare_key BOOLEAN DEFAULT FALSE');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS visible_condition TEXT');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS check_in_at TIMESTAMPTZ');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS check_in_by INTEGER REFERENCES users(user_id)');
    // Service consultation
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS consultation_notes TEXT');
    // Mechanic granular progress sub-status
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS mechanic_progress VARCHAR(30)');
    // Customer/vehicle FK linking
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES parties(party_id)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS shop_vehicle_id INTEGER REFERENCES shop_vehicles(vehicle_id)');
    // Quotation fields stored on job card
    await prisma.$executeRawUnsafe("ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS quotation_status VARCHAR(20) DEFAULT 'NONE'");
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS quotation_number VARCHAR(50)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS quotation_discount DECIMAL(10,2) DEFAULT 0');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS quotation_grand_total DECIMAL(10,2) DEFAULT 0');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS quotation_sent_at TIMESTAMPTZ');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS quotation_sent_via VARCHAR(20)');
    // Customer notification & delivery
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS customer_notified_at TIMESTAMPTZ');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS delivery_at TIMESTAMPTZ');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS delivery_by INTEGER REFERENCES users(user_id)');
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS customer_signature_url TEXT');
    // Bay assignment — column first, FK after table created
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS bay_id INTEGER');
    // Independent mechanic support — shop_id nullable
    await prisma.$executeRawUnsafe('ALTER TABLE job_cards ALTER COLUMN shop_id DROP NOT NULL');

    // service_bays table
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS service_bays (
        id         SERIAL PRIMARY KEY,
        shop_id    INTEGER NOT NULL REFERENCES shops(shop_id),
        name       VARCHAR(100) NOT NULL,
        is_active  BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_service_bays_shop ON service_bays(shop_id)');

    // Add FK for bay_id now that service_bays exists (IF NOT EXISTS guard via DO block)
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'fk_job_cards_bay' AND table_name = 'job_cards'
        ) THEN
          ALTER TABLE job_cards ADD CONSTRAINT fk_job_cards_bay FOREIGN KEY (bay_id) REFERENCES service_bays(id);
        END IF;
      END $$
    `);

    // job_card_quotation_sends — share event log
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS job_card_quotation_sends (
        id       SERIAL PRIMARY KEY,
        job_id   INTEGER NOT NULL REFERENCES job_cards(job_id) ON DELETE CASCADE,
        sent_via VARCHAR(20) NOT NULL,
        sent_to  VARCHAR(255),
        sent_by  INTEGER REFERENCES users(user_id),
        sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_quotation_sends_job ON job_card_quotation_sends(job_id)');

    // job_card_part_requests — mechanic requests for out-of-stock parts
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS job_card_part_requests (
        id            SERIAL PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES job_cards(job_id) ON DELETE CASCADE,
        shop_id       INTEGER NOT NULL REFERENCES shops(shop_id),
        description   VARCHAR(255) NOT NULL,
        part_number   VARCHAR(100),
        qty_requested INTEGER NOT NULL DEFAULT 1,
        unit_price    DECIMAL(10,2),
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        requested_by  INTEGER REFERENCES users(user_id),
        reviewed_by   INTEGER REFERENCES users(user_id),
        review_notes  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_part_requests_job ON job_card_part_requests(job_id)');
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_part_requests_shop_status ON job_card_part_requests(shop_id, status)');

    // job_card_feedback — customer post-service rating
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS job_card_feedback (
        id                SERIAL PRIMARY KEY,
        job_id            INTEGER NOT NULL REFERENCES job_cards(job_id) ON DELETE CASCADE,
        shop_id           INTEGER NOT NULL REFERENCES shops(shop_id),
        rating            INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment           TEXT,
        submitted_by_name VARCHAR(255),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(job_id)
      )
    `);
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_job_feedback_shop ON job_card_feedback(shop_id, created_at DESC)');

    console.log('[schema] ensured extended job-card columns + service_bays + part_requests + feedback + quotation_sends');
  } catch (err) {
    console.error('[schema] extended job-card schema fixes failed (non-fatal):', err?.message);
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


