import { Worker } from "bullmq";
import { Resend } from "resend";
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

const resend = new Resend(process.env.RESEND_API_KEY);

const DEFAULT_FROM = process.env.EMAIL_FROM ?? "noreply@redpiston.in";

async function processEmailJob(job) {
  const { to, subject, html, from, text } = job.data;

  const payload = {
    from: from ?? DEFAULT_FROM,
    to,
    subject,
    html,
  };
  if (text) payload.text = text;

  const { data, error } = await resend.emails.send(payload);

  if (error) {
    throw new Error(`Resend error: ${error.message ?? JSON.stringify(error)}`);
  }

  logger.info({ jobId: job.id, emailId: data?.id, to, subject }, "[EmailWorker] Email sent");
  return { emailId: data?.id };
}

export function startEmailWorker() {
  if (!process.env.REDIS_URL) {
    logger.warn("[EmailWorker] REDIS_URL not set â€” worker not started.");
    return null;
  }

  const connection = parseRedisUrl(process.env.REDIS_URL);

  const worker = new Worker("email", processEmailJob, {
    connection,
    concurrency: 3,
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, result }, "[EmailWorker] Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err?.message }, "[EmailWorker] Job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err: err?.message }, "[EmailWorker] Worker error (non-fatal)");
  });

  logger.info("[EmailWorker] Started (concurrency: 3)");
  return worker;
}
