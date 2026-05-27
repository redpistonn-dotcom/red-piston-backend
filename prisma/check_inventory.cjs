const { Client } = require('pg');
const DIRECT_URL = 'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function main() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();

  console.log('\n=== All users with their shopIds ===');
  const { rows: users } = await client.query(`
    SELECT u.user_id, u.shop_id, u.email, s.name AS shop_name
    FROM users u
    LEFT JOIN shops s ON s.shop_id = u.shop_id
    ORDER BY u.user_id
  `);
  users.forEach(r => console.log(`  user_id=${r.user_id}  shop_id=${r.shop_id ?? 'NULL'}  shop="${r.shop_name ?? 'none'}"  email=${r.email}`));

  console.log('\n=== shop_inventory rows with their shop names ===');
  const { rows: inv } = await client.query(`
    SELECT si.inventory_id, si.shop_id, s.name AS shop_name, si.master_part_id, si.stock_qty
    FROM shop_inventory si
    LEFT JOIN shops s ON s.shop_id = si.shop_id
    ORDER BY si.inventory_id
  `);
  inv.forEach(r => console.log(`  inv_id=${r.inventory_id}  shop_id=${r.shop_id}  shop="${r.shop_name}"  master_part=${r.master_part_id}  stock=${r.stock_qty}`));

  console.log('\n=== Shops with NO user assigned ===');
  const { rows: orphan } = await client.query(`
    SELECT s.shop_id, s.name FROM shops s
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.shop_id = s.shop_id)
  `);
  orphan.forEach(r => console.log(`  shop_id=${r.shop_id}  name=${r.name}`));

  await client.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
