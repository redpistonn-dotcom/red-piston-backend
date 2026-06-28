-- Add custom_items_meta column to invoices table.
-- Stores non-inventory line items (services, labour, ad-hoc parts) as a JSONB snapshot.
-- InvoiceItem.inventory_id has a NOT NULL FK constraint, so custom items are stored
-- here instead of as InvoiceItem rows — no schema changes needed for InvoiceItem.
-- Revenue movements for custom items are written to the movements table with inventory_id = NULL.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS custom_items_meta JSONB DEFAULT NULL;
