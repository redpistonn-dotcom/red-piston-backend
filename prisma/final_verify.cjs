const { Client } = require('pg');
const DIRECT_URL = 'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();

  const checks = [
    ['shops',              'shop_id'],
    ['master_parts',       'master_part_id'],
    ['shop_inventory',     'inventory_id'],
    ['vehicles',           'vehicle_id'],
    ['movements',          'movement_id'],
    ['invoices',           'invoice_id'],
    ['parties',            'party_id'],
    ['marketplace_orders', 'order_id'],
    ['part_fitments',      'fitment_id'],
    ['shop_users',         'id'],
  ];

  console.log('\n=== Column position & type check ===\n');
  let allOk = true;
  for (const [table, pk] of checks) {
    const { rows } = await client.query(`
      SELECT ordinal_position, data_type
      FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2 AND table_schema = 'public'
    `, [table, pk]);
    const r = rows[0];
    const posOk = r && r.ordinal_position === 1;
    const typeOk = r && r.data_type === 'integer';
    const status = posOk && typeOk ? '✓' : '✗';
    if (!posOk || !typeOk) allOk = false;
    console.log(`  ${status}  ${table}.${pk}  position=${r?.ordinal_position ?? '?'}  type=${r?.data_type ?? '?'}`);
  }

  // Check oem_numbers is now text (not array)
  const { rows: oemRows } = await client.query(`
    SELECT data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'master_parts' AND column_name = 'oem_numbers' AND table_schema = 'public'
  `);
  const oemType = oemRows[0];
  const oemOk = oemType && oemType.data_type === 'text';
  console.log(`\n  ${oemOk ? '✓' : '✗'}  master_parts.oem_numbers type = ${oemType?.data_type ?? '?'} (wanted: text)`);

  // Sample master_parts rows
  const { rows: mp } = await client.query(`SELECT master_part_id, part_name, oem_numbers FROM master_parts LIMIT 3`);
  console.log('\nSample master_parts rows:');
  mp.forEach(r => console.log(`  id=${r.master_part_id}  oem=${r.oem_numbers ?? 'null'}  name=${r.part_name}`));

  // Sample shops rows
  const { rows: sh } = await client.query(`SELECT shop_id, name FROM shops LIMIT 3`);
  console.log('\nSample shops rows:');
  sh.forEach(r => console.log(`  shop_id=${r.shop_id}  name=${r.name}`));

  console.log(allOk && oemOk ? '\n✅ Everything looks correct.' : '\n⚠  Some checks failed — review above.');
  await client.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
