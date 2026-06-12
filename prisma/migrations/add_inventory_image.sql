-- Shop-specific product photo. Previously images uploaded from the ProductModal
-- went to Cloudinary but had nowhere to persist (only MasterPart.image_url,
-- which is admin-controlled for contributed parts).
ALTER TABLE shop_inventory ADD COLUMN IF NOT EXISTS image_url TEXT;
