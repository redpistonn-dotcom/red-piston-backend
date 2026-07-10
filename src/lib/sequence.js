/**
 * sequence.js — Atomic per-shop monthly sequence numbers
 *
 * WHY this approach:
 *   findFirst+parseInt+1  → RACE: two concurrent reads see the same "last" row
 *   COUNT+1               → RACE: same problem; count is read before the write
 *   INSERT ON CONFLICT DO UPDATE → ATOMIC: PostgreSQL holds a row-level lock
 *     on (shop_id, counter_key) from the moment the upsert is evaluated until
 *     the surrounding transaction commits.  A second concurrent request on the
 *     same key blocks until the first commits, then reads the new value.
 *     This serialises number generation without application-level locks.
 *
 * Usage (must be called inside a Prisma $transaction):
 *
 *   const seq = await nextSeq(tx, shopId, 'INV-202606');
 *   // → 1, 2, 3 … even under 100 concurrent requests
 */

/**
 * Atomically increment and return the next sequence value for a given
 * (shopId, counterKey) pair.  Must be called with a Prisma transaction
 * client (`tx`) so the counter change is part of the same atomic unit
 * as the row being numbered.
 *
 * @param {PrismaClient} tx          — Prisma transaction client
 * @param {number}       shopId      — shop whose counter to increment
 * @param {string}       counterKey  — namespaced key e.g. 'INV-202606'
 * @returns {Promise<number>}        — next sequential integer (1-based)
 */
export async function nextSeq(tx, shopId, counterKey) {
  const rows = await tx.$queryRaw`
    INSERT INTO number_counters (shop_id, counter_key, last_value, updated_at)
    VALUES (${shopId}, ${counterKey}, 1, now())
    ON CONFLICT (shop_id, counter_key)
    DO UPDATE SET
      last_value = number_counters.last_value + 1,
      updated_at = now()
    RETURNING last_value
  `;
  return Number(rows[0].last_value);
}

/**
 * Build the current YYYYMM string for use as a counter key suffix.
 * Separated so callers can also use it to format the human-readable number.
 *
 * @returns {string}  e.g. '202606'
 */
export function currentYYYYMM() {
  // Compute the year/month in IST. Production servers run in UTC, so around
  // midnight IST (and at month boundaries) getMonth()/getFullYear() would use
  // the UTC date and could bucket an invoice into the wrong month.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year  = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  return `${year}${month}`;
}
