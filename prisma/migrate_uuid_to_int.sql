-- ============================================================
-- MIGRATION: Convert all UUID string IDs → auto-increment INT
-- Run once against your PostgreSQL database.
-- Safe to run in a transaction; rolls back on any error.
-- ============================================================

BEGIN;

-- Disable FK enforcement for this session so we can swap columns freely
SET session_replication_role = replica;

-- ════════════════════════════════════════════════════════════
-- PHASE 1 — Add _new_* integer columns to every PK table
--            and assign sequential numbers ordered by created_at
-- ════════════════════════════════════════════════════════════

-- shops
ALTER TABLE shops ADD COLUMN _new_shop_id INT;
WITH n AS (SELECT shop_id, ROW_NUMBER() OVER (ORDER BY created_at, shop_id) AS rn FROM shops)
UPDATE shops SET _new_shop_id = n.rn FROM n WHERE shops.shop_id = n.shop_id;

-- vehicles
ALTER TABLE vehicles ADD COLUMN _new_vehicle_id INT;
WITH n AS (SELECT vehicle_id, ROW_NUMBER() OVER (ORDER BY created_at, vehicle_id) AS rn FROM vehicles)
UPDATE vehicles SET _new_vehicle_id = n.rn FROM n WHERE vehicles.vehicle_id = n.vehicle_id;

-- master_parts
ALTER TABLE master_parts ADD COLUMN _new_master_part_id INT;
WITH n AS (SELECT master_part_id, ROW_NUMBER() OVER (ORDER BY created_at, master_part_id) AS rn FROM master_parts)
UPDATE master_parts SET _new_master_part_id = n.rn FROM n WHERE master_parts.master_part_id = n.master_part_id;

-- shop_inventory
ALTER TABLE shop_inventory ADD COLUMN _new_inventory_id INT;
WITH n AS (SELECT inventory_id, ROW_NUMBER() OVER (ORDER BY created_at, inventory_id) AS rn FROM shop_inventory)
UPDATE shop_inventory SET _new_inventory_id = n.rn FROM n WHERE shop_inventory.inventory_id = n.inventory_id;

-- parties
ALTER TABLE parties ADD COLUMN _new_party_id INT;
WITH n AS (SELECT party_id, ROW_NUMBER() OVER (ORDER BY created_at, party_id) AS rn FROM parties)
UPDATE parties SET _new_party_id = n.rn FROM n WHERE parties.party_id = n.party_id;

-- invoices
ALTER TABLE invoices ADD COLUMN _new_invoice_id INT;
WITH n AS (SELECT invoice_id, ROW_NUMBER() OVER (ORDER BY created_at, invoice_id) AS rn FROM invoices)
UPDATE invoices SET _new_invoice_id = n.rn FROM n WHERE invoices.invoice_id = n.invoice_id;

-- part_fitments
ALTER TABLE part_fitments ADD COLUMN _new_fitment_id INT;
WITH n AS (SELECT fitment_id, ROW_NUMBER() OVER (ORDER BY created_at, fitment_id) AS rn FROM part_fitments)
UPDATE part_fitments SET _new_fitment_id = n.rn FROM n WHERE part_fitments.fitment_id = n.fitment_id;

-- movements
ALTER TABLE movements ADD COLUMN _new_movement_id INT;
WITH n AS (SELECT movement_id, ROW_NUMBER() OVER (ORDER BY created_at, movement_id) AS rn FROM movements)
UPDATE movements SET _new_movement_id = n.rn FROM n WHERE movements.movement_id = n.movement_id;

-- party_ledger
ALTER TABLE party_ledger ADD COLUMN _new_ledger_id INT;
WITH n AS (SELECT ledger_id, ROW_NUMBER() OVER (ORDER BY created_at, ledger_id) AS rn FROM party_ledger)
UPDATE party_ledger SET _new_ledger_id = n.rn FROM n WHERE party_ledger.ledger_id = n.ledger_id;

-- invoice_items
ALTER TABLE invoice_items ADD COLUMN _new_item_id INT;
WITH n AS (SELECT item_id, ROW_NUMBER() OVER (ORDER BY item_id) AS rn FROM invoice_items)
UPDATE invoice_items SET _new_item_id = n.rn FROM n WHERE invoice_items.item_id = n.item_id;

