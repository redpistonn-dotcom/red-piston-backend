-- Shop-owner staff invite + email-verification + section-permissions.
-- Idempotent — safe to re-run.

ALTER TABLE "shop_users" ADD COLUMN IF NOT EXISTS "role_label" TEXT;
ALTER TABLE "shop_users" ADD COLUMN IF NOT EXISTS "sections" TEXT[] NOT NULL DEFAULT '{}';

-- invited_by was declared TEXT but every write assigns an Int userId — fix the type.
ALTER TABLE "shop_users" ALTER COLUMN "invited_by" TYPE INTEGER USING "invited_by"::integer;

CREATE TABLE IF NOT EXISTS "staff_invites" (
  "id" SERIAL PRIMARY KEY,
  "shop_id" INTEGER NOT NULL REFERENCES "shops"("shop_id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "role_label" TEXT NOT NULL,
  "sections" TEXT[] NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "invited_by" INTEGER,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "verified_at" TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "staff_invites_shop_id_idx" ON "staff_invites"("shop_id");
CREATE INDEX IF NOT EXISTS "staff_invites_email_idx" ON "staff_invites"("email");
