/**
 * Fix the 4 tables that failed: shop_users, master_parts, part_fitments, shop_inventory
 * Also handles vehicle_types (pk = vehicle_type_id)
 */
const { Client } = require('pg');

const DIRECT_URL =
  'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

const TABLES = [
  { name: 'vehicle_types',  pk: 'vehicle_type_id' },
  { name: 'shop_users',     pk: 'id' },
  { name: 'master_parts',   pk: 'master_part_id' },
  { name: 'part_fitments',  pk: 'fitment_id' },
  { name: 'shop_inventory', pk: 'inventory_id' },
];

const TRANSFORMS = {
  master_parts: {
    oem_numbers: `(oem_numbers[1])::text`,
    barcodes:    `(barcodes[1])::text`,
    images:      `(images[1])::text`,
  },
};

async function getColumns(client, tableName) {
  const { rows } = await client.query(`
    SELECT column_name, is_nullable, column_default, ordinal_position
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `, [tableName]);
  return rows;
}

// Use string_agg instead of array_agg to avoid JS type issues
async function getUniqueConstraints(client, tableName) {
  const { rows } = await client.query(`
    SELECT tc.constraint_name,
           string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = $1 AND tc.table_schema = 'public'
      AND tc.constraint_type = 'UNIQUE'
    GROUP BY tc.constraint_name
  `, [tableName]);
  // columns comes back as a comma-separated string
  return rows.map(r => ({ ...r, columns: r.columns ? r.columns.split(',') : [] }));
}

async function getSequences(client, tableName) {
  const { rows } = await client.query(`
    SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
      AND column_default LIKE 'nextval%'
  `, [tableName]);
  return rows;
}

async function recreate(client, tableName, pkCol) {
  const cols = await getColumns(client, tableName);
  const uniques = await getUniqueConstraints(client, tableName);
  const seqCols = await getSequences(client, tableName);

  const pkDef = cols.find(c => c.column_name === pkCol);
  if (!pkDef) {
    console.log(`  ⚠  ${tableName}.${pkCol} not found`);
    return;
  }

  if (cols[0].column_name === pkCol) {
    console.log(`  ✓  ${tableName} — already first, skipping`);
    return;
  }

  const ordered = [pkDef, ...cols.filter(c => c.column_name !== pkCol)];
  const transforms = TRANSFORMS[tableName] || {};

  const selectCols = ordered.map(col => {
    const expr = transforms[col.column_name];
    return expr ? `${expr} AS "${col.column_name}"` : `"${col.column_name}"`;
  }).join(', ');

  await client.query(`CREATE TABLE "${tableName}_reordered" AS SELECT ${selectCols} FROM "${tableName}"`);

  for (const col of ordered) {
    if (col.is_nullable === 'NO') {
      try {
        await client.query(`ALTER TABLE "${tableName}_reordered" ALTER COLUMN "${col.column_name}" SET NOT NULL`);
      } catch (_) {}
    }
  }

  for (const col of ordered) {
    if (col.column_default && !col.column_default.includes('nextval')) {
      try {
        await client.query(`ALTER TABLE "${tableName}_reordered" ALTER COLUMN "${col.column_name}" SET DEFAULT ${col.column_default}`);
      } catch (_) {}
    }
  }

  await client.query(`DROP TABLE "${tableName}"`);
  await client.query(`ALTER TABLE "${tableName}_reordered" RENAME TO "${tableName}"`);
  await client.query(`ALTER TABLE "${tableName}" ADD PRIMARY KEY ("${pkCol}")`);

  for (const sc of seqCols) {
    try {
      await client.query(`ALTER TABLE "${tableName}" ALTER COLUMN "${sc.column_name}" SET DEFAULT ${sc.column_default}`);
    } catch (_) {}
  }

  for (const u of uniques) {
    const colList = u.columns.map(c => `"${c}"`).join(', ');
    try {
      await client.query(`ALTER TABLE "${tableName}" ADD CONSTRAINT "${u.constraint_name}" UNIQUE (${colList})`);
    } catch (_) {}
  }

  console.log(`  ✓  ${tableName} — PK moved to position 1`);
}