-- invoice_payments
ALTER TABLE invoice_payments ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY received_at, id) AS rn FROM invoice_payments)
UPDATE invoice_payments SET _new_id = n.rn FROM n WHERE invoice_payments.id = n.id;

-- purchase_orders
ALTER TABLE purchase_orders ADD COLUMN _new_po_id INT;
WITH n AS (SELECT po_id, ROW_NUMBER() OVER (ORDER BY created_at, po_id) AS rn FROM purchase_orders)
UPDATE purchase_orders SET _new_po_id = n.rn FROM n WHERE purchase_orders.po_id = n.po_id;

-- purchase_order_items
ALTER TABLE purchase_order_items ADD COLUMN _new_item_id INT;
WITH n AS (SELECT item_id, ROW_NUMBER() OVER (ORDER BY item_id) AS rn FROM purchase_order_items)
UPDATE purchase_order_items SET _new_item_id = n.rn FROM n WHERE purchase_order_items.item_id = n.item_id;

-- job_cards
ALTER TABLE job_cards ADD COLUMN _new_job_id INT;
WITH n AS (SELECT job_id, ROW_NUMBER() OVER (ORDER BY created_at, job_id) AS rn FROM job_cards)
UPDATE job_cards SET _new_job_id = n.rn FROM n WHERE job_cards.job_id = n.job_id;

-- job_card_items
ALTER TABLE job_card_items ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM job_card_items)
UPDATE job_card_items SET _new_id = n.rn FROM n WHERE job_card_items.id = n.id;

-- marketplace_orders
ALTER TABLE marketplace_orders ADD COLUMN _new_order_id INT;
WITH n AS (SELECT order_id, ROW_NUMBER() OVER (ORDER BY created_at, order_id) AS rn FROM marketplace_orders)
UPDATE marketplace_orders SET _new_order_id = n.rn FROM n WHERE marketplace_orders.order_id = n.order_id;

-- marketplace_order_items
ALTER TABLE marketplace_order_items ADD COLUMN _new_item_id INT;
WITH n AS (SELECT item_id, ROW_NUMBER() OVER (ORDER BY item_id) AS rn FROM marketplace_order_items)
UPDATE marketplace_order_items SET _new_item_id = n.rn FROM n WHERE marketplace_order_items.item_id = n.item_id;

-- marketplace_reviews
ALTER TABLE marketplace_reviews ADD COLUMN _new_review_id INT;
WITH n AS (SELECT review_id, ROW_NUMBER() OVER (ORDER BY created_at, review_id) AS rn FROM marketplace_reviews)
UPDATE marketplace_reviews SET _new_review_id = n.rn FROM n WHERE marketplace_reviews.review_id = n.review_id;

-- confirm_fit_requests
ALTER TABLE confirm_fit_requests ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM confirm_fit_requests)
UPDATE confirm_fit_requests SET _new_id = n.rn FROM n WHERE confirm_fit_requests.id = n.id;

-- auth_providers
ALTER TABLE auth_providers ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY linked_at, id) AS rn FROM auth_providers)
UPDATE auth_providers SET _new_id = n.rn FROM n WHERE auth_providers.id = n.id;

-- otp_codes
ALTER TABLE otp_codes ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM otp_codes)
UPDATE otp_codes SET _new_id = n.rn FROM n WHERE otp_codes.id = n.id;

-- refresh_tokens
ALTER TABLE refresh_tokens ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM refresh_tokens)
UPDATE refresh_tokens SET _new_id = n.rn FROM n WHERE refresh_tokens.id = n.id;

-- password_reset_tokens
ALTER TABLE password_reset_tokens ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM password_reset_tokens)
UPDATE password_reset_tokens SET _new_id = n.rn FROM n WHERE password_reset_tokens.id = n.id;

-- user_profiles
ALTER TABLE user_profiles ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM user_profiles)
UPDATE user_profiles SET _new_id = n.rn FROM n WHERE user_profiles.id = n.id;

-- user_settings
ALTER TABLE user_settings ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM user_settings)
UPDATE user_settings SET _new_id = n.rn FROM n WHERE user_settings.id = n.id;

-- customer_profiles
ALTER TABLE customer_profiles ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM customer_profiles)
UPDATE customer_profiles SET _new_id = n.rn FROM n WHERE customer_profiles.id = n.id;

