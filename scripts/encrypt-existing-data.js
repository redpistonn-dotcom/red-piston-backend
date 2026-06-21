/**
 * One-time migration script: encrypt PII fields in the database.
 *
 * Fields encrypted:
 *   - Party.phone
 *   - Party.gstin
 *   - Shop.bankAccountNumber
 *   - Shop.bankIfsc
 *   - Shop.panNumber
 *
 * Usage:
 *   # Dry run (no writes) — default
 *   DRY_RUN=true FIELD_ENCRYPTION_KEY=<secret> node scripts/encrypt-existing-data.js
 *
 *   # Live run
 *   DRY_RUN=false FIELD_ENCRYPTION_KEY=<secret> node scripts/encrypt-existing-data.js
 *
 * The script is idempotent: rows that are already encrypted are decrypted first
 * (the decrypt() function returns plaintext unchanged for non-encrypted values),
 * then re-encrypted with the current key. Safe to re-run.
 *
 * FIELD_ENCRYPTION_KEY must be set — the script will abort otherwise.
 */

import { PrismaClient } from "@prisma/client";
import { encrypt, decrypt } from "../src/lib/crypto.js";

const BATCH_SIZE = 100;
const DRY_RUN = process.env.DRY_RUN !== "false"; // default: dry run

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Guard: require the encryption key before touching any data
// ---------------------------------------------------------------------------
if (!process.env.FIELD_ENCRYPTION_KEY) {
  console.error(
    "[encrypt-existing-data] FATAL: FIELD_ENCRYPTION_KEY is not set. Aborting."
  );
  process.exit(1);
}

