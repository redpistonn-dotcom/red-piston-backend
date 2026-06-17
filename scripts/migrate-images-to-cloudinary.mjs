/**
 * migrate-images-to-cloudinary.mjs
 *
 * Downloads every autodukan product image from the S3 bucket (server-side,
 * so no CORS/403 issues) and re-uploads it to Cloudinary, then updates
 * image_url in autodukan_parts_staging to the permanent Cloudinary URL.
 *
 * Safe to re-run: already-migrated rows (image_url doesn't contain
 * "autodukan.s3") are skipped automatically.
 *
 * Usage:
 *   node scripts/migrate-images-to-cloudinary.mjs
 *
 * Required env vars (add to .env):
 *   DATABASE_URL          — Supabase PostgreSQL connection string
 *   CLOUDINARY_CLOUD_NAME — your Cloudinary cloud name
 *   CLOUDINARY_API_KEY    — Cloudinary API key
 *   CLOUDINARY_API_SECRET — Cloudinary API secret
 */

import { config } from 'dotenv';
config({ override: true });

import { v2 as cloudinary } from 'cloudinary';
import pg from 'pg';

// ── Config ───────────────────────────────────────────────────────────────────

const DATABASE_URL        = process.env.DATABASE_URL;
const CLOUDINARY_CLOUD    = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY  = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const BATCH_SIZE   = 20;   // rows fetched per DB query
const DELAY_MS     = 500;  // ms between uploads (be polite to Cloudinary)
const S3_ORIGIN    = 'autodukan.s3.ap-south-1.amazonaws.com';
const CLOUDINARY_FOLDER = 'autodukan-parts';

// ── Validate env ─────────────────────────────────────────────────────────────

const missing = [];
if (!DATABASE_URL)          missing.push('DATABASE_URL');
if (!CLOUDINARY_CLOUD)      missing.push('CLOUDINARY_CLOUD_NAME');
if (!CLOUDINARY_API_KEY)    missing.push('CLOUDINARY_API_KEY');
if (!CLOUDINARY_API_SECRET) missing.push('CLOUDINARY_API_SECRET');
if (missing.length) {
  console.error('Missing env vars:', missing.join(', '));
  console.error('Add them to your .env file and retry.');
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD,
  api_key:    CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure:     true,
});

// ── DB helpers ────────────────────────────────────────────────────────────────

function makePool() {
  // Strip pgbouncer param that breaks pg directly
  const url = DATABASE_URL
    .replace(/([?&])pgbouncer=true/i, '$1')
    .replace(/[?&]$/, '');
  return new pg.Pool({ connectionString: url });
}

async function countPending(pool) {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS n
    FROM autodukan_parts_staging
    WHERE image_url LIKE '%${S3_ORIGIN}%'
      AND source = 'autodukan'
  `);
  return rows[0].n;
}

async function fetchBatch(pool, offset) {
  const { rows } = await pool.query(`
    SELECT id, image_url
    FROM autodukan_parts_staging
    WHERE image_url LIKE '%${S3_ORIGIN}%'
      AND source = 'autodukan'
    ORDER BY id
    LIMIT $1 OFFSET $2
  `, [BATCH_SIZE, offset]);
  return rows;
}

async function updateUrl(pool, id, newUrl) {
  await pool.query(
    'UPDATE autodukan_parts_staging SET image_url = $1 WHERE id = $2',
    [newUrl, id]
  );
}

// ── Image helpers ─────────────────────────────────────────────────────────────

async function downloadImage(url) {
  const res = await fetch(encodeURI(url), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RedPiston/1.0)',
      'Referer':    'https://autodukan.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function uploadToCloudinary(buffer, partId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder:         CLOUDINARY_FOLDER,
        public_id:      `part_${partId}`,
        overwrite:      true,
        resource_type:  'image',
        format:         'webp',          // convert to webp for smaller size
        transformation: [{ width: 400, height: 400, crop: 'limit' }],
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = makePool();

  const total = await countPending(pool);
  if (total === 0) {
    console.log('No S3 image URLs remaining. All already migrated to Cloudinary!');
    await pool.end();
    return;
  }

  console.log(`\nFound ${total} images to migrate to Cloudinary.`);
  console.log(`Folder: ${CLOUDINARY_FOLDER}  |  Batch size: ${BATCH_SIZE}\n`);

  let done = 0, failed = 0, offset = 0;

  // We always fetch from offset=0 because successful rows are updated in-place
  // and no longer match the WHERE clause, so the result set shrinks naturally.
  while (true) {
    const batch = await fetchBatch(pool, 0);
    if (batch.length === 0) break;

    for (const row of batch) {
      const short = row.image_url.split('/').slice(-2).join('/');
      process.stdout.write(`  [${done + failed + 1}/${total}] ${short} … `);

      try {
        const buffer   = await downloadImage(row.image_url);
        const newUrl   = await uploadToCloudinary(buffer, row.id);
        await updateUrl(pool, row.id, newUrl);
        console.log('✓');
        done++;
      } catch (err) {
        console.log(`✗  (${err.message})`);
        failed++;
        // Update to null so it doesn't block progress — can retry manually
        await updateUrl(pool, row.id, null);
      }

      await sleep(DELAY_MS);
    }
  }

  await pool.end();

  console.log('\n' + '═'.repeat(50));
  console.log(`  Done.  Migrated: ${done}  |  Failed (set to null): ${failed}`);
  console.log('═'.repeat(50));
  if (failed > 0) {
    console.log(`\n  Failed images have image_url = NULL in the DB.`);
    console.log(`  Re-run this script to retry them (it only processes S3 URLs).`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