-- customer_addresses
ALTER TABLE customer_addresses ADD COLUMN _new_address_id INT;
WITH n AS (SELECT address_id, ROW_NUMBER() OVER (ORDER BY created_at, address_id) AS rn FROM customer_addresses)
UPDATE customer_addresses SET _new_address_id = n.rn FROM n WHERE customer_addresses.address_id = n.address_id;

-- customer_vehicles
ALTER TABLE customer_vehicles ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM customer_vehicles)
UPDATE customer_vehicles SET _new_id = n.rn FROM n WHERE customer_vehicles.id = n.id;

-- admin_profiles
ALTER TABLE admin_profiles ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM admin_profiles)
UPDATE admin_profiles SET _new_id = n.rn FROM n WHERE admin_profiles.id = n.id;

-- shop_users
ALTER TABLE shop_users ADD COLUMN _new_id INT;
WITH n AS (SELECT id, ROW_NUMBER() OVER (ORDER BY joined_at, id) AS rn FROM shop_users)
UPDATE shop_users SET _new_id = n.rn FROM n WHERE shop_users.id = n.id;


-- ════════════════════════════════════════════════════════════
-- PHASE 2 — Populate new integer FK columns in child tables
--            by joining to parent's _new_* column
-- ════════════════════════════════════════════════════════════

-- users.shop_id
ALTER TABLE users ADD COLUMN _new_shop_id INT;
UPDATE users u SET _new_shop_id = s._new_shop_id FROM shops s WHERE u.shop_id = s.shop_id;

-- refresh_tokens.shop_id
ALTER TABLE refresh_tokens ADD COLUMN _new_shop_id INT;
UPDATE refresh_tokens r SET _new_shop_id = s._new_shop_id FROM shops s WHERE r.shop_id = s.shop_id;

-- shop_users.shop_id
ALTER TABLE shop_users ADD COLUMN _new_shop_id INT;
UPDATE shop_users su SET _new_shop_id = s._new_shop_id FROM shops s WHERE su.shop_id = s.shop_id;

-- customer_vehicles.vehicle_id
ALTER TABLE customer_vehicles ADD COLUMN _new_vehicle_id INT;
UPDATE customer_vehicles cv SET _new_vehicle_id = v._new_vehicle_id FROM vehicles v WHERE cv.vehicle_id = v.vehicle_id;

-- master_parts.contributed_by_shop_id
ALTER TABLE master_parts ADD COLUMN _new_contributed_by_shop_id INT;
UPDATE master_parts m SET _new_contributed_by_shop_id = s._new_shop_id FROM shops s WHERE m.contributed_by_shop_id = s.shop_id;

-- shop_inventory FKs
ALTER TABLE shop_inventory ADD COLUMN _new_shop_id INT;
UPDATE shop_inventory si SET _new_shop_id = s._new_shop_id FROM shops s WHERE si.shop_id = s.shop_id;
ALTER TABLE shop_inventory ADD COLUMN _new_master_part_id INT;
UPDATE shop_inventory si SET _new_master_part_id = mp._new_master_part_id FROM master_parts mp WHERE si.master_part_id = mp.master_part_id;

-- part_fitments FKs
ALTER TABLE part_fitments ADD COLUMN _new_master_part_id INT;
UPDATE part_fitments pf SET _new_master_part_id = mp._new_master_part_id FROM master_parts mp WHERE pf.master_part_id = mp.master_part_id;
ALTER TABLE part_fitments ADD COLUMN _new_vehicle_id INT;
UPDATE part_fitments pf SET _new_vehicle_id = v._new_vehicle_id FROM vehicles v WHERE pf.vehicle_id = v.vehicle_id;

-- confirm_fit_requests FKs
ALTER TABLE confirm_fit_requests ADD COLUMN _new_master_part_id INT;
UPDATE confirm_fit_requests c SET _new_master_part_id = mp._new_master_part_id FROM master_parts mp WHERE c.master_part_id = mp.master_part_id;
ALTER TABLE confirm_fit_requests ADD COLUMN _new_shop_id INT;
UPDATE confirm_fit_requests c SET _new_shop_id = s._new_shop_id FROM shops s WHERE c.shop_id = s.shop_id;
ALTER TABLE confirm_fit_requests ADD COLUMN _new_vehicle_id INT;
UPDATE confirm_fit_requests c SET _new_vehicle_id = v._new_vehicle_id FROM vehicles v WHERE c.vehicle_id = v.vehicle_id;
ALTER TABLE confirm_fit_requests ADD COLUMN _new_fitment_id INT;
UPDATE confirm_fit_requests c SET _new_fitment_id = pf._new_fitment_id FROM part_fitments pf WHERE c.fitment_id = pf.fitment_id;

