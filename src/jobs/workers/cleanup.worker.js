import { Worker } from "bullmq";
import prisma from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";

function parseRedisUrl(redisUrl) {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    maxRetriesPerRequest: null,
  };
  if (url.password) {
    connection.password = decodeURIComponent(url.password);
  }
  if (url.protocol === "rediss:") {
    connection.tls = {};
  }
  return connection;
}

async function processCleanupJob(job) {
  const { name } = job;

  if (name === "db-keepalive") {
    await prisma.$queryRaw`SELECT 1`;
    logger.info({ jobId: job.id }, "[CleanupWorker] DB keepalive ping OK");
    return { ok: true };
  }

  if (name === "cleanup-expired-tokens") {
    const now = new Date();

    const [deletedTokens, deletedOtps] = await Promise.all([
      prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      prisma.otpCode.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
    ]);

    logger.info(
      {
        jobId: job.id,
        deletedRefreshTokens: deletedTokens.count,
        deletedOtpCodes: deletedOtps.count,
      },
      "[CleanupWorker] Expired tokens deleted"
    );

    return {
      deletedRefreshTokens: deletedTokens.count,
      deletedOtpCodes: deletedOtps.count,
    };
  }

  logger.warn({ jobId: job.id, jobName: name }, "[CleanupWorker] Unknown job name — skipped");
  return { skipped: true };
}

export function startCleanupWorker() {
  if (!process.env.REDIS_URL) {
    logger.warn("[CleanupWorker] REDIS_URL not set — worker not started.");
    return null;
  }

  const connection = parseRedisUrl(process.env.REDIS_URL);

  const worker = new Worker("cleanup", processCleanupJob, {
    connection,
    concurrency: 1,
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, jobName: job.name, result }, "[CleanupWorker] Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err: err?.message }, "[CleanupWorker] Job failed");
  });

  logger.info("[CleanupWorker] Started");
  return worker;
}
