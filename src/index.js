// Load .env FIRST, overriding any system env vars (fixes Neon vs Supabase conflict)
import { config } from 'dotenv';
config({ override: true });
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import prisma from './db/prisma.js';
import authRoutes from './routes/auth/index.js';
import catalogRoutes from './routes/catalog.js';
import inventoryRoutes from './routes/inventory.js';
import billingRoutes from './routes/billing.js';
import partiesRoutes from './routes/parties.js';
import dashboardRoutes from './routes/dashboard.js';
import marketplaceRoutes from './routes/marketplace.js';
import customerRoutes from './routes/customer.js';
import staffRoutes from './routes/staff.js';
import adminRoutes from './routes/admin.js';
import fitmentRoutes from './routes/fitments.js';
import shopProfileRoutes from './routes/shop.js';
import workshopRoutes from './routes/workshop.js';
import shopVehicleRoutes from './routes/shopVehicles.js';
import purchaseOrderRoutes from './routes/purchaseOrders.js';
import uploadRoutes from './routes/upload.js';
import purchaseBillRoutes from './routes/purchaseBills.js';
import auditRoutes from './routes/audit.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authLimiter } from './middleware/rateLimiter.js';
import { startCleanupJob } from './lib/cleanup.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security headers (helmet) ─────────────────────────────────────────────────
// Sets X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security etc.
// crossOriginResourcePolicy: 'cross-origin' lets the marketplace load product
// images from S3/CDN origins without triggering CORP blocks.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // CSP disabled — the frontend is a separate SPA origin and sets its own policy.
  // Re-enable with a strict policy once the frontend domain is finalised.
  contentSecurityPolicy: false,
}));

// ── Request logging (morgan) ──────────────────────────────────────────────────
// 'dev' format: METHOD /path STATUS ms - bytes — colourised in terminal.
// Skip health-check pings so they don't flood the log.
app.use(morgan('dev', {
  skip: (req) => req.path === '/health',
}));

// ── Gzip compression ──────────────────────────────────────────────────────────
// Must be applied before routes so it wraps every response.
app.use(compression({ threshold: 1024 }));

const allowedOrigins = (
  process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175']
);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients and same-origin requests without an Origin header.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
// Global Body Parsers with DoS Protection
// Use 100kb strict limit globally. Use route-specific parsers or proxy-level
// buffers (e.g. Nginx client_max_body_size) if larger payloads are needed.
// Purchase-bill PDFs arrive base64-encoded — the raised limit MUST be
// registered BEFORE the global 100kb parser (body-parser is first-wins).
app.use('/api/shop/purchase-bills/extract', express.json({ limit: '18mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ limit: '100kb', extended: true }));
app.use(cookieParser());


// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/shop/inventory', inventoryRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/shop/parties', partiesRoutes);
app.use('/api/shop/dashboard', dashboardRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/shop/staff', staffRoutes);
app.use('/api/shop/profile', shopProfileRoutes);
app.use('/api/shop/workshop', workshopRoutes);
app.use('/api/shop/vehicles', shopVehicleRoutes);
app.use('/api/shop/purchase-orders', purchaseOrderRoutes);
app.use('/api/shop/purchase-bills', purchaseBillRoutes);
// Bulk import needs a larger body — only applied to this path
app.use('/api/admin/catalog/bulk-import', express.json({ limit: '5mb' }));
app.use('/api/admin', adminRoutes);
app.use('/api/fitments', fitmentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/audit', auditRoutes);

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
    console.error('[schema] ensureSchemaFixes failed (non-fatal):', err?.message);
  }
}

startCleanupJob();
app.listen(PORT, () => {
  console.log(`AutoSpace backend running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  ensureSchemaFixes();
});
