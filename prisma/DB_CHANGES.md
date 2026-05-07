# Database Schema — Change Documentation

**Project:** AutoSpace / RedPiston  
**Backend:** Node.js + Prisma ORM + Supabase PostgreSQL  
**Prepared:** 2026-05-07  

---

## Table of Contents

1. [What Was Wrong — Old Schema Issues](#1-what-was-wrong--old-schema-issues)
2. [What Changed — Fix Summary](#2-what-changed--fix-summary)
3. [New Tables Added](#3-new-tables-added)
4. [All Tables — Purpose & Relations](#4-all-tables--purpose--relations)
5. [Relation Map](#5-relation-map)

---

## 1. What Was Wrong — Old Schema Issues

The old schema had **20 issues** across three severity levels discovered by comparing
the Prisma schema against the actual backend route code and application architecture.

---

### 🔴 Critical Issues (broke functionality or data integrity)

#### ISSUE-01 — `JobCard` table was completely missing
- **What happened:** The app has a full Workshop page with job cards (vehicle intake,
  diagnosis, parts used, labour charges, delivery). None of this had a database table.
  All workshop data only lived in browser `localStorage`.
- **Impact:** Workshop data is lost on browser clear. No multi-device sync. No server
  persistence. The backend `/api/shop/workshop` routes had nothing to query.
- **Fix:** Added `job_cards` + `job_card_items` tables.

#### ISSUE-02 — `PurchaseOrder` table was completely missing
- **What happened:** The app has an Orders page for raising purchase orders to suppliers.
  No `PurchaseOrder` model existed in the schema.
- **Impact:** Purchase order data only lived in `localStorage`. No invoice-style records,
  no received-vs-ordered tracking per line item.
- **Fix:** Added `purchase_orders` + `purchase_order_items` tables.

#### ISSUE-03 — `Movement.partyId` was an orphan string, not a foreign key
- **What happened:** `partyId String? @map("party_id")` existed but no
  `party Party? @relation(...)` was defined. Prisma could not enforce referential
  integrity, could not do `movement.party` joins, and the DB had no FK constraint.
- **Impact:** Movements could reference non-existent parties silently. No join possible
  via Prisma ORM — raw SQL required.
- **Fix:** Added proper `party Party? @relation(fields: [partyId], references: [partyId])`.

#### ISSUE-04 — `Movement.invoiceId` was an orphan string, not a foreign key
- **What happened:** Same problem as ISSUE-03 but for `invoiceId`. No relation defined.
- **Impact:** Could not navigate from a movement to its invoice via Prisma. No DB-level
  FK constraint protecting against dangling references.
- **Fix:** Added proper `invoice Invoice? @relation(fields: [invoiceId], references: [invoiceId])`.

#### ISSUE-05 — `MarketplaceOrder.customerId` was an orphan string
- **What happened:** `customerId String? @map("customer_id")` with no `User` relation.
- **Impact:** Cannot query "all orders for a customer" via Prisma. No FK constraint.
  Customer lookup required raw SQL.
- **Fix:** Added `customer User? @relation(fields: [customerId], references: [userId])`.

#### ISSUE-06 — `MarketplaceOrder.shopId` was an orphan string
- **What happened:** `shopId String @map("shop_id")` with no `Shop` relation.
- **Impact:** Cannot join marketplace orders to shop data (name, address) via Prisma.
- **Fix:** Added `shop Shop @relation(fields: [shopId], references: [shopId])`.

#### ISSUE-07 — `MarketplaceOrderItem.inventoryId` was an orphan string
- **What happened:** `inventoryId String @map("inventory_id")` with no `ShopInventory`
  relation on `MarketplaceOrderItem`.
- **Impact:** Cannot navigate from order item to inventory record. Stock reservation and
  fulfillment checks required raw SQL.
- **Fix:** Added proper `inventory ShopInventory @relation(...)`.

#### ISSUE-08 — `RefreshToken` had two columns storing the same SHA-256 hash
- **What happened:** Both `tokenHash` and `token` columns existed. Code comment on `token`
  explicitly said *"legacy column — same SHA-256 hash value"*. Both columns were written
  identically on every token creation.
- **Impact:** Wasted storage. Confusing queries. Risk of divergence if a future developer
  updates one but not the other.
- **Fix:** Removed the `token` column entirely. Only `token_hash` remains.

---

### 🟠 High Issues (data integrity / correctness problems)

#### ISSUE-09 — `PartFitment` had no unique constraint on `(masterPartId, vehicleId)`
- **What happened:** No `@@unique([masterPartId, vehicleId])` existed.
- **Impact:** The same part could be linked to the same vehicle multiple times. Fitment
  queries would return duplicate results, breaking the marketplace browse page.
- **Fix:** Added `@@unique([masterPartId, vehicleId])`.

#### ISSUE-10 — `UserProfile.addresses` JSON blob conflicted with `CustomerAddress` table
- **What happened:** `UserProfile` had `addresses Json? @default("[]")` storing addresses
  as a JSON array, while a separate normalized `CustomerAddress` model also existed.
  Two sources of truth for the same data.
- **Impact:** Which one does the backend actually read? `CustomerAddress` is the canonical
  table (used by `/api/customer/addresses` route). The JSON blob was stale and ignored.
- **Fix:** Removed `addresses` JSON column from `user_profiles`. `customer_addresses` is
  the single source of truth.

#### ISSUE-11 — `CustomerProfile.totalOrders` and `totalSpent` were stored computed values
- **What happened:** These columns were supposed to be updated every time a marketplace
  order was placed. But no transaction in the codebase actually updated them.
- **Impact:** Both columns were always 0. They would drift from reality the moment any
  edge case (cancelled order, refund) wasn't handled.
- **Fix:** Removed both columns. Compute from `COUNT(marketplace_orders)` and
  `SUM(marketplace_orders.total)` in queries when needed.

#### ISSUE-12 — `MasterPart` had both `oemNumber` (singular) and `oemNumbers` (array)
- **What happened:** `oemNumber String? @map("oem_number")` and
  `oemNumbers String[] @default([]) @map("oem_numbers")` both existed.
  The backend catalog route searched both fields separately.
- **Impact:** New parts added via API would store in the array; older data might only
  have the singular field. OEM lookups were inconsistent.
- **Fix:** Removed singular `oem_number` column. All OEM numbers go in `oem_numbers[]`.
  The catalog route was already capable of searching the array.

#### ISSUE-13 — `Invoice` and `Movement` had no `created_by` audit field
- **What happened:** No record of which cashier or manager created an invoice or recorded
  a stock movement.
- **Impact:** No audit trail. Cannot answer "who sold this?" or "who adjusted this stock?"
  Cannot detect unauthorized transactions per staff member.
- **Fix:** Added `created_by FK → users` to both `invoices` and `movements`.

#### ISSUE-14 — `MarketplaceReview` tied to customer via plain strings, not FK
- **What happened:** `customerName String` and `customerPhone String?` stored as raw text.
  No `userId` FK to the `users` table.
- **Impact:** Cannot verify if reviewer actually purchased the product. Cannot link reviews
  to user accounts. Allows fake/anonymous reviews with no accountability.
- **Fix:** Added `user_id FK → users` (nullable — kept in case account is deleted).
  `customerName` kept as snapshot for display after account deletion.

---

### 🟡 Medium Issues (missing fields, design gaps)

#### ISSUE-15 — `MarketplaceOrder` had no vehicle context
- **What happened:** Orders didn't record which vehicle the parts were purchased for.
- **Impact:** Cannot build fitment history ("parts bought for your Swift"). Cannot
  validate returns against vehicle compatibility. Customer support has no vehicle context.
- **Fix:** Added `customer_vehicle_id FK → customer_vehicles`.

#### ISSUE-16 — `Party` had no `updated_at` column
- **What happened:** Every other mutable table had `updated_at @updatedAt`. `Party` did not.
- **Impact:** Cannot tell when a party's credit limit or outstanding balance was last changed.
  Audit queries across tables would be inconsistent.
- **Fix:** Added `updated_at TIMESTAMP`.

#### ISSUE-17 — `OtpCode` had no index on email lookups
- **What happened:** `@@index([phone, expiresAt(sort: Desc)])` existed for phone OTP.
  Email OTP had no index.
- **Impact:** Email OTP verification did a full table scan on `otp_codes`. At volume
  this becomes slow.
- **Fix:** Added `@@index([email, expiresAt(sort: Desc)])`.

#### ISSUE-18 — `Shop` was missing `state`, `email`, and `plan` columns
- **What happened:** Shop had `city` and `pincode` but no `state`. No `email` field.
  No subscription `plan` field to track FREE / STARTER / PRO / ENTERPRISE tier.
- **Impact:** Cannot build state-level analytics. Cannot contact shop owners by email.
  Cannot enforce feature gating by plan.
- **Fix:** Added `state`, `email`, and `plan` + `plan_expires_at` columns.

#### ISSUE-19 — `PasswordResetToken` stored raw token string
- **What happened:** `token String @unique` stored the raw reset token value.
- **Impact:** If the database is breached, all pending reset tokens are readable and
  can be used to take over accounts before they expire.
- **Fix:** Renamed to `token_hash`, stores SHA-256 hash of the raw token.

#### ISSUE-20 — `InvoicePayment` table did not exist (udhaar settlement)
- **What happened:** When a customer paid back their credit (udhaar), the only record was
  a RECEIPT movement in the `movements` table and a decrement to `Party.outstanding`.
  No structured record of how much was paid, when, and via which payment mode.
- **Impact:** Cannot show a party's payment history on the ledger screen. Cannot reconcile
  partial payments. Cannot track UPI transaction IDs for payment proof.
- **Fix:** Added `invoice_payments` table.

---

## 2. What Changed — Fix Summary

| # | Table Affected | Type | What Changed |
|---|---|---|---|
| 01 | `job_cards` | ➕ New table | Full workshop job card model |
| 02 | `job_card_items` | ➕ New table | Parts and labour lines per job |
| 03 | `purchase_orders` | ➕ New table | Supplier purchase orders |
| 04 | `purchase_order_items` | ➕ New table | Line items per purchase order |
| 05 | `invoice_payments` | ➕ New table | Partial payment tracking for udhaar |
| 06 | `movements` | 🔧 Fixed | Added proper FK to `parties` and `invoices` |
| 07 | `movements` | 🔧 Fixed | Added `created_by` FK → `users` |
| 08 | `marketplace_orders` | 🔧 Fixed | Added proper FK to `users` and `shops` |
| 09 | `marketplace_orders` | ➕ Added field | `customer_vehicle_id` FK → `customer_vehicles` |
| 10 | `marketplace_order_items` | 🔧 Fixed | Added proper FK to `shop_inventory` |
| 11 | `marketplace_reviews` | 🔧 Fixed | Added `user_id` FK → `users` |
| 12 | `refresh_tokens` | 🗑 Removed column | Deleted duplicate `token` column |
| 13 | `part_fitments` | 🔧 Fixed | Added `@@unique([masterPartId, vehicleId])` |
| 14 | `user_profiles` | 🗑 Removed column | Deleted `addresses` JSON blob |
| 15 | `customer_profiles` | 🗑 Removed columns | Deleted `total_orders` and `total_spent` |
| 16 | `master_parts` | 🗑 Removed column | Deleted singular `oem_number` column |
| 17 | `invoices` | ➕ Added field | `created_by` FK → `users` |
| 18 | `invoices` | ➕ Added field | `paid_amount` and `PARTIAL` status |
| 19 | `invoice_items` | ➕ Added field | `brand` snapshot column |
| 20 | `parties` | ➕ Added field | `updated_at`, `email` |
| 21 | `shops` | ➕ Added fields | `state`, `email`, `plan`, `plan_expires_at` |
| 22 | `otp_codes` | 🔧 Fixed | Added `@@index([email, expiresAt DESC])` |
| 23 | `password_reset_tokens` | 🔧 Fixed | `token` → `token_hash` (SHA-256) |
| 24 | `marketplace_order_items` | ➕ Added field | `brand` snapshot column |

---

## 3. New Tables Added

### `job_cards`
Stores workshop jobs — vehicles brought in for repair or service. Each card tracks
the vehicle, the customer, complaint vs diagnosis, job status lifecycle, mechanic
assignment, odometer readings, and full billing (labour + parts).

**Why needed:** The Workshop page of the ERP had no database backing. All data was
stored in browser localStorage only, meaning it was lost on browser clear and could not
be synced across devices or staff members.

### `job_card_items`
Line items for a job card. Each row is either a PART (linked to shop inventory),
LABOUR (a flat labour charge with no inventory link), or OTHER (consumables, fees).

**Why needed:** A single job card has multiple billable items. Parts need to decrement
inventory. Labour needs separate tracking. Mixing them in a single field is not queryable.

### `purchase_orders`
Purchase orders raised by a shop when buying stock from a supplier. Records the full
GST breakdown (CGST, SGST, IGST), supplier snapshot, expected delivery date, received
date, and status (PENDING → RECEIVED or PARTIAL or CANCELLED).

**Why needed:** The Orders page of the ERP had no database backing. Without this table
there is no server-side record of what was ordered, from whom, at what price, or whether
it arrived. `ordered_qty` vs `received_qty` per line item supports partial deliveries.

### `purchase_order_items`
Line items for a purchase order. Tracks ordered quantity separately from received
quantity so partial deliveries can be recorded without cancelling the PO.

**Why needed:** A purchase order can contain multiple parts. Each line needs its own
GST calculation and delivery reconciliation.

### `invoice_payments`
Records each partial payment received against a credit invoice (udhaar settlement).
Stores the amount, payment mode (CASH, UPI, BANK_TRANSFER), and a reference number
(UPI transaction ID, cheque number, etc.).

**Why needed:** When a customer buys on credit they may pay back in instalments over
weeks or months. Without this table only one lump payment per invoice was possible.
The party ledger screen needs a full payment history per invoice.

---

## 4. All Tables — Purpose & Relations

### AUTH & IDENTITY

#### `users`
Single identity record for every person — shop owner, cashier, mechanic, marketplace
customer, or platform admin. One row per real person regardless of role.

Every action in the system (billing, stock movement, marketplace order, review) traces
back to a `user_id`. Role field (`CUSTOMER`, `SHOP_STAFF`, `PLATFORM_ADMIN`) controls
which parts of the app the user can access.

**Relations (outgoing):**
- `auth_providers` — login methods linked to this user
- `refresh_tokens` — active browser/device sessions
- `otp_codes` — OTP verification history
- `password_reset_tokens` — email password reset tokens
- `user_profiles` — optional personal details (DOB, gender)
- `user_settings` — notification and display preferences
- `customer_profiles` — wallet and loyalty (CUSTOMER role only)
- `customer_addresses` — saved delivery addresses
- `customer_vehicles` — garage (saved vehicles for fitment browsing)
- `shop_users` — which shops this user works at and in what capacity
- `admin_profiles` — internal ops details (PLATFORM_ADMIN role only)
- `invoices` via `created_by` — invoices this user created
- `movements` via `created_by` — stock movements this user recorded
- `marketplace_orders` via `customer_id` — orders this customer placed
- `marketplace_reviews` via `user_id` — reviews this user left

---

#### `auth_providers`
One row per login method per user. A single user can log in via Google, Phone OTP,
and Email/Password simultaneously — each is a separate row here.

Stores the external provider's identifier (`provider_id`) — Google sub claim, Firebase
UID, or phone/email — mapped to our internal `user_id`.

**Relations:** → `users`

---

#### `otp_codes`
One-time passwords for phone login and email verification. Stores the hashed OTP,
expiry timestamp, failed attempt count, and whether the code was used.

Stored in DB (not memory) so attempt counts and expiry survive server restarts.
The `ip_address` column supports rate limiting and abuse detection.

**Relations:** None (standalone, identified by phone or email)

---

#### `refresh_tokens`
One active session per device per user. Stores only the SHA-256 hash of the raw
token — never the token itself. Includes device info (user agent, platform) and
IP address for security audit.

`revoked_at` is set on logout. `last_used_at` is updated on every token refresh.
Expired and revoked rows are safe to purge periodically.

**Relations:** → `users` (cascade delete)

---

#### `password_reset_tokens`
Short-lived token (stored as SHA-256 hash) emailed to users who request a password
reset. Marked `used = true` immediately after the reset completes so it cannot be
replayed.

**Relations:** → `users`

---

### USER PROFILES

#### `user_profiles`
Optional personal details not needed for auth — gender and date of birth. Kept
separate so the core `users` table stays lean and profile creation is optional.

**Relations:** → `users` (one-to-one, cascade delete)

---

#### `user_settings`
Per-user preferences — email/SMS/push notification toggles, dark mode, language.
Separated from `users` so settings can be reset independently of the account.

**Relations:** → `users` (one-to-one, cascade delete)

---

#### `customer_profiles`
Marketplace-specific data for CUSTOMER role users only — wallet balance and loyalty
points. Not created for shop staff or admins.

`totalOrders` and `totalSpent` were removed because they were never updated by any
backend route and were always 0. These values are now computed from query aggregates.

**Relations:** → `users` (one-to-one, cascade delete)

---

#### `customer_addresses`
Saved delivery addresses for marketplace orders. A customer can save multiple
addresses with labels (Home, Work, Other) and one marked as default.

Normalized rows replace the old JSON blob in `user_profiles.addresses`. Structured
rows are indexable, validatable, and queryable by city/pincode.

**Relations:**  
- → `users` (cascade delete)  
- ← `marketplace_orders` (an order references the address used for delivery)

---

#### `customer_vehicles`
A customer's personal garage — vehicles they own. Stores make, model, year, fuel
type, registration number, and an optional link to the global vehicle catalog.
One vehicle can be marked default.

This is the core of fitment-guaranteed browsing. When a customer selects their
vehicle, every part shown on the marketplace is guaranteed to fit it. Without this
table, vehicle selection only lasts the browser session.

**Relations:**  
- → `users` (cascade delete)  
- → `vehicles` (optional catalog match)  
- ← `marketplace_orders` (records which vehicle the order was for)

---

#### `admin_profiles`
Internal platform ops team details. Stores their sub-role (SUPER_ADMIN, OPS, SUPPORT,
FINANCE), department, granular permission list, and IP whitelist for access control.

**Relations:** → `users` (one-to-one, cascade delete)

---

### SHOP & STAFF

#### `shops`
Every registered auto parts shop on the platform. Root anchor for all ERP data —
every invoice, inventory item, movement, party, and job card belongs to a shop.

Added `state` (for regional analytics), `email` (for owner contact), `plan` and
`plan_expires_at` (for subscription management and feature gating).

**Relations (outgoing):**
- `shop_users` — staff roster
- `shop_inventory` — parts stocked by this shop
- `movements` — all stock transactions
- `invoices` — all sales bills
- `purchase_orders` — all supplier orders
- `parties` — customers and suppliers
- `job_cards` — all workshop jobs
- `marketplace_orders` — marketplace orders fulfilled by this shop

---

#### `shop_users`
Junction table between `users` and `shops`. One row = one staff member at one shop.
A user can work at multiple shops (two branches). A shop can have many staff.

Stores the staff member's role (OWNER, MANAGER, CASHIER, MECHANIC, DELIVERY) and a
granular permissions JSON that lets shop owners fine-tune access beyond the role.

**Relations:**  
- → `shops` (cascade delete)  
- → `users` (cascade delete)

---

### VEHICLE & PARTS CATALOG

#### `vehicles`
Global catalog of every vehicle model sold in India — make, model, variant, year
range, fuel type, engine specs, transmission, body type. Not per-shop data.

Used by the fitment engine to determine which parts fit which vehicle when a
customer selects their vehicle on the marketplace.

**Relations:**  
- → `part_fitments` (which parts fit this vehicle)  
- → `customer_vehicles` (customers who own this vehicle model)

---

#### `master_parts`
Global parts catalog — every auto part, independent of any shop's stock. The single
source of truth for part names, GST rates, OEM numbers, barcodes, images, and
fitment flags.

Shops do not create their own part records. They create `shop_inventory` rows that
point here. This prevents 100 shops from having 100 different spellings of
"Bosch Oil Filter".

Removed singular `oem_number` — all OEM numbers now go into the `oem_numbers[]` array.

**Relations:**  
- → `part_fitments` (vehicles this part fits)  
- → `shop_inventory` (which shops stock this part, at what price)  
- → `marketplace_reviews` (reviews for this part globally)

---

#### `part_fitments`
Links a master part to a vehicle it is compatible with. Stores fit type (EXACT,
COMPATIBLE, UNIVERSAL), position (Front Left, Rear, All), and data source.

Added `@@unique([masterPartId, vehicleId])` to prevent duplicate fitment records
which caused the marketplace to show the same part twice for the same vehicle.

**Relations:**  
- → `master_parts` (cascade delete)  
- → `vehicles` (cascade delete)

---

### SHOP INVENTORY & STOCK LEDGER

#### `shop_inventory`
One row per part per shop. Stores this shop's selling price, buying price, stock
count, rack location, low-stock threshold, and marketplace listing status.

`stock_qty` is a denormalized cache of the sum of all `movements` for this item.
It is always updated atomically inside the same DB transaction as the movement INSERT.
This is intentional — computing stock from movement sum on every request would be
too slow at scale.

**Relations:**  
- → `shops`  
- → `master_parts`  
- ← `movements` (all stock events for this item)  
- ← `invoice_items` (appears in sale invoices)  
- ← `purchase_order_items` (appears in purchase orders)  
- ← `job_card_items` (parts used in workshop jobs)  
- ← `marketplace_order_items` (sold via marketplace)  
- ← `marketplace_reviews` (reviews for this shop's listing)

---

#### `movements`
The immutable stock ledger. Every stock change is a new INSERT — never an UPDATE
or DELETE. Tracks purchases, sales, returns, damage, theft, adjustments.

This is the audit trail for every unit of stock. `shop_inventory.stock_qty` is
just a cached running total of this ledger for query performance.

Fixed: `partyId` and `invoiceId` now have proper FK relations (were orphan strings).
Added: `created_by FK → users` for full audit trail per cashier/manager.

Supported movement types:
- `PURCHASE` — stock received from supplier
- `SALE` — stock sold via POS invoice
- `OPENING` — initial stock when product is first added
- `RETURN_IN` — customer returned a part (stock back in)
- `RETURN_OUT` — returning part to supplier (stock goes out)
- `DAMAGE` — damaged stock written off
- `THEFT` — stolen stock written off
- `ADJUSTMENT` — manual stock correction
- `AUDIT` — physical count adjustment
- `RECEIPT` — financial-only (udhaar payment received, qty = 0)
- `CREDIT_NOTE` / `DEBIT_NOTE` — financial corrections

**Relations:**  
- → `shops`  
- → `shop_inventory`  
- → `users` via `created_by`  
- → `invoices` via `invoice_id`  
- → `parties` via `party_id`

---

### PARTIES

#### `parties`
Every customer or supplier a shop deals with. Type can be CUSTOMER (buys on
credit/udhaar), SUPPLIER (shop buys from them), or BOTH.

`credit_limit` caps how much credit can be extended. `outstanding` is the running
balance of unpaid dues — updated atomically every time a credit sale or payment
receipt is recorded.

Added `updated_at` (was missing) and `email` for supplier contact.

**Relations:**  
- → `shops`  
- ← `invoices` (credit sales to this customer)  
- ← `movements` (RECEIPT movements when they pay back)  
- ← `purchase_orders` (orders raised from this supplier)

---

### INVOICES

#### `invoices`
Every sales bill raised by a shop. Full GST breakdown per bill (subtotal, taxable,
CGST, SGST, IGST, total). Multi-tender payment support (Cash + UPI + Credit in one
bill). Party details snapshotted at billing time.

Added `created_by FK → users` for cashier audit trail.
Added `paid_amount` to track partial payments received on credit invoices.
Added `PARTIAL` status for invoices where some payment has been received but not all.

**Relations:**  
- → `shops`  
- → `parties` (nullable — walk-in customers have no party record)  
- → `users` via `created_by`  
- ← `invoice_items` (line items)  
- ← `movements` (SALE movements created alongside this invoice)  
- ← `invoice_payments` (each partial payment received)

---

#### `invoice_items`
Each line item in a sales invoice — part, quantity, unit price, discount, and full
GST breakdown. Part name, brand, and HSN code are snapshotted at sale time so the
invoice record is permanently accurate even if the catalog is later updated.

Added `brand` snapshot column (was missing).

**Relations:**  
- → `invoices` (cascade delete)  
- → `shop_inventory`

---

#### `invoice_payments`
Each partial payment received against a credit invoice (udhaar settlement). Supports
multiple instalments per invoice with payment mode and reference number tracking.

**Why:** Credit customers often pay in multiple instalments over weeks. Each instalment
needs a separate timestamped record for the ledger. The party screen shows this full
payment timeline.

**Relations:** → `invoices` (cascade delete)

---

### PURCHASE ORDERS

#### `purchase_orders`
Purchase orders raised by a shop when buying stock from a supplier. Full GST
breakdown, supplier snapshot, expected delivery date, and status lifecycle
(PENDING → RECEIVED / PARTIAL / CANCELLED).

**Relations:**  
- → `shops`  
- → `parties` (supplier)  
- ← `purchase_order_items`

---

#### `purchase_order_items`
Line items per purchase order. `ordered_qty` vs `received_qty` tracked separately
to support partial deliveries without cancelling the whole PO.

**Relations:**  
- → `purchase_orders` (cascade delete)  
- → `shop_inventory`

---

### WORKSHOP / JOB CARDS

#### `job_cards`
A workshop job — vehicle brought in for service or repair. Tracks vehicle details
(make, model, reg, odometer), customer contact, complaint vs diagnosis, job status,
mechanic assignment, and billing (labour + parts total).

Status lifecycle: `RECEIVED → IN_PROGRESS → WAITING_PARTS → READY → DELIVERED`

**Relations:**  
- → `shops`  
- → `users` via `created_by`  
- ← `job_card_items` (parts used and labour charged)

---

#### `job_card_items`
Line items for a job card. Each row is PART (pulls from inventory), LABOUR (no
inventory link, flat rate), or OTHER (consumables, fees). Parts link to
`shop_inventory` so stock is decremented when the job is completed.

**Relations:**  
- → `job_cards` (cascade delete)  
- → `shop_inventory` (nullable — null for LABOUR and OTHER lines)

---

### MARKETPLACE

#### `marketplace_orders`
B2C orders placed by customers on the marketplace. Tracks the customer, fulfilling
shop, delivery address, payment info (including Razorpay IDs), and full order status
lifecycle from PENDING to DELIVERED or RETURNED.

Added `customer_vehicle_id` so each order records which vehicle in the customer's
garage the parts were purchased for — enables fitment history and return validation.

Fixed: `customer_id` and `shop_id` now have proper FK relations (were orphan strings).

**Relations:**  
- → `users` via `customer_id`  
- → `customer_vehicles` via `customer_vehicle_id`  
- → `shops`  
- → `customer_addresses` via `delivery_address_id`  
- ← `marketplace_order_items`

---

#### `marketplace_order_items`
Each part in a marketplace order. Part name and brand snapshotted at purchase time.

Fixed: `inventory_id` now has proper FK to `shop_inventory` (was orphan string).

**Relations:**  
- → `marketplace_orders` (cascade delete)  
- → `shop_inventory`

---

#### `marketplace_reviews`
Customer reviews for parts on the marketplace. Links to both the global master part
(for catalog-level ratings) and the specific shop's inventory listing (for
shop-specific ratings). Verified purchase flag set when `order_id` matches an actual
completed order.

Added `user_id FK → users` (was storing customer as plain name/phone strings).
`customer_name` snapshot kept for display if the user later deletes their account.

**Relations:**  
- → `master_parts`  
- → `shop_inventory` (nullable)  
- → `users` via `user_id` (nullable)

---

## 5. Relation Map

```
users
  ├── auth_providers          (login methods: Google, Phone, Email)
  ├── refresh_tokens          (active sessions per device)
  ├── otp_codes               (OTP verification history)
  ├── password_reset_tokens   (email reset tokens)
  ├── user_profiles           (gender, DOB)
  ├── user_settings           (notifications, dark mode, language)
  ├── customer_profiles       (wallet, loyalty points)
  ├── customer_addresses      (saved delivery addresses)
  ├── customer_vehicles ──────→ vehicles (catalog match)
  ├── admin_profiles          (ops team sub-role + permissions)
  ├── shop_users ─────────────→ shops
  ├── invoices          [created_by]
  ├── movements         [created_by]
  ├── marketplace_orders [customer_id]
  └── marketplace_reviews [user_id]

shops
  ├── shop_users              (staff: OWNER, MANAGER, CASHIER, MECHANIC, DELIVERY)
  ├── shop_inventory ─────────→ master_parts
  │     ├── movements         (immutable ledger: PURCHASE, SALE, DAMAGE, etc.)
  │     ├── invoice_items
  │     ├── purchase_order_items
  │     ├── job_card_items
  │     ├── marketplace_order_items
  │     └── marketplace_reviews
  ├── movements         [shopId]
  ├── invoices ───────────────→ parties
  │     ├── invoice_items     (line items with GST breakdown)
  │     ├── invoice_payments  (partial udhaar settlements)
  │     └── movements         [invoiceId — SALE events]
  ├── purchase_orders ────────→ parties
  │     └── purchase_order_items
  ├── parties                 (CUSTOMER / SUPPLIER / BOTH)
  ├── job_cards               (workshop jobs)
  │     └── job_card_items    (PART / LABOUR / OTHER lines)
  └── marketplace_orders ─────→ users + customer_vehicles
        └── marketplace_order_items

master_parts
  ├── part_fitments ──────────→ vehicles
  ├── shop_inventory          (per-shop pricing and stock)
  └── marketplace_reviews
```

---

*This document was generated as part of the initial DB architecture review.*
*Schema file: `backend/prisma/schema.prisma`*
