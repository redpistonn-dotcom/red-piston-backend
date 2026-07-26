import { Worker } from "bullmq";
import prisma from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";

function parseRedisUrl(redisUrl) {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    maxRetriesPerRequest: null,
    family: 4,
  };
  if (url.password) {
    connection.password = decodeURIComponent(url.password);
  }
  if (url.protocol === "rediss:") {
    connection.tls = { rejectUnauthorized: false };
  }
  return connection;
}

// Movement types and their stock sign:
//   PURCHASE, OPENING, RETURN_IN  â†’ positive (add to stock)
//   SALE, DAMAGE, THEFT, RETURN_OUT â†’ negative (subtract from stock)
//   ADJUSTMENT                   â†’ uses the raw qty value directly (can be negative)
async function processReconcileJob(job) {
  logger.info({ jobId: job.id }, "[ReconcileWorker] Starting stock reconciliation");

  // Pull every shopInventory row with a non-null inventoryId in movements.
  // Compute the expected stock from the signed ledger and compare to stockQty.
  const drifts = await prisma.$queryRaw`
    SELECT
      si.inventory_id   AS "inventoryId",
      si.shop_id        AS "shopId",
      si.stock_qty      AS "stockQty",
      COALESCE(
        SUM(
          CASE
            WHEN m.type IN ('PURCHASE', 'OPENING', 'RETURN_IN') THEN  m.qty
            WHEN m.type IN ('SALE', 'DAMAGE', 'THEFT', 'RETURN_OUT') THEN -m.qty
            WHEN m.type = 'ADJUSTMENT'                                THEN  m.qty
            ELSE 0
          END
        ), 0
      )::int            AS "ledgerQty"
    FROM shop_inventory si
    LEFT JOIN movements m ON m.inventory_id = si.inventory_id
    WHERE si.deleted_at IS NULL
    GROUP BY si.inventory_id, si.shop_id, si.stock_qty
    HAVING si.stock_qty <> COALESCE(
      SUM(
        CASE
          WHEN m.type IN ('PURCHASE', 'OPENING', 'RETURN_IN') THEN  m.qty
          WHEN m.type IN ('SALE', 'DAMAGE', 'THEFT', 'RETURN_OUT') THEN -m.qty
          WHEN m.type = 'ADJUSTMENT'                                THEN  m.qty
          ELSE 0
        END
      ), 0
    )
  `;

  if (drifts.length === 0) {
    logger.info({ jobId: job.id }, "[ReconcileWorker] No stock drifts found");
    return { drifts: 0 };
  }

  logger.warn(
    { jobId: job.id, count: drifts.length },
    "[ReconcileWorker] Stock drifts detected â€” creating audit entries"
  );

  // Write one AuditLog row per drift so the discrepancy is traceable.
  await prisma.auditLog.createMany({
    data: drifts.map((row) => ({
      shopId: Number(row.shopId),
      entityType: "STOCK",
      entityId: String(row.inventoryId),
      action: "ADJUST",
      oldValue: { stockQty: Number(row.stockQty) },
      newValue: { ledgerQty: Number(row.ledgerQty) },
      metadata: {
        source: "nightly-reconcile",
        drift: Number(row.ledgerQty) - Number(row.stockQty),
      },
      deviceInfo: {},
    })),
  });

  for (const row of drifts) {
    logger.warn(
      {
        inventoryId: Number(row.inventoryId),
        shopId: Number(row.shopId),
        stockQty: Number(row.stockQty),
        ledgerQty: Number(row.ledgerQty),
        drift: Number(row.ledgerQty) - Number(row.stockQty),
      },
      "[ReconcileWorker] Drift logged"
    );
  }

  return { drifts: drifts.length };
}

export function startReconcileWorker() {
  if (!process.env.REDIS_URL) {
    logger.warn("[ReconcileWorker] REDIS_URL not set â€” worker not started.");
    return null;
  }

  const connection = parseRedisUrl(process.env.REDIS_URL);

  const worker = new Worker("reconcile", processReconcileJob, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, result }, "[ReconcileWorker] Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, "[ReconcileWorker] Job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err: err?.message }, "[ReconcileWorker] Worker error (non-fatal)");
  });

  logger.info("[ReconcileWorker] Started");
  return worker;
}
