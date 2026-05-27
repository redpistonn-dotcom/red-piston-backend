// Runs migrate_uuid_to_int.sql in small chunks to avoid deadlocks on Supabase.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DIRECT_URL =
  'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, 'migrate_uuid_to_int.sql'), 'utf8');

  // Remove the outer BEGIN/COMMIT so we can control transactions manually per phase
  const stripped = sql
    .replace(/^\s*BEGIN\s*;/im, '')
    .replace(/^\s*COMMIT\s*;/im, '');

  // Split on the phase separator comments
  const phases = stripped.split(/(?=-- ════)/g).filter(s => s.trim());

  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  console.log('Connected to database.');

  await client.query("SET lock_timeout = '15s'");
  await client.query("SET deadlock_timeout = '2s'");

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i].trim();
    if (!phase) continue;

    const title = phase.split('\n')[0].replace(/^-- /, '').trim();
    console.log(`\nRunning phase ${i + 1}/${phases.length}: ${title}`);

    let retries = 3;
    while (retries > 0) {
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(phase);
        await client.query('COMMIT');
        console.log(`  ✓ Done`);
        break;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        retries--;
        if (retries === 0) {
          console.error(`  ✗ Failed after 3 attempts:\n  ${err.message}`);
          await client.end();
          process.exit(1);
        }
        console.warn(`  ⚠ Deadlock/lock timeout, retrying (${retries} left)...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  await client.end();
  console.log('\n✅ Migration complete — all UUID IDs are now integers.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
