# Changelog

## [2026-06-26] — Audit Logs, Batch/Lot Tracking, Date Range Analytics, GSTR-1 Export, WAC Pricing

### New Features
- **Audit log coverage for Purchase Orders** (`src/routes/purchaseOrders.js`): `writeAudit` now fires on PO create (`ACT.CREATE`) and every status transition (`ACT.APPROVE / ACT.PURCHASE / ACT.UPDATE / ACT.REJECT`). All PO mutations are now fully traceable in `audit_logs`.
- **Date range analytics** (`src/routes/dashboard.js`): `GET /api/shop/dashboard` now accepts `?from=YYYY-MM-DD&to=YYYY-MM-DD` in addition to `?period=today|week|month`. Two new endpoints: `GET /api/shop/dashboard/trend` (daily revenue/profit/salesCount, default 30 days) and `GET /api/shop/dashboard/product-breakdown` (top 20 products by revenue for any date range). Both are Redis-cached for 5 min.
- **GSTR-1 export** (`src/routes/gstr.js`): `GET /api/billing/gstr1?from=&to=&format=json|excel` generates Indian GST Return-1 in three sections — B2B (per-invoice with party GSTIN), B2CS (aggregated B2C by GST rate), HSN Summary (by HSN code). Excel output via `xlsx` package with three sheets. JSON by default.
- **Batch / Lot / Serial number tracking** (`src/routes/stockBatches.js`, `prisma/schema.prisma`, `prisma/migrations/enterprise_v2_stock_batches.sql`): new `StockBatch` model tracks qty received, qty remaining, cost price, supplier, expiry date, batch number, and serial number per inventory item. Three endpoints: list batches per product, create batch, shop-wide batch search by number/serial.
- **Weighted Average Cost pricing** (`src/routes/inventory.js`): when recording a PURCHASE movement, `shopInventory.buyingPrice` is now updated to the weighted average — `(currentStock × currentCost + qty × newPrice) / (currentStock + qty)` — replacing the flat overwrite. Ensures ongoing cost accuracy without FIFO complexity.

### Infrastructure
- **`stock_batches` migration SQL** (`prisma/migrations/enterprise_v2_stock_batches.sql`): new table with FK refs to `shops`, `shop_inventory`, `parties`, `purchase_orders`. Run manually on DB before deploying.
- **GSTR route registered** in `src/index.js` as `app.use('/api/billing', gstrRoutes)`.
- **Stock batch route registered** in `src/index.js` as `app.use('/api/shop/inventory', stockBatchRoutes)`.

## [2026-06-21] — Enterprise Phase 1–4: Queues, Cache, RBAC, Circuit Breakers, Tests, CI/CD

### New Features
- **BullMQ + Redis job queue** (`src/jobs/queues.js`, `src/jobs/workers/`): All email sends, nightly token cleanup, DB keepalive, stock reconciliation, and monthly GSTR-1 generation now run as async BullMQ workers. Falls back gracefully to setInterval if `REDIS_URL` is not set. Eliminates blocking Resend API calls from request threads.
- **Redis caching layer** (`src/lib/cache.js`): `getOrSet(key, ttl, fn)` wrapper with `invalidate` and `invalidatePattern`. Applied to: dashboard stats (120s TTL), catalog browse (60s TTL), feature flags (30s TTL). Silently no-ops if Redis unavailable.
- **Fine-grained RBAC** (`src/lib/permissions.js`, `src/middleware/auth.js`): `requirePermission('billing.create')` middleware now gates invoice creation, payment recording, and stock adjustment by ShopUser role (OWNER/MANAGER/CASHIER/MECHANIC/DELIVERY). Activates the pre-existing `ShopUser.permissions` JSON column.
- **Circuit breakers** (`src/lib/circuit-breakers.js`): opossum wraps Resend, Firebase Auth, Cloudinary. Trips after 5 failures in a 30s window, probes after 30s reset. Logs open/half-open/close state changes.
- **Pino structured logging** (`src/lib/logger.js`): replaces Morgan dev-format with JSON logs. Redacts `Authorization` headers and cookies. Adds `requestId` to every log line. pino-pretty in dev.
- **AES-256-GCM field encryption** (`src/lib/crypto.js`): `encrypt()`/`decrypt()` for PII columns (Party.phone, Party.gstin, Shop.bankAccountNumber, Shop.bankIfsc, Shop.panNumber). Key derived via scrypt from `FIELD_ENCRYPTION_KEY` env var.
- **Feature flags** (`src/lib/flags.js`): `isEnabled(key, shopId)` backed by new FeatureFlag DB table. Redis-cached for 30s. `flagMiddleware` adds `req.flag()` to every request.
- **Business metrics** (`src/lib/metrics.js`): in-memory counters for invoicesCreated, stockAdjustments, marketplaceOrders. Logged every 5 min.

