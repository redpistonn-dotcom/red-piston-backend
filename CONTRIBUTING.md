# Contributing

## Branch Strategy

- `main` — production-ready at all times. Direct pushes blocked.
- `staging` — pre-production integration branch.
- Feature branches: `feat/<short-description>` (e.g. `feat/invoice-pdf`)
- Bug fixes: `fix/<short-description>`
- Migrations: `db/<short-description>` (reviewed separately before merge)

**Flow**: open a PR against `staging` → review + CI green → merge → deploy to staging → promote to `main` via a PR when verified.

Squash-merge feature branches. Merge-commit for release promotions (`staging` → `main`) so the history stays readable.

---

## Database Migrations: Expand-Contract Pattern

This is the most critical discipline for zero-downtime deploys. Every schema change that removes or renames something MUST follow this three-phase approach.

### Why it matters

During a rolling deploy, old and new application code run simultaneously against the same database. Dropping a column that old code still reads causes immediate 500s. The expand-contract pattern eliminates this risk.

### Phase 1 — Expand (backwards-compatible addition)

Add new columns/tables without removing anything. Old code ignores the new column; new code writes to both old and new.

```sql
-- Example: renaming column "phone" to "phone_number"
ALTER TABLE users ADD COLUMN phone_number VARCHAR(20);
```

Deploy application code that writes to BOTH `phone` (old) and `phone_number` (new), and reads from `phone_number` with a fallback to `phone`.

### Phase 2 — Migrate data

Backfill the new column from the old one. Do this in batches on large tables to avoid lock contention.

```sql
UPDATE users SET phone_number = phone WHERE phone_number IS NULL;
```

Verify row counts and spot-check values before proceeding.

### Phase 3 — Contract (remove the old column)

Only after the new code has been deployed everywhere and the old column is no longer read or written by any running process:

```sql
ALTER TABLE users DROP COLUMN phone;
```

This phase can be a separate PR/deploy, often days or weeks later.

### Rules

- Never combine Phase 1 and Phase 3 in the same migration file.
- Never rename a column directly (`ALTER COLUMN RENAME`) in a single deploy — that is a Phase 1 + Phase 3 collapse.
- Add a `NOT NULL` constraint only after backfill is complete and verified.
- Every migration file must be idempotent (use `IF NOT EXISTS`, `IF EXISTS`).
- Migration files go in `prisma/migrations/` (managed by Prisma Migrate) or `scripts/migrations/` for raw SQL one-offs. Document raw one-offs in `CHANGELOG.md`.

---

## Adding a BullMQ Worker

1. **Define the queue** in `src/queues/<feature>.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis";

export const billingQueue = new Queue("billing", { connection: redisConnection });
```

2. **Define the worker** in `src/workers/<feature>.worker.ts`:

```ts
import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis";

export const billingWorker = new Worker(
  "billing",
  async (job) => {
    // job.data is typed; throw to trigger BullMQ retry
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

billingWorker.on("failed", (job, err) => {
  console.error("[billingWorker] job failed", job?.id, err);
});
```

3. **Register the worker** in `src/workers/index.ts` so it starts with the server process.

4. **Add retry config** on the queue or per-job:

```ts
billingQueue.add("generate-invoice", data, {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
});
```

5. **Test** using `src/__tests__/workers/<feature>.worker.test.ts`. Mock the worker processor with `vi.fn()` and assert job outcomes without a real Redis connection (use `bullmq`'s `Worker` with an in-memory mock or a test Redis instance).

---

## Adding a Feature Flag

Feature flags are environment-variable-driven. No external service is required at this stage.

1. **Add the env var** to `.env.example` with a comment:

```
# Enable experimental invoice PDF generation (true/false)
FEATURE_INVOICE_PDF=false
```

2. **Add a typed accessor** in `src/lib/feature-flags.ts`:

```ts
export const flags = {
  invoicePdf: process.env.FEATURE_INVOICE_PDF === "true",
} as const;
```

3. **Gate the feature** in application code:

```ts
import { flags } from "../lib/feature-flags";

if (flags.invoicePdf) {
  // new code path
}
```

4. **Document** the flag in the Env Vars Reference section below and in `CHANGELOG.md`.

5. To promote: flip the env var in the deployment config (render.yaml / SST / .env on the server), redeploy. No code change needed.

---

## Env Vars Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (Prisma) |
| `REDIS_URL` | Yes | — | Redis connection string (BullMQ + cache) |
| `JWT_SECRET` | Yes | — | Secret for signing auth tokens |
| `PORT` | No | `3001` | HTTP server port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `E2E_BASE_URL` | No | `http://localhost:5173` | Frontend base URL for Playwright E2E tests |
| `BASE_URL` | No | `http://localhost:3001` | Backend base URL for k6 load tests |
| `JWT_TOKEN` | No | — | Auth token injected into k6 load test requests |
| `FEATURE_INVOICE_PDF` | No | `false` | Enable experimental PDF invoice generation |

Never commit `.env` files. Copy `.env.example` to `.env` locally and fill in values.
