/**
 * serializable-tx.js — SERIALIZABLE transaction wrapper with one retry.
 *
 * Reserved for low-frequency, financially-sensitive writes (returns, credit notes)
 * where two concurrent requests reading the same "quantity already returned" total
 * must never both succeed and overshoot the original sale quantity. Ordinary
 * high-frequency writes (billing, stock decrement) stay on the default READ
 * COMMITTED + `updateMany`-with-guard pattern — Serializable adds retry overhead
 * that isn't worth paying on every POS sale.
 */
import prisma from '../db/prisma.js';

const TX_OPTS = { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 };

export async function runSerializable(fn) {
  try {
    return await prisma.$transaction(fn, TX_OPTS);
  } catch (err) {
    // P2034 = Prisma's mapping of a Postgres serialization failure (40001) — safe to retry once.
    if (err.code === 'P2034') {
      return await prisma.$transaction(fn, TX_OPTS);
    }
    throw err;
  }
}
