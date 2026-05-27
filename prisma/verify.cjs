const { Client } = require('pg');
const DIRECT_URL = 'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function verify() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();

  const tables = [
    ['master_parts',       'master_part_id'],
    ['shop_inventory',     'inventory_id'],
    ['shops',              'shop_id'],
    ['vehicles',           'vehicle_id'],
    ['movements',          'movement_id'],
    ['invoices',           'invoice_id'],
    ['parties',            'party_id'],
    ['marketplace_orders', 'order_id'],
  ];

  console.log('\nID column types after migration:\n');
  for (const [table, col] of tables) {
    const res = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`, [table, col]
    );
    const type = res.rows[0]?.data_type ?? 'NOT FOUND';
    const ok = type === 'integer' ? '✓' : '✗';
    console.log(`  ${ok}  ${table}.${col} → ${type}`);
  }

  // Show first 3 rows of master_parts
  const rows = await client.query('SELECT master_part_id, part_name FROM master_parts LIMIT 3');
  console.log('\nSample master_parts rows:');
  rows.rows.forEach(r => console.log(`  id=${r.master_part_id}  ${r.part_name}`));

  await client.end();
}

verify().catch(e => { console.error(e.message); process.exit(1); });
