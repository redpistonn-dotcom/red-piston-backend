const { Client } = require('pg');
const DIRECT_URL = 'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function check() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();

  // Check shops column order and type
  const shopsCols = await client.query(`
    SELECT ordinal_position, column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'shops' AND table_schema = 'public'
    ORDER BY ordinal_position
  `);
  console.log('\nshops columns (in order):');
  shopsCols.rows.forEach(r => console.log(`  ${r.ordinal_position}. ${r.column_name} → ${r.data_type}`));

  // Check master_parts oem_numbers column
  const mpCols = await client.query(`
    SELECT ordinal_position, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'master_parts' AND table_schema = 'public'
    ORDER BY ordinal_position
  `);
  console.log('\nmaster_parts columns (in order):');
  mpCols.rows.forEach(r => console.log(`  ${r.ordinal_position}. ${r.column_name} → ${r.data_type}${r.udt_name === '_text' ? ' (array)' : ''}`));

  // Check actual shops data
  const shops = await client.query('SELECT shop_id, name FROM shops LIMIT 3');
  console.log('\nshops sample rows:');
  shops.rows.forEach(r => console.log(`  shop_id=${r.shop_id} (${typeof r.shop_id})  name=${r.name}`));

  await client.end();
}
check().catch(e => { console.error(e.message); process.exit(1); });