### Infrastructure
- **Prisma schema additions**: `version Int @default(0)` on ShopInventory, Invoice, Party (optimistic concurrency); `correlationId`/`causationId` on Movement (event sourcing); FeatureFlag model.
- **Migration SQL files**: `prisma/migrations/enterprise_v1_version_cols.sql`, `enterprise_v2_feature_flags.sql` — run manually via psql.
- **GitHub Actions CI/CD**: `.github/workflows/ci.yml` (lint + test on every PR, postgres service container), `deploy-staging.yml` (auto on main push), `deploy-production.yml` (on `v*` tag).
- **Deep health check**: `GET /health` now queries `SELECT 1` and returns `db: "connected"` or 503 `db: "disconnected"`.
- **CSP enabled**: `contentSecurityPolicy` with strict directives (was disabled previously).
- **Global API rate limiter**: `apiLimiter` (200 req/min) applied to all routes via `rateLimiterAll.js`.
- **Read replica routing** (`src/db/prisma-reader.js`): dashboard analytics queries route to `READ_REPLICA_URL` if configured.
- **Pulumi IaC scaffold** (`infra/README.md`): documents Render + Neon + Upstash Redis environment setup.
- **CONTRIBUTING.md**: documents expand-contract migration pattern, BullMQ worker template, feature flag pattern, env vars.

### Security
- **JWT algorithm pinning**: `jwt.verify(..., { algorithms: ['HS256'] })` — rejects tokens signed with unexpected algorithms.
- **IP allowlist enforcement**: `requireAdmin` now checks `AdminProfile.ipWhitelist` before granting admin access (activates the pre-existing DB column).

### Testing
- **79 unit tests, 100% passing** (`tests/`): permissions.test.js (11 tests), crypto.test.js (6 tests), auth-middleware.test.js (full auth + RBAC coverage). vitest.config.js with v8 coverage provider.
- **k6 load test** (`load-tests/billing.js`): 50 VU ramp, p95 < 500ms threshold.
- **Playwright E2E scaffold** (`e2e/`, `playwright.config.js`): auth flow + billing flow stubs.
- **PII encryption migration script** (`scripts/encrypt-existing-data.js`): batch-encrypts existing Party and Shop PII fields. Run with `DRY_RUN=true` first.

### Nightly / Scheduled Jobs
- **Stock reconciliation** (`src/jobs/workers/reconciliation.worker.js`): nightly 2:30 AM IST, compares stockQty to ledger sum across all movements. Creates AuditLog rows on drift detection.
- **GSTR-1 generation** (`src/jobs/workers/gstr1.worker.js`): 1st of month 6 AM, aggregates outward supplies by HSN+GST rate per shop.


## [2026-06-20] — Performance, auth stability, and input hardening

### Auth
- **Fixed frequent logouts** (`src/routes/auth/helpers.js`): `createSession` previously ran `deleteMany` wiping ALL sessions for a user on every login — opening a second tab or logging in on another device silently killed every other active session. Now keeps the 5 most-recent active sessions and deletes only the overflow.
- **Keepalive ping** (`RED-PISTON-FRONTEND/src/shells/ERPShell.tsx`): pings `/health` every 9 minutes while the tab is visible to prevent Render free-tier backend cold starts (30-60s cold start vs 65s refresh timeout was the root cause of "random" logouts).