const FK_SQL = `
ALTER TABLE users ADD CONSTRAINT users_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE auth_providers ADD CONSTRAINT auth_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE user_settings ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE customer_profiles ADD CONSTRAINT customer_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE customer_vehicles ADD CONSTRAINT customer_vehicles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE customer_vehicles ADD CONSTRAINT customer_vehicles_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id);
ALTER TABLE admin_profiles ADD CONSTRAINT admin_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE shop_users ADD CONSTRAINT shop_users_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE;
ALTER TABLE shop_users ADD CONSTRAINT shop_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_vehicle_type_id_fkey FOREIGN KEY (vehicle_type_id) REFERENCES vehicle_types(vehicle_type_id);
ALTER TABLE part_fitments ADD CONSTRAINT part_fitments_master_part_id_fkey FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id) ON DELETE CASCADE;
ALTER TABLE part_fitments ADD CONSTRAINT part_fitments_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id) ON DELETE CASCADE;
ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id);
ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_master_part_id_fkey FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id);
ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id);
ALTER TABLE confirm_fit_requests ADD CONSTRAINT confirm_fit_requests_fitment_id_fkey FOREIGN KEY (fitment_id) REFERENCES part_fitments(fitment_id);
ALTER TABLE shop_inventory ADD CONSTRAINT shop_inventory_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE shop_inventory ADD CONSTRAINT shop_inventory_master_part_id_fkey FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id);
ALTER TABLE parties ADD CONSTRAINT parties_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE invoices ADD CONSTRAINT invoices_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE invoices ADD CONSTRAINT invoices_party_id_fkey FOREIGN KEY (party_id) REFERENCES parties(party_id);
ALTER TABLE movements ADD CONSTRAINT movements_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE movements ADD CONSTRAINT movements_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);
ALTER TABLE movements ADD CONSTRAINT movements_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id);
ALTER TABLE movements ADD CONSTRAINT movements_party_id_fkey FOREIGN KEY (party_id) REFERENCES parties(party_id);
ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_party_id_fkey FOREIGN KEY (party_id) REFERENCES parties(party_id);
ALTER TABLE party_ledger ADD CONSTRAINT party_ledger_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id);
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_party_id_fkey FOREIGN KEY (party_id) REFERENCES parties(party_id);
ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE;
ALTER TABLE purchase_order_items ADD CONSTRAINT purchase_order_items_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);
ALTER TABLE job_cards ADD CONSTRAINT job_cards_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE job_card_items ADD CONSTRAINT job_card_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES job_cards(job_id) ON DELETE CASCADE;
ALTER TABLE job_card_items ADD CONSTRAINT job_card_items_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES shops(shop_id);
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_customer_vehicle_id_fkey FOREIGN KEY (customer_vehicle_id) REFERENCES customer_vehicles(id);
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_delivery_address_id_fkey FOREIGN KEY (delivery_address_id) REFERENCES customer_addresses(address_id);
ALTER TABLE marketplace_order_items ADD CONSTRAINT marketplace_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES marketplace_orders(order_id) ON DELETE CASCADE;
ALTER TABLE marketplace_order_items ADD CONSTRAINT marketplace_order_items_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);
ALTER TABLE marketplace_reviews ADD CONSTRAINT marketplace_reviews_master_part_id_fkey FOREIGN KEY (master_part_id) REFERENCES master_parts(master_part_id);
ALTER TABLE marketplace_reviews ADD CONSTRAINT marketplace_reviews_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES shop_inventory(inventory_id);
ALTER TABLE marketplace_reviews ADD CONSTRAINT marketplace_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(user_id);
`;

async function main() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  console.log('Connected.\n');

  // Drop remaining FK constraints
  await client.query(`
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
  `);

  await client.query("SET session_replication_role = replica");

  for (const { name, pk } of TABLES) {
    try {
      await recreate(client, name, pk);
    } catch (err) {
      console.error(`  ✗  ${name}: ${err.message}`);
    }
  }

  await client.query("SET session_replication_role = DEFAULT");

  console.log('\nRe-adding FK constraints...');
  for (const stmt of FK_SQL.trim().split('\n').filter(s => s.trim())) {
    try {
      await client.query(stmt);
    } catch (err) {
      // Skip already-existing constraints from previous run
      if (!err.message.includes('already exists')) {
        console.warn(`  ⚠  ${err.message.slice(0, 100)}`);
      }
    }
  }

  await client.end();
  console.log('\n✅ Done — all remaining tables fixed.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