-- parties.shop_id
ALTER TABLE parties ADD COLUMN _new_shop_id INT;
UPDATE parties p SET _new_shop_id = s._new_shop_id FROM shops s WHERE p.shop_id = s.shop_id;

-- invoices FKs
ALTER TABLE invoices ADD COLUMN _new_shop_id INT;
UPDATE invoices i SET _new_shop_id = s._new_shop_id FROM shops s WHERE i.shop_id = s.shop_id;
ALTER TABLE invoices ADD COLUMN _new_party_id INT;
UPDATE invoices i SET _new_party_id = p._new_party_id FROM parties p WHERE i.party_id = p.party_id;
ALTER TABLE invoices ADD COLUMN _new_marketplace_order_id INT;
UPDATE invoices i SET _new_marketplace_order_id = mo._new_order_id FROM marketplace_orders mo WHERE i.marketplace_order_id = mo.order_id;

-- movements FKs
ALTER TABLE movements ADD COLUMN _new_shop_id INT;
UPDATE movements m SET _new_shop_id = s._new_shop_id FROM shops s WHERE m.shop_id = s.shop_id;
ALTER TABLE movements ADD COLUMN _new_inventory_id INT;
UPDATE movements m SET _new_inventory_id = si._new_inventory_id FROM shop_inventory si WHERE m.inventory_id = si.inventory_id;
ALTER TABLE movements ADD COLUMN _new_invoice_id INT;
UPDATE movements m SET _new_invoice_id = i._new_invoice_id FROM invoices i WHERE m.invoice_id = i.invoice_id;
ALTER TABLE movements ADD COLUMN _new_party_id INT;
UPDATE movements m SET _new_party_id = p._new_party_id FROM parties p WHERE m.party_id = p.party_id;

-- party_ledger FKs
ALTER TABLE party_ledger ADD COLUMN _new_shop_id INT;
UPDATE party_ledger pl SET _new_shop_id = s._new_shop_id FROM shops s WHERE pl.shop_id = s.shop_id;
ALTER TABLE party_ledger ADD COLUMN _new_party_id INT;
UPDATE party_ledger pl SET _new_party_id = p._new_party_id FROM parties p WHERE pl.party_id = p.party_id;
ALTER TABLE party_ledger ADD COLUMN _new_invoice_id INT;
UPDATE party_ledger pl SET _new_invoice_id = i._new_invoice_id FROM invoices i WHERE pl.invoice_id = i.invoice_id;

-- invoice_items FKs
ALTER TABLE invoice_items ADD COLUMN _new_invoice_id INT;
UPDATE invoice_items ii SET _new_invoice_id = i._new_invoice_id FROM invoices i WHERE ii.invoice_id = i.invoice_id;
ALTER TABLE invoice_items ADD COLUMN _new_inventory_id INT;
UPDATE invoice_items ii SET _new_inventory_id = si._new_inventory_id FROM shop_inventory si WHERE ii.inventory_id = si.inventory_id;

-- invoice_payments FK
ALTER TABLE invoice_payments ADD COLUMN _new_invoice_id INT;
UPDATE invoice_payments ip SET _new_invoice_id = i._new_invoice_id FROM invoices i WHERE ip.invoice_id = i.invoice_id;

-- purchase_orders FKs
ALTER TABLE purchase_orders ADD COLUMN _new_shop_id INT;
UPDATE purchase_orders po SET _new_shop_id = s._new_shop_id FROM shops s WHERE po.shop_id = s.shop_id;
ALTER TABLE purchase_orders ADD COLUMN _new_party_id INT;
UPDATE purchase_orders po SET _new_party_id = p._new_party_id FROM parties p WHERE po.party_id = p.party_id;

-- purchase_order_items FKs
ALTER TABLE purchase_order_items ADD COLUMN _new_po_id INT;
UPDATE purchase_order_items poi SET _new_po_id = po._new_po_id FROM purchase_orders po WHERE poi.po_id = po.po_id;
ALTER TABLE purchase_order_items ADD COLUMN _new_inventory_id INT;
UPDATE purchase_order_items poi SET _new_inventory_id = si._new_inventory_id FROM shop_inventory si WHERE poi.inventory_id = si.inventory_id;

