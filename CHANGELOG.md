# Changelog

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
