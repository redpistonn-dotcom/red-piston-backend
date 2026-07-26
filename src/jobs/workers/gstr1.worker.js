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

// Returns { from: Date, to: Date } for the calendar month before the current one.
function lastMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive upper bound
  return { from, to };
}

async function processGstr1Job(job) {
  const { from, to } = lastMonthRange();

  logger.info(
    { jobId: job.id, from, to },
    "[Gstr1Worker] Starting GSTR-1 aggregation for last month"
  );

  // Fetch all active shops that have a GSTIN registered.
  const shops = await prisma.shop.findMany({
    where: {
      isActive: true,
      gstin: { not: null },
    },
    select: {
      shopId: true,
      name: true,
      gstin: true,
    },
  });

  if (shops.length === 0) {
    logger.info({ jobId: job.id }, "[Gstr1Worker] No shops with GSTIN found â€” nothing to do");
    return { shopsProcessed: 0 };
  }

  logger.info({ jobId: job.id, shopCount: shops.length }, "[Gstr1Worker] Processing shops");

  for (const shop of shops) {
    await aggregateShopGstr1(job.id, shop, from, to);
  }

  logger.info(
    { jobId: job.id, shopsProcessed: shops.length },
    "[Gstr1Worker] GSTR-1 aggregation complete"
  );

  return { shopsProcessed: shops.length };
}

async function aggregateShopGstr1(jobId, shop, from, to) {
  // Aggregate PAID invoices for the month, grouped by HSN code + GST rate.
  // InvoiceItems carry hsnCode + gstRate; we sum taxable amounts and GST.
  const rows = await prisma.invoiceItem.groupBy({
    by: ["hsnCode", "gstRate"],
    where: {
      invoice: {
        shopId: shop.shopId,
        status: "PAID",
        createdAt: { gte: from, lt: to },
      },
    },
    _sum: {
      taxableAmt: true,
      cgst: true,
      sgst: true,
      total: true,
    },
    _count: {
      itemId: true,
    },
  });

  if (rows.length === 0) {
    logger.info(
      { jobId, shopId: shop.shopId, shopName: shop.name },
      "[Gstr1Worker] No invoices for shop in period"
    );
    return;
  }

  // Log each HSN bucket so the output is readable in the job logs.
  for (const row of rows) {
    logger.info(
      {
        jobId,
        shopId: shop.shopId,
        shopName: shop.name,
        gstin: shop.gstin,
        hsnCode: row.hsnCode ?? "NONE",
        gstRate: row.gstRate?.toString() ?? "0",
        lineCount: row._count.itemId,
        taxableAmt: row._sum.taxableAmt?.toString() ?? "0",
        cgst: row._sum.cgst?.toString() ?? "0",
        sgst: row._sum.sgst?.toString() ?? "0",
        grandTotal: row._sum.total?.toString() ?? "0",
      },
      "[Gstr1Worker] HSN summary"
    );
  }

  const totalTaxable = rows.reduce(
    (acc, r) => acc + Number(r._sum.taxableAmt ?? 0),
    0
  );
  const totalGst = rows.reduce(
    (acc, r) => acc + Number(r._sum.cgst ?? 0) + Number(r._sum.sgst ?? 0),
    0
  );

  logger.info(
    {
      jobId,
      shopId: shop.shopId,
      shopName: shop.name,
      gstin: shop.gstin,
      hsnBuckets: rows.length,
      totalTaxable: totalTaxable.toFixed(2),
      totalGst: totalGst.toFixed(2),
    },
    "[Gstr1Worker] Shop GSTR-1 totals"
  );
}

export function startGstr1Worker() {
  if (!process.env.REDIS_URL) {
    logger.warn("[Gstr1Worker] REDIS_URL not set â€” worker not started.");
    return null;
  }

  const connection = parseRedisUrl(process.env.REDIS_URL);

  const worker = new Worker("gstr1", processGstr1Job, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, result }, "[Gstr1Worker] Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, "[Gstr1Worker] Job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err: err?.message }, "[Gstr1Worker] Worker error (non-fatal)");
  });

  logger.info("[Gstr1Worker] Started");
  return worker;
}