-- job_cards FK
ALTER TABLE job_cards ADD COLUMN _new_shop_id INT;
UPDATE job_cards jc SET _new_shop_id = s._new_shop_id FROM shops s WHERE jc.shop_id = s.shop_id;

-- job_card_items FKs
ALTER TABLE job_card_items ADD COLUMN _new_job_id INT;
UPDATE job_card_items jci SET _new_job_id = jc._new_job_id FROM job_cards jc WHERE jci.job_id = jc.job_id;
ALTER TABLE job_card_items ADD COLUMN _new_inventory_id INT;
UPDATE job_card_items jci SET _new_inventory_id = si._new_inventory_id FROM shop_inventory si WHERE jci.inventory_id = si.inventory_id;

-- marketplace_orders FKs
ALTER TABLE marketplace_orders ADD COLUMN _new_shop_id INT;
UPDATE marketplace_orders mo SET _new_shop_id = s._new_shop_id FROM shops s WHERE mo.shop_id = s.shop_id;
ALTER TABLE marketplace_orders ADD COLUMN _new_customer_vehicle_id INT;
UPDATE marketplace_orders mo SET _new_customer_vehicle_id = cv._new_id FROM customer_vehicles cv WHERE mo.customer_vehicle_id = cv.id;
ALTER TABLE marketplace_orders ADD COLUMN _new_delivery_address_id INT;
UPDATE marketplace_orders mo SET _new_delivery_address_id = ca._new_address_id FROM customer_addresses ca WHERE mo.delivery_address_id = ca.address_id;

-- marketplace_order_items FKs
ALTER TABLE marketplace_order_items ADD COLUMN _new_order_id INT;
UPDATE marketplace_order_items moi SET _new_order_id = mo._new_order_id FROM marketplace_orders mo WHERE moi.order_id = mo.order_id;
ALTER TABLE marketplace_order_items ADD COLUMN _new_inventory_id INT;
UPDATE marketplace_order_items moi SET _new_inventory_id = si._new_inventory_id FROM shop_inventory si WHERE moi.inventory_id = si.inventory_id;

-- marketplace_reviews FKs
ALTER TABLE marketplace_reviews ADD COLUMN _new_master_part_id INT;
UPDATE marketplace_reviews mr SET _new_master_part_id = mp._new_master_part_id FROM master_parts mp WHERE mr.master_part_id = mp.master_part_id;
ALTER TABLE marketplace_reviews ADD COLUMN _new_inventory_id INT;
UPDATE marketplace_reviews mr SET _new_inventory_id = si._new_inventory_id FROM shop_inventory si WHERE mr.inventory_id = si.inventory_id;
ALTER TABLE marketplace_reviews ADD COLUMN _new_order_id INT;
UPDATE marketplace_reviews mr SET _new_order_id = mo._new_order_id FROM marketplace_orders mo WHERE mr.order_id = mo.order_id;


-- ════════════════════════════════════════════════════════════
-- PHASE 3 — Drop all FK constraints dynamically,
--            then swap old UUID columns for new INT columns
-- ════════════════════════════════════════════════════════════

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
CREATE SEQUENCE shops_shop_id_seq;
SELECT setval('shops_shop_id_seq', (SELECT COALESCE(MAX(shop_id), 0) FROM shops));
ALTER TABLE shops ALTER COLUMN shop_id SET DEFAULT nextval('shops_shop_id_seq');

-- ─── vehicles ────────────────────────────────────────────
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_pkey;
ALTER TABLE vehicles DROP COLUMN vehicle_id;
ALTER TABLE vehicles RENAME COLUMN _new_vehicle_id TO vehicle_id;
ALTER TABLE vehicles ADD PRIMARY KEY (vehicle_id);
CREATE SEQUENCE vehicles_vehicle_id_seq;
SELECT setval('vehicles_vehicle_id_seq', (SELECT COALESCE(MAX(vehicle_id), 0) FROM vehicles));
ALTER TABLE vehicles ALTER COLUMN vehicle_id SET DEFAULT nextval('vehicles_vehicle_id_seq');