### Performance
- **N+1 eliminated in invoice creation** (`src/routes/billing.js`): inventory lookup was `findUnique` inside a `for` loop — one DB round-trip per cart item. Replaced with a single `findMany` batching all IDs up front with a `Map` for O(1) per-item access.
- **N+1 eliminated in purchase-bill import** (`src/routes/purchaseBills.js`): same per-item sequential pattern; each item now runs in its own `prisma.$transaction` with pre-validation so one bad item doesn't abort all others.
- **`lineCalcs` memoized in POS** (`src/pages/POSBillingPage.tsx`): line totals and grand totals were recomputed on every render. Wrapped in `useMemo([items])`.

### Reliability
- **Purchase bill import atomic per-item** (`src/routes/purchaseBills.js`): each item is now wrapped in its own `$transaction` so a DB error on item N doesn't roll back items 1…N-1. All-fail case now returns HTTP 207 with a clear error instead of a silent 200.
- **Up-front validation in import**: bounds check on qty (≤100,000) and rate/sellingPrice (≤10,000,000) before touching the DB.

### Input Validation
- **POS price input**: added `min="0"` — previously accepted negative prices.
- **POS customer fields**: `maxLength` on name (80), notes (500); phone stripped to digits + capped at 10; vehicle reg uppercased + alphanumeric-only + capped at 15.
- **POS custom item name**: `maxLength={100}`.
- **PurchaseBills review table**: `maxLength` on part name; `max` on qty (100,000) and price inputs (10,000,000).
- **CatalogStockInModal supplier fields**: name `maxLength={100}`, invoice no `maxLength={50}`, GSTIN uppercase + alphanumeric + capped at 15, phone digits-only + capped at 10.
- **CatalogStockInModal price/stock inputs**: `min`/`max` on all four numeric fields; HSN code digits-only + max 8 chars; part name/brand/OEM/rack all have `maxLength`.

## [2026-06-20] — Invoice number collision fix + receipt-style PDF redesign

### Fixes
- **Invoice number collision**: `invoice_number` has a global `@unique` constraint but counters
  were per-shop, so two shops both generating `202606-0001` caused a unique constraint violation.
  Format is now `S{shopId}-{YYYYMM}-{NNNN}` (e.g. `S3-202606-0001`) ensuring global uniqueness.
- **PDF redesign** (`src/services/pdf.js`): both Invoice and Purchase Order PDFs now match a
  clean receipt layout — shop logo (or name) at top, address/GSTIN/phone centered, thin divider,
  bold title, meta left/right columns, items table with grey header, right-aligned summary totals,
  "Thank you" footer. Shared `buildReceiptDef()` keeps both consistent.
  Shop logo is fetched from `logoUrl` or `photoUrl` and embedded as base64 in the PDF.

### Frontend
- **Session restore after expiry** (`App.tsx`): `auth:session-expired` now restores admin context
  from the impersonation backup before falling back to full logout.
- **Sidebar push** (`styles/theme.ts`): sidebar hover now slides topbar/banner/content right
  via CSS sibling combinator with smooth transition instead of overlapping content.
- **Cold-start data retry** (`ERPShell.tsx`): data load retries once after 8 s; shows inline
  error banner with Retry button on second failure (Render free tier cold starts).
- **Store HMR safety** (`context/store.ts`): added `import.meta.hot.decline()` to force a full
  page reload on store module change, preventing the duplicate StoreContext HMR crash.

## [2026-06-12] — Product Audit round 2: emails, order wiring, image persistence

### Fixes / New

