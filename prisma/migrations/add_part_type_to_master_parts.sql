-- Migration: add part_type column to master_parts
-- All existing parts default to OEM.
-- Run this manually on your database if you are not using prisma migrate dev.

ALTER TABLE master_parts
  ADD COLUMN IF NOT EXISTS part_type VARCHAR(10) NOT NULL DEFAULT 'OEM';

-- Backfill: mark every existing row as OEM (already covered by DEFAULT, but explicit for safety)
UPDATE master_parts SET part_type = 'OEM' WHERE part_type IS NULL OR part_type = '';