-- ─── master_parts ─────────────────────────────────────────
ALTER TABLE master_parts DROP CONSTRAINT IF EXISTS master_parts_pkey;
ALTER TABLE master_parts DROP COLUMN master_part_id;
ALTER TABLE master_parts RENAME COLUMN _new_master_part_id TO master_part_id;
ALTER TABLE master_parts DROP COLUMN contributed_by_shop_id;
ALTER TABLE master_parts RENAME COLUMN _new_contributed_by_shop_id TO contributed_by_shop_id;
ALTER TABLE master_parts ADD PRIMARY KEY (master_part_id);
CREATE SEQUENCE master_parts_master_part_id_seq;
SELECT setval('master_parts_master_part_id_seq', (SELECT COALESCE(MAX(master_part_id), 0) FROM master_parts));
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
CREATE SEQUENCE shop_inventory_inventory_id_seq;
SELECT setval('shop_inventory_inventory_id_seq', (SELECT COALESCE(MAX(inventory_id), 0) FROM shop_inventory));
ALTER TABLE shop_inventory ALTER COLUMN inventory_id SET DEFAULT nextval('shop_inventory_inventory_id_seq');

-- ─── parties ──────────────────────────────────────────────
ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_pkey;
ALTER TABLE parties DROP COLUMN party_id;
ALTER TABLE parties RENAME COLUMN _new_party_id TO party_id;
ALTER TABLE parties DROP COLUMN shop_id;
ALTER TABLE parties RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE parties ADD PRIMARY KEY (party_id);
CREATE SEQUENCE parties_party_id_seq;
SELECT setval('parties_party_id_seq', (SELECT COALESCE(MAX(party_id), 0) FROM parties));
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
CREATE SEQUENCE invoices_invoice_id_seq;
SELECT setval('invoices_invoice_id_seq', (SELECT COALESCE(MAX(invoice_id), 0) FROM invoices));
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
CREATE SEQUENCE part_fitments_fitment_id_seq;
SELECT setval('part_fitments_fitment_id_seq', (SELECT COALESCE(MAX(fitment_id), 0) FROM part_fitments));
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
CREATE SEQUENCE movements_movement_id_seq;
SELECT setval('movements_movement_id_seq', (SELECT COALESCE(MAX(movement_id), 0) FROM movements));
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
CREATE SEQUENCE party_ledger_ledger_id_seq;
SELECT setval('party_ledger_ledger_id_seq', (SELECT COALESCE(MAX(ledger_id), 0) FROM party_ledger));
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
CREATE SEQUENCE invoice_items_item_id_seq;
SELECT setval('invoice_items_item_id_seq', (SELECT COALESCE(MAX(item_id), 0) FROM invoice_items));
ALTER TABLE invoice_items ALTER COLUMN item_id SET DEFAULT nextval('invoice_items_item_id_seq');

-- ─── invoice_payments ─────────────────────────────────────
ALTER TABLE invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_pkey;
ALTER TABLE invoice_payments DROP COLUMN id;
ALTER TABLE invoice_payments RENAME COLUMN _new_id TO id;
ALTER TABLE invoice_payments DROP COLUMN invoice_id;
ALTER TABLE invoice_payments RENAME COLUMN _new_invoice_id TO invoice_id;
ALTER TABLE invoice_payments ADD PRIMARY KEY (id);
CREATE SEQUENCE invoice_payments_id_seq;
SELECT setval('invoice_payments_id_seq', (SELECT COALESCE(MAX(id), 0) FROM invoice_payments));
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
CREATE SEQUENCE purchase_orders_po_id_seq;
SELECT setval('purchase_orders_po_id_seq', (SELECT COALESCE(MAX(po_id), 0) FROM purchase_orders));
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
CREATE SEQUENCE purchase_order_items_item_id_seq;
SELECT setval('purchase_order_items_item_id_seq', (SELECT COALESCE(MAX(item_id), 0) FROM purchase_order_items));
ALTER TABLE purchase_order_items ALTER COLUMN item_id SET DEFAULT nextval('purchase_order_items_item_id_seq');

