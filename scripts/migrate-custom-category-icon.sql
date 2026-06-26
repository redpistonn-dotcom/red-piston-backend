-- Migration: add custom_category_l1 and custom_icon to shop_inventory
-- Run this once in DBeaver / psql against the production and staging databases.
-- Safe to run multiple times (IF NOT EXISTS guards).

ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS custom_category_l1 TEXT;
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS custom_icon         TEXT;