if (DRY_RUN) {
  console.log(
    "[encrypt-existing-data] DRY RUN mode — no writes will be performed."
  );
  console.log(
    "[encrypt-existing-data] Set DRY_RUN=false to apply changes.\n"
  );
} else {
  console.log(
    "[encrypt-existing-data] LIVE mode — rows WILL be updated in the database.\n"
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-encrypts a single value: decrypt first (handles plaintext + already-encrypted),
 * then encrypt. Returns null for null/empty inputs.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function reEncrypt(value) {
  if (value === null || value === undefined || value === "") return null;
  const plaintext = decrypt(value);
  return encrypt(plaintext);
}

/**
 * Returns true if a value is already encrypted (matches "ivHex:tagHex:ciphertextHex").
 * Used only for progress logging.
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (!value) return false;
  const parts = value.split(":");
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

/**
 * Process a table in batches of BATCH_SIZE.
 *
 * @param {object} opts
 * @param {string}   opts.label           - Human-readable table name for logs
 * @param {Function} opts.countFn         - async () => total row count
 * @param {Function} opts.fetchBatchFn    - async (skip: number) => row[]
 * @param {Function} opts.buildUpdateFn   - (row) => { where, data } for prisma update, or null to skip
 * @param {Function} opts.updateFn        - async (where, data) => void
 */
async function processBatches({
  label,
  countFn,
  fetchBatchFn,
  buildUpdateFn,
  updateFn,
}) {
  const total = await countFn();
  console.log(`[${label}] Total rows: ${total}`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let skip = 0;

  while (skip < total) {
    const rows = await fetchBatchFn(skip);
    if (rows.length === 0) break;

    for (const row of rows) {
      const update = buildUpdateFn(row);
      if (!update) {
        skipped++;
        continue;
      }

      if (!DRY_RUN) {
        await updateFn(update.where, update.data);
      }
      updated++;
    }

    processed += rows.length;
    skip += BATCH_SIZE;

    console.log(
      `[${label}] Processed ${Math.min(processed, total)}/${total} — updated: ${updated}, skipped (no change): ${skipped}`
    );
  }

  console.log(
    `[${label}] Done. Total updated: ${updated}, skipped: ${skipped}\n`
  );
}

// ---------------------------------------------------------------------------
// Party: phone, gstin
// ---------------------------------------------------------------------------
async function encryptPartyFields() {
  await processBatches({
    label: "Party",

    countFn: () => prisma.party.count(),

    fetchBatchFn: (skip) =>
      prisma.party.findMany({
        select: { partyId: true, phone: true, gstin: true },
        skip,
        take: BATCH_SIZE,
        orderBy: { partyId: "asc" },
      }),

    buildUpdateFn: (row) => {
      const newPhone = row.phone ? reEncrypt(row.phone) : null;
      const newGstin = row.gstin ? reEncrypt(row.gstin) : null;

      // Skip if neither field changed (both null, or already encrypted identically)
      // We always re-encrypt (produces new IV) so we only skip if both are null.
      const hasPhone = row.phone !== null && row.phone !== undefined;
      const hasGstin = row.gstin !== null && row.gstin !== undefined;

      if (!hasPhone && !hasGstin) return null;

      if (DRY_RUN) {
        // Log a sample of what would change
        if (hasPhone && !isEncrypted(row.phone)) {
          console.log(
            `  [DRY] Party #${row.partyId}: phone would be encrypted (currently plaintext)`
          );
        }
        if (hasGstin && !isEncrypted(row.gstin)) {
          console.log(
            `  [DRY] Party #${row.partyId}: gstin would be encrypted (currently plaintext)`
          );
        }
        return null; // dry run — no actual update object needed
      }

      const data = {};
      if (hasPhone) data.phone = newPhone;
      if (hasGstin) data.gstin = newGstin;

      return {
        where: { partyId: row.partyId },
        data,
      };
    },

    updateFn: (where, data) =>
      prisma.party.update({ where, data }),
  });
}

// ---------------------------------------------------------------------------
// Shop: bankAccountNumber, bankIfsc, panNumber
// ---------------------------------------------------------------------------
async function encryptShopFields() {
  await processBatches({
    label: "Shop",

    countFn: () => prisma.shop.count(),

    fetchBatchFn: (skip) =>
      prisma.shop.findMany({
        select: {
          shopId: true,
          bankAccountNumber: true,
          bankIfsc: true,
          panNumber: true,
        },
        skip,
        take: BATCH_SIZE,
        orderBy: { shopId: "asc" },
      }),

    buildUpdateFn: (row) => {
      const hasBank = row.bankAccountNumber !== null && row.bankAccountNumber !== undefined;
      const hasIfsc = row.bankIfsc !== null && row.bankIfsc !== undefined;
      const hasPan = row.panNumber !== null && row.panNumber !== undefined;

      if (!hasBank && !hasIfsc && !hasPan) return null;

      if (DRY_RUN) {
        if (hasBank && !isEncrypted(row.bankAccountNumber)) {
          console.log(
            `  [DRY] Shop #${row.shopId}: bankAccountNumber would be encrypted (currently plaintext)`
          );
        }
        if (hasIfsc && !isEncrypted(row.bankIfsc)) {
          console.log(
            `  [DRY] Shop #${row.shopId}: bankIfsc would be encrypted (currently plaintext)`
          );
        }
        if (hasPan && !isEncrypted(row.panNumber)) {
          console.log(
            `  [DRY] Shop #${row.shopId}: panNumber would be encrypted (currently plaintext)`
          );
        }
        return null;
      }

      const data = {};
      if (hasBank) data.bankAccountNumber = reEncrypt(row.bankAccountNumber);
      if (hasIfsc) data.bankIfsc = reEncrypt(row.bankIfsc);
      if (hasPan) data.panNumber = reEncrypt(row.panNumber);

      return {
        where: { shopId: row.shopId },
        data,
      };
    },

    updateFn: (where, data) =>
      prisma.shop.update({ where, data }),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Red Piston — PII Encryption Migration ===\n");

  const start = Date.now();

  await encryptPartyFields();
  await encryptShopFields();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`=== Migration complete in ${elapsed}s ===`);

  if (DRY_RUN) {
    console.log(
      "\nThis was a DRY RUN. Re-run with DRY_RUN=false to apply changes."
    );
  }
}

main()
  .catch((err) => {
    console.error("[encrypt-existing-data] Unexpected error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