-- ─── job_cards ────────────────────────────────────────────
ALTER TABLE job_cards DROP CONSTRAINT IF EXISTS job_cards_pkey;
ALTER TABLE job_cards DROP COLUMN job_id;
ALTER TABLE job_cards RENAME COLUMN _new_job_id TO job_id;
ALTER TABLE job_cards DROP COLUMN shop_id;
ALTER TABLE job_cards RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE job_cards ADD PRIMARY KEY (job_id);
CREATE SEQUENCE job_cards_job_id_seq;
SELECT setval('job_cards_job_id_seq', (SELECT COALESCE(MAX(job_id), 0) FROM job_cards));
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
CREATE SEQUENCE job_card_items_id_seq;
SELECT setval('job_card_items_id_seq', (SELECT COALESCE(MAX(id), 0) FROM job_card_items));
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
CREATE SEQUENCE marketplace_orders_order_id_seq;
SELECT setval('marketplace_orders_order_id_seq', (SELECT COALESCE(MAX(order_id), 0) FROM marketplace_orders));
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
CREATE SEQUENCE marketplace_order_items_item_id_seq;
SELECT setval('marketplace_order_items_item_id_seq', (SELECT COALESCE(MAX(item_id), 0) FROM marketplace_order_items));
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
CREATE SEQUENCE marketplace_reviews_review_id_seq;
SELECT setval('marketplace_reviews_review_id_seq', (SELECT COALESCE(MAX(review_id), 0) FROM marketplace_reviews));
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
CREATE SEQUENCE confirm_fit_requests_id_seq;
SELECT setval('confirm_fit_requests_id_seq', (SELECT COALESCE(MAX(id), 0) FROM confirm_fit_requests));
ALTER TABLE confirm_fit_requests ALTER COLUMN id SET DEFAULT nextval('confirm_fit_requests_id_seq');

-- ─── auth_providers ───────────────────────────────────────
ALTER TABLE auth_providers DROP CONSTRAINT IF EXISTS auth_providers_pkey;
ALTER TABLE auth_providers DROP COLUMN id;
ALTER TABLE auth_providers RENAME COLUMN _new_id TO id;
ALTER TABLE auth_providers ADD PRIMARY KEY (id);
CREATE SEQUENCE auth_providers_id_seq;
SELECT setval('auth_providers_id_seq', (SELECT COALESCE(MAX(id), 0) FROM auth_providers));
ALTER TABLE auth_providers ALTER COLUMN id SET DEFAULT nextval('auth_providers_id_seq');

-- ─── otp_codes ────────────────────────────────────────────
ALTER TABLE otp_codes DROP CONSTRAINT IF EXISTS otp_codes_pkey;
ALTER TABLE otp_codes DROP COLUMN id;
ALTER TABLE otp_codes RENAME COLUMN _new_id TO id;
ALTER TABLE otp_codes ADD PRIMARY KEY (id);
CREATE SEQUENCE otp_codes_id_seq;
SELECT setval('otp_codes_id_seq', (SELECT COALESCE(MAX(id), 0) FROM otp_codes));
ALTER TABLE otp_codes ALTER COLUMN id SET DEFAULT nextval('otp_codes_id_seq');

-- ─── refresh_tokens ───────────────────────────────────────
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_pkey;
ALTER TABLE refresh_tokens DROP COLUMN id;
ALTER TABLE refresh_tokens RENAME COLUMN _new_id TO id;
ALTER TABLE refresh_tokens DROP COLUMN shop_id;
ALTER TABLE refresh_tokens RENAME COLUMN _new_shop_id TO shop_id;
ALTER TABLE refresh_tokens ADD PRIMARY KEY (id);
CREATE SEQUENCE refresh_tokens_id_seq;
SELECT setval('refresh_tokens_id_seq', (SELECT COALESCE(MAX(id), 0) FROM refresh_tokens));
ALTER TABLE refresh_tokens ALTER COLUMN id SET DEFAULT nextval('refresh_tokens_id_seq');

-- ─── password_reset_tokens ────────────────────────────────
ALTER TABLE password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_pkey;
ALTER TABLE password_reset_tokens DROP COLUMN id;
ALTER TABLE password_reset_tokens RENAME COLUMN _new_id TO id;
ALTER TABLE password_reset_tokens ADD PRIMARY KEY (id);
CREATE SEQUENCE password_reset_tokens_id_seq;
SELECT setval('password_reset_tokens_id_seq', (SELECT COALESCE(MAX(id), 0) FROM password_reset_tokens));
ALTER TABLE password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('password_reset_tokens_id_seq');

