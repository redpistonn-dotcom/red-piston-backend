-- ============================================================
-- PHASE 3 & 4 ONLY — Column swap + re-add FK constraints
-- (Phases 1 & 2 already committed successfully)
-- ============================================================

BEGIN;
SET LOCAL session_replication_role = replica;

-- Drop every FK constraint in the public schema
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN (
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  ) LOOP
    EXECUTE 'ALTER TABLE ' || quote_ident(r.table_name)
         || ' DROP CONSTRAINT IF EXISTS ' || quote_ident(r.constraint_name);
  END LOOP;
END $$;

-- ─── shops ───────────────────────────────────────────────
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_pkey;
ALTER TABLE shops DROP COLUMN shop_id;
ALTER TABLE shops RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE shops ADD PRIMARY KEY (shop_id);
CREATE SEQUENCE IF NOT EXISTS shops_shop_id_seq;
SELECT setval('shops_shop_id_seq', GREATEST(COALESCE((SELECT MAX(shop_id) FROM shops), 1), 1));
ALTER TABLE shops ALTER COLUMN shop_id SET DEFAULT nextval('shops_shop_id_seq');

-- ─── vehicles ────────────────────────────────────────────
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_pkey;
ALTER TABLE vehicles DROP COLUMN vehicle_id;
ALTER TABLE vehicles RENAME COLUMN _new_vehicle_id TO vehicle_id;
ALTER TABLE vehicles ADD PRIMARY KEY (vehicle_id);
CREATE SEQUENCE IF NOT EXISTS vehicles_vehicle_id_seq;
SELECT setval('vehicles_vehicle_id_seq', GREATEST(COALESCE((SELECT MAX(vehicle_id) FROM vehicles), 1), 1));
ALTER TABLE vehicles ALTER COLUMN vehicle_id SET DEFAULT nextval('vehicles_vehicle_id_seq');

-- ─── master_parts ─────────────────────────────────────────
ALTER TABLE master_parts DROP CONSTRAINT IF EXISTS master_parts_pkey;
ALTER TABLE master_parts DROP COLUMN master_part_id;
ALTER TABLE master_parts RENAME COLUMN _new_master_part_id TO master_part_id;
ALTER TABLE master_parts DROP COLUMN contributed_by_shop_id;
ALTER TABLE master_parts RENAME COLUMN _new_contributed_by_shop_id TO contributed_by_shop_id;
ALTER TABLE master_parts ADD PRIMARY KEY (master_part_id);
CREATE SEQUENCE IF NOT EXISTS master_parts_master_part_id_seq;
SELECT setval('master_parts_master_part_id_seq', GREATEST(COALESCE((SELECT MAX(master_part_id) FROM master_parts), 1), 1));
ALTER TABLE master_parts ALTER COLUMN master_part_id SET DEFAULT nextval('master_parts_master_part_id_seq');

-- ─── shop_inventory ───────────────────────────────────────
ALTER TABLE shop_inventory DROP CONSTRAINT IF EXISTS shop_inventory_pkey;
ALTER TABLE shop_inventory DROP CONSTRAINT IF EXISTS shop_inventory_shop_id_master_part_id_key;
ALTER TABLE shop_inventory DROP COLUMN inventory_id;
ALTER TABLE shop_inventory RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE shop_inventory DROP COLUMN shop_id;
ALTER TABLE shop_inventory RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE shop_inventory DROP COLUMN master_part_id;
ALTER TABLE shop_inventory RENAME COLUMN _new_master_part_id TO master_part_id;
ALTER TABLE shop_inventory ADD PRIMARY KEY (inventory_id);
ALTER TABLE shop_inventory ADD CONSTRAINT shop_inventory_shop_id_master_part_id_key UNIQUE (shop_id, master_part_id);
CREATE SEQUENCE IF NOT EXISTS shop_inventory_inventory_id_seq;
SELECT setval('shop_inventory_inventory_id_seq', GREATEST(COALESCE((SELECT MAX(inventory_id) FROM shop_inventory), 1), 1));
ALTER TABLE shop_inventory ALTER COLUMN inventory_id SET DEFAULT nextval('shop_inventory_inventory_id_seq');