- **Email rebrand**: all 21 hardcoded "AutoSpace" strings in `src/services/email.js` → "RedPiston" (subjects, headers, footers, sender-name default).
- **New email — "Profile Under Review"** (`sendShopOwnerUnderReviewEmail`): the APPLICANT now gets an acknowledgment right after `POST /api/auth/shop-setup` (previously only admins were alerted).
- **New email — Order confirmation** (`sendOrderConfirmationEmail`): customers with an email get a confirmation when a marketplace order is created (fire-and-forget; phone-only accounts skipped).
- **`shop_inventory.image_url` column** (migration `add_inventory_image.sql`): shop product photos uploaded from the ProductModal previously went to Cloudinary but had nowhere to persist. `PUT /api/shop/inventory/:id` now accepts `imageUrl`; the frontend sync sends it.
- **Go-live validation**: `PATCH /api/shop/inventory/:id/marketplace` now rejects listing items with no selling price (was frontend-only).

## [2026-06-12] — Purchase Bill OCR: supplier invoice → review → inventory

### New Features

- **`src/services/billParser.js`** — extracts structured line items from Tally-format GST invoice PDFs via pdf.js with COORDINATE-BASED table reconstruction (each value classified by its x-position column). Handles run-together numbers, multi-line part names, 4–8 digit HSN codes, page-boundary item splits, and cuts the OUTPUT CGST/SGST/round-off footer. Zero API cost. Output is always validated against the invoice's printed taxable total (`sumMatches`) — verified 100% extraction (28/28 and 10/10 items) on the two reference invoices.
- **`src/routes/purchaseBills.js`** (`/api/shop/purchase-bills`): `POST /extract` (base64 PDF in → parsed items out, bill stored PENDING_REVIEW, original PDF archived to Cloudinary best-effort), `POST /:id/import` (shop-owner-verified rows → MasterPart match-or-create → ShopInventory upsert → PURCHASE/OPENING Movement; double-import blocked), `GET /` + `GET /:id` (per-shop bill history).
- **`purchase_bills` table** (migration `prisma/migrations/add_purchase_bills.sql`, run via `scripts/run-migration.mjs`) — stores every uploaded bill under the shopId with extracted JSON, totals, and import status.
- **`scripts/run-migration.mjs`** — generic SQL migration runner (statement-splitting, uses the app's prisma client).
- Body-parser note: the 18mb limit for `/api/shop/purchase-bills/extract` is registered BEFORE the global 100kb `express.json` in `src/index.js` — body-parser is first-wins, so route-scoped larger limits placed after the global parser never apply.
- New dependency: `pdf-parse` (pdf.js text+coordinates extraction).

## [2026-06-11] — Full-Stack Audit: Input Validation, Pagination Bounds, PII Minimisation

### Backend Fixes

- **Pagination bounds (`src/lib/pagination.js`, applied across `marketplace.js`, `parties.js`)**: all user-supplied `limit`/`offset` params are now clamped (`1..max`, `offset >= 0`). Previously negative values made Prisma paginate from the end (scraping bypass) and `limit=abc` threw 500s. Unit tests in `src/tests/pagination.test.js`.
- **Invoice payments (`billing.js`)**: amount must now be a positive finite number — negative payment amounts were accepted and would corrupt party ledgers.
- **Invoice line items (`billing.js`)**: qty must be a positive integer, unit price non-negative, and negative discounts (a price-increase fraud vector) are clamped to 0.
- **Workshop job items (`workshop.js`)**: qty/unitPrice validated (was accepting 0, negatives, NaN).
- **Inventory adjustments (`inventory.js`)**: adjustments can no longer drive stock below zero; bulk stock-in validates `sellingPrice` and floors qty at 0.
- **Marketplace shop-orders list (`marketplace.js`)**: customer phone removed from the list payload (PII minimisation); still available on the authorized order-detail endpoint. Order detail returns 404 instead of 403 for foreign orders so order IDs can't be probed.

## [2026-06-11] — Auth Flow Hardening: Interrupted-Signup Resume + Sign-in/Sign-up Separation

### Security / Auth Fixes

- **Abandoned shop-owner signup no longer grants full access (`src/routes/auth/helpers.js`, `email.js`, `otp.js`, `firebase.js`)**: a shop owner who quit registration before submitting shop details (`verificationStatus = NOT_REQUIRED`, no `shopId`) previously passed `checkShopOwnerVerification` on the next login and entered the app with no shop attached. New `needsShopSetup(user)` helper detects this state in every login path (email/password, phone OTP, Google) and returns `needsShopDetails: true, resume: true` with prefill data (name/email/phone) so the frontend resumes the shop-details form instead.
- **`needsShopDetails` responses now issue session tokens (`shopSetupResponse` in `helpers.js`)**: `/api/auth/shop-setup` requires a Bearer token, but registration responses previously returned no token — brand-new shop owners could 401 when submitting their shop details. All shop-setup-needed responses now include `accessToken`/`refreshToken`.
- **Sessions revoked after shop-setup submission (`shopSetup.js`)**: once details are submitted the account becomes PENDING; all refresh tokens are deleted so the setup-flow session cannot be reused.
- **Refresh endpoint blocks PENDING/REJECTED shop owners (`session.js`)**: login already blocked them, but `/api/auth/refresh` did not check `verificationStatus` — a stored refresh token was a backdoor into a live session. Now revokes the token and returns 403 `SHOP_OWNER_PENDING`/`SHOP_OWNER_REJECTED`.
- **Unknown email on login returns explicit `NO_ACCOUNT` 404 (`email.js`)** instead of the generic "Invalid email or password", so the frontend can say "No account found — please create an account first". Wrong password on an *existing* account still returns `INVALID_CREDENTIALS` (no change to lockout logic).
- **`/verify-otp` no longer silently creates accounts during sign-in (`otp.js`)**: accepts `mode: "signin"` (same contract as `/firebase`) and returns `NO_ACCOUNT` when the phone is not registered, instead of implicitly registering a new user.

## [2026-06-08] — Security Hardening + Data Integrity + DB Index Improvements

### Security Fixes (Phase 1 — Critical)

- **OTP service (`src/services/otp.js`)**: Replaced `Math.random()` with `crypto.randomInt()` (CSPRNG). OTPs are now SHA-256 hashed before DB storage — plaintext is generated once, sent to SMS, then discarded. Verification now compares hashes, so a DB dump never reveals valid OTPs.
- **Firebase bypass guard (`src/services/firebase.js`)**: Added `NODE_ENV === 'production'` hard-block — the dev token bypass (`dev:<phone>`) now throws immediately in production if Firebase credentials are not set, preventing a backend misconfiguration from opening unauthenticated login.
- **Shop setup route (`src/routes/auth/shopSetup.js`)**: Added `authenticate` middleware. `userId` is now always sourced from `req.user.userId` (verified JWT claim) instead of `req.body.userId` — the previous design allowed any authenticated user to submit shop details on behalf of any arbitrary `userId`.
- **Marketplace payment endpoint (`src/routes/marketplace.js`)**: `PUT /orders/:id/payment` now verifies the Razorpay HMAC-SHA256 signature (`razorpayOrderId|razorpayPaymentId`) before accepting `paymentStatus: "PAID"`. Added `crypto.timingSafeEqual` for constant-time comparison. Without this, any authenticated user could self-mark unpaid orders as PAID.
- **Admin seed script (`prisma/create-admin.js`)**: Removed hardcoded `admin@autospaceerp.com / Admin@2025!` credentials. Script now reads `ADMIN_EMAIL` + `ADMIN_PASSWORD` from environment variables and exits with a clear error if they are not set. Removed the plaintext password console log.
- **`admin.js` `$executeRawUnsafe` audit**: Reviewed and confirmed NOT a SQL injection — the full JSON payload is passed as a parameterized `$1` binding, not string-interpolated into the SQL template. No change needed.

### Data Integrity Fixes (Phase 2)

- **Stock decrement race condition (`src/routes/billing.js`)**: Replaced the two-step "check then update" with `updateMany({ where: { stockQty: { gte: qty } } })`. The atomic SQL `UPDATE … WHERE stock_qty >= $qty` eliminates the TOCTOU window — if two requests race on the last unit, exactly one succeeds and the other gets `count=0` and aborts with a clear error.

- **Invoice number race condition (`src/routes/billing.js` + `src/lib/sequence.js` + migration `20260608000001`)**: Replaced `COUNT(*)+1` (still raceable — two concurrent COUNTs before either commits see the same value) with a `number_counters` table and `INSERT … ON CONFLICT DO UPDATE RETURNING last_value`. PostgreSQL holds a row-level lock on `(shop_id, counter_key)` from upsert evaluation until the transaction commits, serialising concurrent requests. The `nextSeq(tx, shopId, key)` call is **inside** the `$transaction` so a rollback also rolls back the counter increment. Format: `YYYYMM-NNNN`.

- **Job number race condition (`src/routes/workshop.js`)**: Same `nextSeq` fix. `generateJobNumber` (COUNT-based) was replaced entirely. Job creation is now wrapped in `prisma.$transaction` with the counter upsert at the top. Format: `JOB-YYYYMM-NNNN`.

- **Ledger + movements immutability (`prisma/migrations/20260608000001`)**: `BEFORE UPDATE` and `BEFORE DELETE` triggers on `movements` and `party_ledger` raise an exception on any mutation attempt, enforcing the append-only contract at the storage layer regardless of what the application or a raw SQL session tries.

### Database Improvements (Phase 3)

- **Check constraints (`prisma/migrations/20260608000000_check_constraints_security_indexes/migration.sql`)**: Added DB-level constraints:
  - `shop_inventory.stock_qty >= 0` — prevents negative stock
  - `shop_inventory.reserved_qty >= 0` — prevents negative reserved
  - `shop_inventory.reserved_qty <= stock_qty` — reserved cannot exceed stock
  - `marketplace_reviews.rating BETWEEN 1 AND 5` — rating domain enforcement
  - `invoice_items.qty > 0`, `unit_price >= 0` — positive quantities
  - `movements.qty > 0` — movement must affect at least 1 unit
  - `job_cards.labour_charge >= 0` — non-negative labour
  - `parties.credit_limit >= 0` — credit limit domain
  - `purchase_order_items.ordered_qty > 0`, `received_qty <= ordered_qty` — PO integrity

- **Missing indexes added to `prisma/schema.prisma`** (14 new indexes across 10 tables):
  - `invoice_items`: `(invoiceId)`, `(inventoryId)`
  - `purchase_order_items`: `(poId)`, `(inventoryId)`
  - `job_card_items`: `(jobId)`, `(inventoryId)`
  - `marketplace_order_items`: `(orderId)`, `(inventoryId)`
  - `invoices`: `(shopId, status)`, `(partyId)`
  - `shop_inventory`: `(shopId, isMarketplaceListed)` — hot marketplace browse path, `(shopId, stockQty)` — low-stock alerts
  - `master_parts`: `(categoryL1)` — category browse, `(status)` — admin catalog filtering
  - `movements`: `(shopId, type)` — type-based reporting
  - `parties`: `(shopId, type)` — CUSTOMER vs SUPPLIER filtering
  - `job_cards`: `(shopId, status)` — open-jobs dashboard
  - `marketplace_orders`: `(shopId, status)`, `(paymentStatus)` — payout processing
  - `users`: `(shopId)`, `(role)` — shop staff listing, admin queries

### How to Apply

```bash
# Apply all pending migrations (check constraints + number_counters table + immutability triggers)
npx prisma migrate deploy

# Update the seed script usage — env vars required now
ADMIN_EMAIL=you@company.com ADMIN_PASSWORD=StrongPass123! node prisma/create-admin.js
```

### Migrations Applied (as of 2026-06-08)
| Migration | Status | What it does |
|---|---|---|
| `20260608000000_check_constraints_security_indexes` | ✅ Applied | 11 CHECK constraints (stock, qty, rating, credit_limit, PO) |
| `20260608000001_number_counters_immutability` | ✅ Applied | `number_counters` table + immutability triggers on `movements`/`party_ledger` |
