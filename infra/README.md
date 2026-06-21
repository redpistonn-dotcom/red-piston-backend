# Red Piston — Infrastructure

This document covers how the backend is hosted, what external services it depends on, and how deployments work across staging and production.

---

## Table of Contents

1. [Render — Web Service](#1-render--web-service)
2. [Neon — Postgres](#2-neon--postgres)
3. [Upstash — Redis](#3-upstash--redis)
4. [Cloudinary — Media Storage](#4-cloudinary--media-storage)
5. [Doppler — Secrets Management](#5-doppler--secrets-management)
6. [Staging vs Production](#6-staging-vs-production)
7. [GitHub Actions — Deploy Hooks](#7-github-actions--deploy-hooks)

---

## 1. Render — Web Service

The API runs as a **Render Web Service** (Node.js). Configuration lives in `render.yaml` at the repo root.

### Service settings

| Setting | Value |
|---|---|
| Runtime | Node 20 |
| Build command | `npm install && npx prisma generate` |
| Start command | `npm start` |
| Health check path | `/health` |
| Plan | Starter (production) / Free (staging) |

### Required environment variables

Set these in the Render dashboard under **Environment** for each service. Do not commit them.

| Variable | Description |
|---|---|
| `NODE_ENV` | `production` or `staging` |
| `PORT` | `3001` (Render sets this automatically too) |
| `DATABASE_URL` | Neon pooled connection string (see section 2) |
| `DIRECT_URL` | Neon direct (non-pooled) connection string — required for Prisma migrations |
| `REDIS_URL` | Upstash Redis URL (`rediss://...`) |
| `JWT_SECRET` | Strong random string — `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | Different strong random string |
| `FIELD_ENCRYPTION_KEY` | AES field-encryption passphrase — keep stable; changing it breaks all encrypted data |
| `FIREBASE_PROJECT_ID` | Firebase project for push notifications |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key (include `\n` escapes) |
| `RESEND_API_KEY` | Resend transactional email API key |
| `RESEND_SENDER_EMAIL` | Verified sender address, e.g. `noreply@redpiston.in` |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `FRONTEND_URL` | Frontend origin for CORS — e.g. `https://app.redpiston.in` |
| `FRONTEND_APP_URL` | Same as above (used in email links) |
| `RESET_PASSWORD_URL` | `https://app.redpiston.in/reset-password` |

### Auto-deploy

Enable **Auto-Deploy** in the Render dashboard so every push to the target branch (see section 6) triggers a rebuild. For production, prefer deploy hooks (section 7) to control timing.

### Zero-downtime deploys

Render performs rolling deploys. The service stays up during the build. Keep the start command idempotent — Prisma `generate` does not run migrations; run `prisma migrate deploy` as a pre-start step or via a one-off job if schema changes are needed.

---

## 2. Neon — Postgres

Neon is the managed Postgres provider. It supports branching, point-in-time recovery (PITR), and serverless connection pooling.

### Project layout

```
Neon Project: red-piston
├── Branch: main          ← production database
│   └── Endpoint: pooled  (DATABASE_URL)
│   └── Endpoint: direct  (DIRECT_URL — for migrations)
└── Branch: staging       ← staging database (branch from main)
    └── Endpoint: pooled
    └── Endpoint: direct
```

### Point-in-time recovery (PITR)

- Neon retains WAL history for **7 days** on the Free plan, **30 days** on paid plans.
- To restore: go to **Branches** in the Neon console → select the branch → **Restore** → pick a timestamp.
- After restoring, update `DATABASE_URL` in Render to point to the restored endpoint.

### Read replica via branch

Neon branches share the same storage but have independent compute. To create a read replica:

1. Create a branch off `main` in the Neon console (e.g. `main-readonly`).
2. Set the branch's **compute** to auto-suspend.
3. Use the branch's pooled connection string in any read-heavy service (e.g. a reporting job).
4. The branch lags main by the Neon replication delay (typically < 1s).

### Connection pooling

Always use the **pooled** endpoint (`-pooler` in the hostname) in `DATABASE_URL`. Use the **direct** (non-pooled) endpoint in `DIRECT_URL` for Prisma migrations — PgBouncer does not support the extended query protocol that `prisma migrate deploy` requires.

### Running migrations in production

```bash
# From a Render one-off job or locally with production DATABASE_URL:
DIRECT_URL=<neon-direct-url> npx prisma migrate deploy
```

Never run `prisma migrate dev` against production — it may prompt interactively and can drop data.

---

## 3. Upstash — Redis

Upstash provides a serverless Redis instance compatible with BullMQ and general caching.

### Setup

1. Create a database in the [Upstash console](https://console.upstash.com).
2. Choose the **Global** replication tier for production (lowest latency across regions); **Regional** (ap-southeast-1 or ap-south-1) is fine for staging.
3. Copy the **Redis URL** (`rediss://...`) into the `REDIS_URL` environment variable.

### Usage in this project

| Use case | Details |
|---|---|
| **BullMQ queues** | Background jobs (e.g. notification dispatch, webhook retries). Workers read from Upstash via BullMQ's `IORedis`-compatible client. |
| **Application cache** | Short-lived caches for expensive DB reads (e.g. shop inventory counts). TTLs are set per key in `src/lib/cache.js`. |

### Limits and eviction

- Default eviction policy: `noeviction` (Upstash default). For cache-only data, consider `allkeys-lru`.
- Keep queue job data small — store only IDs in the job payload, fetch full records inside the worker.
- Monitor memory in the Upstash console; the Free tier caps at 256 MB.

---

## 4. Cloudinary — Media Storage

Cloudinary stores all user-uploaded media (part images, vehicle photos, etc.).

### Setup

1. Create a free Cloudinary account at [cloudinary.com](https://cloudinary.com).
2. From the **Dashboard**, copy the **Cloud name**, **API Key**, and **API Secret**.
3. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` in Render.

### Folder structure

```
red-piston/
├── parts/          ← master part catalogue images
├── shops/          ← shop logos and banners
└── uploads/        ← general user uploads
```

### Upload presets

For client-side direct uploads (if used), create an **unsigned upload preset** in the Cloudinary console scoped to the `red-piston/uploads` folder. Do not expose the API secret to the frontend.

### Transformation defaults

Images are stored as-is. Thumbnails are generated on-the-fly via Cloudinary URL transformations (e.g. `w_200,h_200,c_fill`). No server-side transformation pipeline is configured.

---

## 5. Doppler — Secrets Management

[Doppler](https://www.doppler.com) is the recommended way to manage environment variables across environments and CI.

### Setup

```bash
# Install CLI
brew install dopplerhq/cli/doppler   # macOS
# or: npm install -g @dopplerhq/cli

# Authenticate
doppler login

# Link this project
doppler setup
# Select project: red-piston
# Select config: staging or production
```

### Environments

| Doppler Config | Render Service | Branch |
|---|---|---|
| `staging` | red-piston-backend-staging | `develop` |
| `production` | red-piston-backend | `main` |

### Syncing secrets to Render

Use the Doppler → Render integration in the Doppler dashboard (**Integrations** tab) to automatically sync secrets. On each Doppler secret change, Render receives the updated values and triggers a service restart (configurable).

Alternatively, use the Doppler CLI in CI:

```bash
doppler run --config production -- npx prisma migrate deploy
```

### Adding a new secret

1. Add the variable in Doppler under the relevant config.
2. Document it in the "Required environment variables" table in section 1.
3. The Render integration (or the CI sync step) propagates it automatically.

---

## 6. Staging vs Production

| Aspect | Staging | Production |
|---|---|---|
| Render service | `red-piston-backend-staging` | `red-piston-backend` |
| Git branch | `develop` | `main` |
| Neon branch | `staging` | `main` |
| Upstash database | Separate regional instance | Global instance |
| Auto-deploy | Yes (on push to `develop`) | Via deploy hook only (section 7) |
| `NODE_ENV` | `staging` | `production` |
| FIELD_ENCRYPTION_KEY | Different value from production | Production value — never share |

**Never point staging to the production database.** Neon branches are isolated — the staging `DATABASE_URL` must use the `staging` branch endpoint.

To promote the staging database to production (e.g. after a data seed):
1. Create a Neon branch from the staging branch's current state.
2. Restore production to that branch (see PITR section).
3. This is a destructive operation — take a production snapshot first.

---

## 7. GitHub Actions — Deploy Hooks

Production deploys are gated behind a manual approval step to prevent accidental pushes to live.

### Render deploy hooks

1. In the Render dashboard, go to the production service → **Settings** → **Deploy Hooks**.
2. Click **Add Deploy Hook** and copy the generated URL.
3. Store it as a GitHub secret: `RENDER_DEPLOY_HOOK_PRODUCTION`.

### Workflow: `.github/workflows/deploy-production.yml`

```yaml
name: Deploy to Production

on:
  workflow_dispatch:           # manual trigger only
  push:
    branches: [main]
    paths-ignore:
      - 'infra/**'
      - '**.md'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production      # requires manual approval in GitHub Environments
    steps:
      - name: Trigger Render deploy
        run: |
          curl -X POST "${{ secrets.RENDER_DEPLOY_HOOK_PRODUCTION }}"
```

### Workflow: `.github/workflows/deploy-staging.yml`

```yaml
name: Deploy to Staging

on:
  push:
    branches: [develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Render staging deploy
        run: |
          curl -X POST "${{ secrets.RENDER_DEPLOY_HOOK_STAGING }}"
```

### Required GitHub secrets

| Secret | Value |
|---|---|
| `RENDER_DEPLOY_HOOK_PRODUCTION` | Render deploy hook URL for production service |
| `RENDER_DEPLOY_HOOK_STAGING` | Render deploy hook URL for staging service |

### GitHub Environment protection rules

Go to **Settings → Environments → production** and add:
- **Required reviewers**: at least one senior engineer.
- **Wait timer**: 0 minutes (or set a delay if desired).

This ensures no code reaches production without a human sign-off, even on direct pushes to `main`.
