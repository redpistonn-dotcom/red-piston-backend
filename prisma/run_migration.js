// Runs migrate_uuid_to_int.sql in small chunks to avoid deadlocks on Supabase.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DIRECT_URL = process.env.DIRECT_URL ||
  'postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, 'migrate_uuid_to_int.sql'), 'utf8');

  // Remove the outer BEGIN/COMMIT so we can control transactions manually
  const stripped = sql
    .replace(/^\s*BEGIN\s*;/im, '')
    .replace(/^\s*COMMIT\s*;/im, '');

  // Split on blank lines between logical sections (the ═══ comments)
  // We'll run each phase as its own transaction
  const phases = stripped.split(/(?=-- ════)/g).filter(s => s.trim());

  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  console.log('Connected to database.');

  // Set a short lock timeout to fail fast instead of deadlocking
  await client.query("SET lock_timeout = '15s'");
  await client.query("SET deadlock_timeout = '2s'");

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i].trim();
    if (!phase) continue;

    const title = phase.split('\n')[0].replace(/^-- /, '').trim();
    console.log(`\nRunning: ${title}`);

    let retries = 3;
    while (retries > 0) {
      try {
        await client.query('BEGIN');
        await client.query("SET session_replication_role = replica");
        await client.query(phase);
        await client.query('COMMIT');
        console.log(`  ✓ Done`);
        break;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        retries--;
        if (retries === 0) {
          console.error(`  ✗ Failed after 3 attempts: ${err.message}`);
          await client.end();
          process.exit(1);
        }
        console.warn(`  ⚠ Retrying (${retries} left): ${err.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Re-enable FK enforcement
  await client.query("SET session_replication_role = DEFAULT");
  await client.end();
  console.log('\n✅ Migration complete. All IDs are now integers.');
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
