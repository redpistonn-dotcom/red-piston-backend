-- Step 1: Drop the non-unique index added in the previous migration
DROP INDEX IF EXISTS "master_parts_primary_oem_number_idx";

-- Step 2: Remove duplicate OEM numbers — keep the oldest record per OEM
-- This is safe to run even if there are no duplicates
DELETE FROM master_parts
WHERE master_part_id IN (
  SELECT master_part_id FROM (
    SELECT master_part_id,
           ROW_NUMBER() OVER (
             PARTITION BY primary_oem_number
             ORDER BY created_at ASC
           ) AS rn
    FROM master_parts
    WHERE primary_oem_number IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 3: Add unique constraint (also serves as the index — no separate index needed)
ALTER TABLE "master_parts" ADD CONSTRAINT "master_parts_primary_oem_number_key" UNIQUE ("primary_oem_number");