-- ─── user_profiles ────────────────────────────────────────
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_pkey;
ALTER TABLE user_profiles DROP COLUMN id;
ALTER TABLE user_profiles RENAME COLUMN _new_id TO id;
ALTER TABLE user_profiles ADD PRIMARY KEY (id);
CREATE SEQUENCE user_profiles_id_seq;
SELECT setval('user_profiles_id_seq', (SELECT COALESCE(MAX(id), 0) FROM user_profiles));
ALTER TABLE user_profiles ALTER COLUMN id SET DEFAULT nextval('user_profiles_id_seq');

-- ─── user_settings ────────────────────────────────────────
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_pkey;
ALTER TABLE user_settings DROP COLUMN id;
ALTER TABLE user_settings RENAME COLUMN _new_id TO id;
ALTER TABLE user_settings ADD PRIMARY KEY (id);
CREATE SEQUENCE user_settings_id_seq;
SELECT setval('user_settings_id_seq', (SELECT COALESCE(MAX(id), 0) FROM user_settings));
ALTER TABLE user_settings ALTER COLUMN id SET DEFAULT nextval('user_settings_id_seq');

-- ─── customer_profiles ────────────────────────────────────
ALTER TABLE customer_profiles DROP CONSTRAINT IF EXISTS customer_profiles_pkey;
ALTER TABLE customer_profiles DROP COLUMN id;
ALTER TABLE customer_profiles RENAME COLUMN _new_id TO id;
ALTER TABLE customer_profiles ADD PRIMARY KEY (id);
CREATE SEQUENCE customer_profiles_id_seq;
SELECT setval('customer_profiles_id_seq', (SELECT COALESCE(MAX(id), 0) FROM customer_profiles));
ALTER TABLE customer_profiles ALTER COLUMN id SET DEFAULT nextval('customer_profiles_id_seq');

-- ─── customer_addresses ───────────────────────────────────
ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_pkey;
ALTER TABLE customer_addresses DROP COLUMN address_id;
ALTER TABLE customer_addresses RENAME COLUMN _new_address_id TO address_id;
ALTER TABLE customer_addresses ADD PRIMARY KEY (address_id);
CREATE SEQUENCE customer_addresses_address_id_seq;
SELECT setval('customer_addresses_address_id_seq', (SELECT COALESCE(MAX(address_id), 0) FROM customer_addresses));
ALTER TABLE customer_addresses ALTER COLUMN address_id SET DEFAULT nextval('customer_addresses_address_id_seq');

-- ─── customer_vehicles ────────────────────────────────────
ALTER TABLE customer_vehicles DROP CONSTRAINT IF EXISTS customer_vehicles_pkey;
ALTER TABLE customer_vehicles DROP COLUMN id;
ALTER TABLE customer_vehicles RENAME COLUMN _new_id TO id;
ALTER TABLE customer_vehicles DROP COLUMN vehicle_id;
ALTER TABLE customer_vehicles RENAME COLUMN _new_vehicle_id TO vehicle_id;
ALTER TABLE customer_vehicles ADD PRIMARY KEY (id);
CREATE SEQUENCE customer_vehicles_id_seq;
SELECT setval('customer_vehicles_id_seq', (SELECT COALESCE(MAX(id), 0) FROM customer_vehicles));
ALTER TABLE customer_vehicles ALTER COLUMN id SET DEFAULT nextval('customer_vehicles_id_seq');

-- ─── admin_profiles ───────────────────────────────────────
ALTER TABLE admin_profiles DROP CONSTRAINT IF EXISTS admin_profiles_pkey;
ALTER TABLE admin_profiles DROP COLUMN id;
ALTER TABLE admin_profiles RENAME COLUMN _new_id TO id;
ALTER TABLE admin_profiles ADD PRIMARY KEY (id);
CREATE SEQUENCE admin_profiles_id_seq;
SELECT setval('admin_profiles_id_seq', (SELECT COALESCE(MAX(id), 0) FROM admin_profiles));
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
CREATE SEQUENCE shop_users_id_seq;
SELECT setval('shop_users_id_seq', (SELECT COALESCE(MAX(id), 0) FROM shop_users));
ALTER TABLE shop_users ALTER COLUMN id SET DEFAULT nextval('shop_users_id_seq');

-- ─── users (FK only — user_id is already INT autoincrement) ──
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

-- Re-enable FK enforcement
SET session_replication_role = DEFAULT;

COMMIT;