-- ─── parties ──────────────────────────────────────────────
ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_pkey;
ALTER TABLE parties DROP COLUMN party_id;
ALTER TABLE parties RENAME COLUMN _new_party_id TO party_id;
ALTER TABLE parties DROP COLUMN shop_id;
ALTER TABLE parties RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE parties ADD PRIMARY KEY (party_id);
CREATE SEQUENCE IF NOT EXISTS parties_party_id_seq;
SELECT setval('parties_party_id_seq', GREATEST(COALESCE((SELECT MAX(party_id) FROM parties), 1), 1));
ALTER TABLE parties ALTER COLUMN party_id SET DEFAULT nextval('parties_party_id_seq');

-- ─── invoices ─────────────────────────────────────────────
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_pkey;
ALTER TABLE invoices DROP COLUMN invoice_id;
ALTER TABLE invoices RENAME COLUMN _new_invoice_id TO invoice_id;
ALTER TABLE invoices DROP COLUMN shop_id;
ALTER TABLE invoices RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE invoices DROP COLUMN party_id;
ALTER TABLE invoices RENAME COLUMN _new_party_id TO party_id;
ALTER TABLE invoices DROP COLUMN marketplace_order_id;
ALTER TABLE invoices RENAME COLUMN _new_marketplace_order_id TO marketplace_order_id;
ALTER TABLE invoices ADD PRIMARY KEY (invoice_id);
CREATE SEQUENCE IF NOT EXISTS invoices_invoice_id_seq;
SELECT setval('invoices_invoice_id_seq', GREATEST(COALESCE((SELECT MAX(invoice_id) FROM invoices), 1), 1));
ALTER TABLE invoices ALTER COLUMN invoice_id SET DEFAULT nextval('invoices_invoice_id_seq');

-- ─── part_fitments ────────────────────────────────────────
ALTER TABLE part_fitments DROP CONSTRAINT IF EXISTS part_fitments_pkey;
ALTER TABLE part_fitments DROP CONSTRAINT IF EXISTS part_fitments_master_part_id_vehicle_id_key;
ALTER TABLE part_fitments DROP COLUMN fitment_id;
ALTER TABLE part_fitments RENAME COLUMN _new_fitment_id TO fitment_id;
ALTER TABLE part_fitments DROP COLUMN master_part_id;
ALTER TABLE part_fitments RENAME COLUMN _new_master_part_id TO master_part_id;
ALTER TABLE part_fitments DROP COLUMN vehicle_id;
ALTER TABLE part_fitments RENAME COLUMN _new_vehicle_id TO vehicle_id;
ALTER TABLE part_fitments ADD PRIMARY KEY (fitment_id);
ALTER TABLE part_fitments ADD CONSTRAINT part_fitments_master_part_id_vehicle_id_key UNIQUE (master_part_id, vehicle_id);
CREATE SEQUENCE IF NOT EXISTS part_fitments_fitment_id_seq;
SELECT setval('part_fitments_fitment_id_seq', GREATEST(COALESCE((SELECT MAX(fitment_id) FROM part_fitments), 1), 1));
ALTER TABLE part_fitments ALTER COLUMN fitment_id SET DEFAULT nextval('part_fitments_fitment_id_seq');

-- ─── movements ────────────────────────────────────────────
ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_pkey;
ALTER TABLE movements DROP COLUMN movement_id;
ALTER TABLE movements RENAME COLUMN _new_movement_id TO movement_id;
ALTER TABLE movements DROP COLUMN shop_id;
ALTER TABLE movements RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE movements DROP COLUMN inventory_id;
ALTER TABLE movements RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE movements DROP COLUMN invoice_id;
ALTER TABLE movements RENAME COLUMN _new_invoice_id TO invoice_id;
ALTER TABLE movements DROP COLUMN party_id;
ALTER TABLE movements RENAME COLUMN _new_party_id TO party_id;
ALTER TABLE movements ADD PRIMARY KEY (movement_id);
CREATE SEQUENCE IF NOT EXISTS movements_movement_id_seq;
SELECT setval('movements_movement_id_seq', GREATEST(COALESCE((SELECT MAX(movement_id) FROM movements), 1), 1));
ALTER TABLE movements ALTER COLUMN movement_id SET DEFAULT nextval('movements_movement_id_seq');

