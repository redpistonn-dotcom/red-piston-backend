import { Queue } from "bullmq";

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

let connection = null;
let emailQueue = null;
let pdfQueue = null;
let auditQueue = null;
let cleanupQueue = null;
let reconcileQueue = null;
let gstr1Queue = null;

if (process.env.REDIS_URL) {
  connection = parseRedisUrl(process.env.REDIS_URL);

  emailQueue = new Queue("email", {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
    },
  });

  pdfQueue = new Queue("pdf", {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: "fixed",
        delay: 3000,
      },
    },
  });

  auditQueue = new Queue("audit", {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
    },
  });

  cleanupQueue = new Queue("cleanup", {
    connection,
    defaultJobOptions: {
      attempts: 1,
    },
  });

  reconcileQueue = new Queue("reconcile", {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: "fixed",
        delay: 5000,
      },
    },
  });

  gstr1Queue = new Queue("gstr1", {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: {
        type: "fixed",
        delay: 10000,
      },
    },
  });
}

export async function scheduleRecurringJobs() {
  if (!cleanupQueue || !reconcileQueue || !gstr1Queue) {
    console.warn("[scheduleRecurringJobs] REDIS_URL not set — skipping recurring job scheduling.");
    return;
  }

  await cleanupQueue.add(
    "cleanup-expired-tokens",
    {},
    {
      repeat: { pattern: "0 2 * * *" },
      jobId: "cleanup-expired-tokens",
    }
  );

  await cleanupQueue.add(
    "db-keepalive",
    {},
    {
      repeat: { every: 240000 },
      jobId: "db-keepalive",
    }
  );

  await reconcileQueue.add(
    "nightly-stock-reconcile",
    {},
    {
      repeat: { pattern: "30 2 * * *" },
      jobId: "nightly-stock-reconcile",
    }
  );

  await gstr1Queue.add(
    "monthly-gstr1",
    {},
    {
      repeat: { pattern: "0 6 1 * *" },
      jobId: "monthly-gstr1",
    }
  );

  console.log("[scheduleRecurringJobs] Recurring jobs scheduled.");
}

export { emailQueue, pdfQueue, auditQueue, cleanupQueue, reconcileQueue, gstr1Queue };