-- ─── party_ledger ─────────────────────────────────────────
ALTER TABLE party_ledger DROP CONSTRAINT IF EXISTS party_ledger_pkey;
ALTER TABLE party_ledger DROP COLUMN ledger_id;
ALTER TABLE party_ledger RENAME COLUMN _new_ledger_id TO ledger_id;
ALTER TABLE party_ledger DROP COLUMN shop_id;
ALTER TABLE party_ledger RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE party_ledger DROP COLUMN party_id;
ALTER TABLE party_ledger RENAME COLUMN _new_party_id TO party_id;
ALTER TABLE party_ledger DROP COLUMN invoice_id;
ALTER TABLE party_ledger RENAME COLUMN _new_invoice_id TO invoice_id;
ALTER TABLE party_ledger ADD PRIMARY KEY (ledger_id);
CREATE SEQUENCE IF NOT EXISTS party_ledger_ledger_id_seq;
SELECT setval('party_ledger_ledger_id_seq', GREATEST(COALESCE((SELECT MAX(ledger_id) FROM party_ledger), 1), 1));
ALTER TABLE party_ledger ALTER COLUMN ledger_id SET DEFAULT nextval('party_ledger_ledger_id_seq');

-- ─── invoice_items ────────────────────────────────────────
ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_pkey;
ALTER TABLE invoice_items DROP COLUMN item_id;
ALTER TABLE invoice_items RENAME COLUMN _new_item_id TO item_id;
ALTER TABLE invoice_items DROP COLUMN invoice_id;
ALTER TABLE invoice_items RENAME COLUMN _new_invoice_id TO invoice_id;
ALTER TABLE invoice_items DROP COLUMN inventory_id;
ALTER TABLE invoice_items RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE invoice_items ADD PRIMARY KEY (item_id);
CREATE SEQUENCE IF NOT EXISTS invoice_items_item_id_seq;
SELECT setval('invoice_items_item_id_seq', GREATEST(COALESCE((SELECT MAX(item_id) FROM invoice_items), 1), 1));
ALTER TABLE invoice_items ALTER COLUMN item_id SET DEFAULT nextval('invoice_items_item_id_seq');

-- ─── invoice_payments ─────────────────────────────────────
ALTER TABLE invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_pkey;
ALTER TABLE invoice_payments DROP COLUMN id;
ALTER TABLE invoice_payments RENAME COLUMN _new_id TO id;
ALTER TABLE invoice_payments DROP COLUMN invoice_id;
ALTER TABLE invoice_payments RENAME COLUMN _new_invoice_id TO invoice_id;
ALTER TABLE invoice_payments ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS invoice_payments_id_seq;
SELECT setval('invoice_payments_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM invoice_payments), 1), 1));
ALTER TABLE invoice_payments ALTER COLUMN id SET DEFAULT nextval('invoice_payments_id_seq');

-- ─── purchase_orders ──────────────────────────────────────
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_pkey;
ALTER TABLE purchase_orders DROP COLUMN po_id;
ALTER TABLE purchase_orders RENAME COLUMN _new_po_id TO po_id;
ALTER TABLE purchase_orders DROP COLUMN shop_id;
ALTER TABLE purchase_orders RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE purchase_orders DROP COLUMN party_id;
ALTER TABLE purchase_orders RENAME COLUMN _new_party_id TO party_id;
ALTER TABLE purchase_orders ADD PRIMARY KEY (po_id);
CREATE SEQUENCE IF NOT EXISTS purchase_orders_po_id_seq;
SELECT setval('purchase_orders_po_id_seq', GREATEST(COALESCE((SELECT MAX(po_id) FROM purchase_orders), 1), 1));
ALTER TABLE purchase_orders ALTER COLUMN po_id SET DEFAULT nextval('purchase_orders_po_id_seq');

-- ─── purchase_order_items ─────────────────────────────────
ALTER TABLE purchase_order_items DROP CONSTRAINT IF EXISTS purchase_order_items_pkey;
ALTER TABLE purchase_order_items DROP COLUMN item_id;
ALTER TABLE purchase_order_items RENAME COLUMN _new_item_id TO item_id;
ALTER TABLE purchase_order_items DROP COLUMN po_id;
ALTER TABLE purchase_order_items RENAME COLUMN _new_po_id TO po_id;
ALTER TABLE purchase_order_items DROP COLUMN inventory_id;
ALTER TABLE purchase_order_items RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE purchase_order_items ADD PRIMARY KEY (item_id);
CREATE SEQUENCE IF NOT EXISTS purchase_order_items_item_id_seq;
SELECT setval('purchase_order_items_item_id_seq', GREATEST(COALESCE((SELECT MAX(item_id) FROM purchase_order_items), 1), 1));
ALTER TABLE purchase_order_items ALTER COLUMN item_id SET DEFAULT nextval('purchase_order_items_item_id_seq');

-- ─── job_cards ────────────────────────────────────────────
ALTER TABLE job_cards DROP CONSTRAINT IF EXISTS job_cards_pkey;
ALTER TABLE job_cards DROP COLUMN job_id;
ALTER TABLE job_cards RENAME COLUMN _new_job_id TO job_id;
ALTER TABLE job_cards DROP COLUMN shop_id;
ALTER TABLE job_cards RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE job_cards ADD PRIMARY KEY (job_id);
CREATE SEQUENCE IF NOT EXISTS job_cards_job_id_seq;
SELECT setval('job_cards_job_id_seq', GREATEST(COALESCE((SELECT MAX(job_id) FROM job_cards), 1), 1));
ALTER TABLE job_cards ALTER COLUMN job_id SET DEFAULT nextval('job_cards_job_id_seq');

-- ─── job_card_items ───────────────────────────────────────
ALTER TABLE job_card_items DROP CONSTRAINT IF EXISTS job_card_items_pkey;
ALTER TABLE job_card_items DROP COLUMN id;
ALTER TABLE job_card_items RENAME COLUMN _new_id TO id;
ALTER TABLE job_card_items DROP COLUMN job_id;
ALTER TABLE job_card_items RENAME COLUMN _new_job_id TO job_id;
ALTER TABLE job_card_items DROP COLUMN inventory_id;
ALTER TABLE job_card_items RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE job_card_items ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS job_card_items_id_seq;
SELECT setval('job_card_items_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM job_card_items), 1), 1));
ALTER TABLE job_card_items ALTER COLUMN id SET DEFAULT nextval('job_card_items_id_seq');

-- ─── marketplace_orders ───────────────────────────────────
ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_pkey;
ALTER TABLE marketplace_orders DROP COLUMN order_id;
ALTER TABLE marketplace_orders RENAME COLUMN _new_order_id TO order_id;
ALTER TABLE marketplace_orders DROP COLUMN shop_id;
ALTER TABLE marketplace_orders RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE marketplace_orders DROP COLUMN customer_vehicle_id;
ALTER TABLE marketplace_orders RENAME COLUMN _new_customer_vehicle_id TO customer_vehicle_id;
ALTER TABLE marketplace_orders DROP COLUMN delivery_address_id;
ALTER TABLE marketplace_orders RENAME COLUMN _new_delivery_address_id TO delivery_address_id;
ALTER TABLE marketplace_orders ADD PRIMARY KEY (order_id);
CREATE SEQUENCE IF NOT EXISTS marketplace_orders_order_id_seq;
SELECT setval('marketplace_orders_order_id_seq', GREATEST(COALESCE((SELECT MAX(order_id) FROM marketplace_orders), 1), 1));
ALTER TABLE marketplace_orders ALTER COLUMN order_id SET DEFAULT nextval('marketplace_orders_order_id_seq');

-- ─── marketplace_order_items ──────────────────────────────
ALTER TABLE marketplace_order_items DROP CONSTRAINT IF EXISTS marketplace_order_items_pkey;
ALTER TABLE marketplace_order_items DROP COLUMN item_id;
ALTER TABLE marketplace_order_items RENAME COLUMN _new_item_id TO item_id;
ALTER TABLE marketplace_order_items DROP COLUMN order_id;
ALTER TABLE marketplace_order_items RENAME COLUMN _new_order_id TO order_id;
ALTER TABLE marketplace_order_items DROP COLUMN inventory_id;
ALTER TABLE marketplace_order_items RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE marketplace_order_items ADD PRIMARY KEY (item_id);
CREATE SEQUENCE IF NOT EXISTS marketplace_order_items_item_id_seq;
SELECT setval('marketplace_order_items_item_id_seq', GREATEST(COALESCE((SELECT MAX(item_id) FROM marketplace_order_items), 1), 1));
ALTER TABLE marketplace_order_items ALTER COLUMN item_id SET DEFAULT nextval('marketplace_order_items_item_id_seq');

-- ─── marketplace_reviews ──────────────────────────────────
ALTER TABLE marketplace_reviews DROP CONSTRAINT IF EXISTS marketplace_reviews_pkey;
ALTER TABLE marketplace_reviews DROP COLUMN review_id;
ALTER TABLE marketplace_reviews RENAME COLUMN _new_review_id TO review_id;
ALTER TABLE marketplace_reviews DROP COLUMN master_part_id;
ALTER TABLE marketplace_reviews RENAME COLUMN _new_master_part_id TO master_part_id;
ALTER TABLE marketplace_reviews DROP COLUMN inventory_id;
ALTER TABLE marketplace_reviews RENAME COLUMN _new_inventory_id TO inventory_id;
ALTER TABLE marketplace_reviews DROP COLUMN order_id;
ALTER TABLE marketplace_reviews RENAME COLUMN _new_order_id TO order_id;
ALTER TABLE marketplace_reviews ADD PRIMARY KEY (review_id);
CREATE SEQUENCE IF NOT EXISTS marketplace_reviews_review_id_seq;
SELECT setval('marketplace_reviews_review_id_seq', GREATEST(COALESCE((SELECT MAX(review_id) FROM marketplace_reviews), 1), 1));
ALTER TABLE marketplace_reviews ALTER COLUMN review_id SET DEFAULT nextval('marketplace_reviews_review_id_seq');

-- ─── confirm_fit_requests ─────────────────────────────────
ALTER TABLE confirm_fit_requests DROP CONSTRAINT IF EXISTS confirm_fit_requests_pkey;
ALTER TABLE confirm_fit_requests DROP COLUMN id;
ALTER TABLE confirm_fit_requests RENAME COLUMN _new_id TO id;
ALTER TABLE confirm_fit_requests DROP COLUMN master_part_id;
ALTER TABLE confirm_fit_requests RENAME COLUMN _new_master_part_id TO master_part_id;
ALTER TABLE confirm_fit_requests DROP COLUMN shop_id;
ALTER TABLE confirm_fit_requests RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE confirm_fit_requests DROP COLUMN vehicle_id;
ALTER TABLE confirm_fit_requests RENAME COLUMN _new_vehicle_id TO vehicle_id;
ALTER TABLE confirm_fit_requests DROP COLUMN fitment_id;
ALTER TABLE confirm_fit_requests RENAME COLUMN _new_fitment_id TO fitment_id;
ALTER TABLE confirm_fit_requests ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS confirm_fit_requests_id_seq;
SELECT setval('confirm_fit_requests_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM confirm_fit_requests), 1), 1));
ALTER TABLE confirm_fit_requests ALTER COLUMN id SET DEFAULT nextval('confirm_fit_requests_id_seq');

-- ─── auth_providers ───────────────────────────────────────
ALTER TABLE auth_providers DROP CONSTRAINT IF EXISTS auth_providers_pkey;
ALTER TABLE auth_providers DROP COLUMN id;
ALTER TABLE auth_providers RENAME COLUMN _new_id TO id;
ALTER TABLE auth_providers ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS auth_providers_id_seq;
SELECT setval('auth_providers_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM auth_providers), 1), 1));
ALTER TABLE auth_providers ALTER COLUMN id SET DEFAULT nextval('auth_providers_id_seq');

-- ─── otp_codes ────────────────────────────────────────────
ALTER TABLE otp_codes DROP CONSTRAINT IF EXISTS otp_codes_pkey;
ALTER TABLE otp_codes DROP COLUMN id;
ALTER TABLE otp_codes RENAME COLUMN _new_id TO id;
ALTER TABLE otp_codes ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS otp_codes_id_seq;
SELECT setval('otp_codes_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM otp_codes), 1), 1));
ALTER TABLE otp_codes ALTER COLUMN id SET DEFAULT nextval('otp_codes_id_seq');

-- ─── refresh_tokens ───────────────────────────────────────
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_pkey;
ALTER TABLE refresh_tokens DROP COLUMN id;
ALTER TABLE refresh_tokens RENAME COLUMN _new_id TO id;
ALTER TABLE refresh_tokens DROP COLUMN shop_id;
ALTER TABLE refresh_tokens RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE refresh_tokens ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS refresh_tokens_id_seq;
SELECT setval('refresh_tokens_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM refresh_tokens), 1), 1));
ALTER TABLE refresh_tokens ALTER COLUMN id SET DEFAULT nextval('refresh_tokens_id_seq');

-- ─── password_reset_tokens ────────────────────────────────
ALTER TABLE password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_pkey;
ALTER TABLE password_reset_tokens DROP COLUMN id;
ALTER TABLE password_reset_tokens RENAME COLUMN _new_id TO id;
ALTER TABLE password_reset_tokens ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS password_reset_tokens_id_seq;
SELECT setval('password_reset_tokens_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM password_reset_tokens), 1), 1));
ALTER TABLE password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('password_reset_tokens_id_seq');

-- ─── user_profiles ────────────────────────────────────────
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_pkey;
ALTER TABLE user_profiles DROP COLUMN id;
ALTER TABLE user_profiles RENAME COLUMN _new_id TO id;
ALTER TABLE user_profiles ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS user_profiles_id_seq;
SELECT setval('user_profiles_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM user_profiles), 1), 1));
ALTER TABLE user_profiles ALTER COLUMN id SET DEFAULT nextval('user_profiles_id_seq');

-- ─── user_settings ────────────────────────────────────────
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_pkey;
ALTER TABLE user_settings DROP COLUMN id;
ALTER TABLE user_settings RENAME COLUMN _new_id TO id;
ALTER TABLE user_settings ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS user_settings_id_seq;
SELECT setval('user_settings_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM user_settings), 1), 1));
ALTER TABLE user_settings ALTER COLUMN id SET DEFAULT nextval('user_settings_id_seq');

-- ─── customer_profiles ────────────────────────────────────
ALTER TABLE customer_profiles DROP CONSTRAINT IF EXISTS customer_profiles_pkey;
ALTER TABLE customer_profiles DROP COLUMN id;
ALTER TABLE customer_profiles RENAME COLUMN _new_id TO id;
ALTER TABLE customer_profiles ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS customer_profiles_id_seq;
SELECT setval('customer_profiles_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM customer_profiles), 1), 1));
ALTER TABLE customer_profiles ALTER COLUMN id SET DEFAULT nextval('customer_profiles_id_seq');

-- ─── customer_addresses ───────────────────────────────────
ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_pkey;
ALTER TABLE customer_addresses DROP COLUMN address_id;
ALTER TABLE customer_addresses RENAME COLUMN _new_address_id TO address_id;
ALTER TABLE customer_addresses ADD PRIMARY KEY (address_id);
CREATE SEQUENCE IF NOT EXISTS customer_addresses_address_id_seq;
SELECT setval('customer_addresses_address_id_seq', GREATEST(COALESCE((SELECT MAX(address_id) FROM customer_addresses), 1), 1));
ALTER TABLE customer_addresses ALTER COLUMN address_id SET DEFAULT nextval('customer_addresses_address_id_seq');

-- ─── customer_vehicles ────────────────────────────────────
ALTER TABLE customer_vehicles DROP CONSTRAINT IF EXISTS customer_vehicles_pkey;
ALTER TABLE customer_vehicles DROP COLUMN id;
ALTER TABLE customer_vehicles RENAME COLUMN _new_id TO id;
ALTER TABLE customer_vehicles DROP COLUMN vehicle_id;
ALTER TABLE customer_vehicles RENAME COLUMN _new_vehicle_id TO vehicle_id;
ALTER TABLE customer_vehicles ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS customer_vehicles_id_seq;
SELECT setval('customer_vehicles_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM customer_vehicles), 1), 1));
ALTER TABLE customer_vehicles ALTER COLUMN id SET DEFAULT nextval('customer_vehicles_id_seq');

-- ─── admin_profiles ───────────────────────────────────────
ALTER TABLE admin_profiles DROP CONSTRAINT IF EXISTS admin_profiles_pkey;
ALTER TABLE admin_profiles DROP COLUMN id;
ALTER TABLE admin_profiles RENAME COLUMN _new_id TO id;
ALTER TABLE admin_profiles ADD PRIMARY KEY (id);
CREATE SEQUENCE IF NOT EXISTS admin_profiles_id_seq;
SELECT setval('admin_profiles_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM admin_profiles), 1), 1));
ALTER TABLE admin_profiles ALTER COLUMN id SET DEFAULT nextval('admin_profiles_id_seq');

-- ─── shop_users ───────────────────────────────────────────
ALTER TABLE shop_users DROP CONSTRAINT IF EXISTS shop_users_pkey;
ALTER TABLE shop_users DROP CONSTRAINT IF EXISTS shop_users_shop_id_user_id_key;
ALTER TABLE shop_users DROP COLUMN id;
ALTER TABLE shop_users RENAME COLUMN _new_id TO id;
ALTER TABLE shop_users DROP COLUMN shop_id;
ALTER TABLE shop_users RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE shop_users ADD PRIMARY KEY (id);
ALTER TABLE shop_users ADD CONSTRAINT shop_users_shop_id_user_id_key UNIQUE (shop_id, user_id);
CREATE SEQUENCE IF NOT EXISTS shop_users_id_seq;
SELECT setval('shop_users_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM shop_users), 1), 1));
ALTER TABLE shop_users ALTER COLUMN id SET DEFAULT nextval('shop_users_id_seq');

-- ─── users (FK only) ──────────────────────────────────────
ALTER TABLE users DROP COLUMN shop_id;
ALTER TABLE users RENAME COLUMN _new_shop_id TO shop_id;

-- ════════════════════════════════════════════════════════════
-- PHASE 4 — Re-add all foreign key constraints
-- ════════════════════════════════════════════════════════════

ALTER TABLE users ADD CONSTRAINT users_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE auth_providers ADD CONSTRAINT auth_providers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE user_settings ADD CONSTRAINT user_settings_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE customer_profiles ADD CONSTRAINT customer_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE customer_vehicles ADD CONSTRAINT customer_vehicles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE customer_vehicles ADD CONSTRAINT customer_vehicles_vehicle_id_fkey
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id);

ALTER TABLE admin_profiles ADD CONSTRAINT admin_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE shop_users ADD CONSTRAINT shop_users_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE;

ALTER TABLE shop_users ADD CONSTRAINT shop_users_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;

ALTER TABLE part_fitments ADD CONSTRAINT part_fitments_master_part_id_fkey
  FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id) ON DELETE CASCADE;

ALTER TABLE part_fitments ADD CONSTRAINT part_fitments_vehicle_id_fkey
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id) ON DELETE CASCADE;

ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_master_part_id_fkey
  FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id);

ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_vehicle_id_fkey
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id);

ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_fitment_id_fkey
  FOREIGN KEY (fitment_id) REFERENCES part_fitments(fitment_id);

ALTER TABLE shop_inventory ADD CONSTRAINT shop_inventory_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE shop_inventory ADD CONSTRAINT shop_inventory_master_part_id_fkey
  FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id);

ALTER TABLE parties ADD CONSTRAINT parties_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE invoices ADD CONSTRAINT invoices_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE invoices ADD CONSTRAINT invoices_party_id_fkey
  FOREIGN KEY (party_id) REFERENCES parties(party_id);

ALTER TABLE movements ADD CONSTRAINT movements_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE movements ADD CONSTRAINT movements_inventory_id_fkey
  FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);

ALTER TABLE movements ADD CONSTRAINT movements_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id);

ALTER TABLE movements ADD CONSTRAINT movements_party_id_fkey
  FOREIGN KEY (party_id) REFERENCES parties(party_id);

ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_party_id_fkey
  FOREIGN KEY (party_id) REFERENCES parties(party_id);

ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id);

ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE;

ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_inventory_id_fkey
  FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);

ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_party_id_fkey
  FOREIGN KEY (party_id) REFERENCES parties(party_id);

ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_po_id_fkey
  FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE;

ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_inventory_id_fkey
  FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);

ALTER TABLE job_cards ADD CONSTRAINT job_cards_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE job_card_items ADD CONSTRAINT job_card_items_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES job_cards(job_id) ON DELETE CASCADE;

ALTER TABLE job_card_items ADD CONSTRAINT job_card_items_inventory_id_fkey
  FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);

ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_shop_id_fkey
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id);

ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_customer_vehicle_id_fkey
  FOREIGN KEY (customer_vehicle_id) REFERENCES customer_vehicles(id);

ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_delivery_address_id_fkey
  FOREIGN KEY (delivery_address_id) REFERENCES customer_addresses(address_id);

ALTER TABLE marketplace_order_items ADD CONSTRAINT marketplace_order_items_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES marketplace_orders(order_id) ON DELETE CASCADE;

ALTER TABLE marketplace_order_items ADD CONSTRAINT marketplace_order_items_inventory_id_fkey
  FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);

ALTER TABLE marketplace_reviews ADD CONSTRAINT marketplace_reviews_master_part_id_fkey
  FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id);

ALTER TABLE marketplace_reviews ADD CONSTRAINT marketplace_reviews_inventory_id_fkey
  FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);

ALTER TABLE marketplace_reviews ADD CONSTRAINT marketplace_reviews_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(user_id);

SET LOCAL session_replication_role = DEFAULT;
COMMIT;
