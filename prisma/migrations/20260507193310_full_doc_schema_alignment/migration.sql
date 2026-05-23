-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "profile_type" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
ADD COLUMN     "total_orders" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_spent" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "customer_vehicles" ADD COLUMN     "purchase_year" INTEGER;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "billing_address" TEXT,
ADD COLUMN     "invoice_type" TEXT NOT NULL DEFAULT 'RETAIL',
ADD COLUMN     "is_credit_sale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketplace_order_id" TEXT,
ADD COLUMN     "upi_reference" TEXT,
ADD COLUMN     "whatsapp_sent_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "marketplace_orders" ADD COLUMN     "commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "estimated_delivery_at" TIMESTAMP(3),
ADD COLUMN     "payment_status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "payout_amount" DECIMAL(10,2),
ADD COLUMN     "payout_status" TEXT NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "master_parts" ADD COLUMN     "category_l3" TEXT,
ADD COLUMN     "contributed_by_shop_id" TEXT,
ADD COLUMN     "primary_oem_number" TEXT,
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "weight_grams" INTEGER;

-- AlterTable
ALTER TABLE "movements" ADD COLUMN     "gst_rate" DECIMAL(5,2),
ADD COLUMN     "reference_number" TEXT,
ADD COLUMN     "taxable_amount" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "part_fitments" ADD COLUMN     "verified_by" INTEGER;

-- AlterTable
ALTER TABLE "parties" ADD COLUMN     "credit_days" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "shop_inventory" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "custom_part_name" TEXT,
ADD COLUMN     "max_stock_level" INTEGER;

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "bank_account_name" TEXT,
ADD COLUMN     "bank_account_number" TEXT,
ADD COLUMN     "bank_ifsc" TEXT,
ADD COLUMN     "delivery_radius_km" INTEGER DEFAULT 10,
ADD COLUMN     "pan_number" TEXT,
ADD COLUMN     "state_code" TEXT;

-- CreateTable
CREATE TABLE "party_ledger" (
    "ledger_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "debit_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "balance_after" DECIMAL(10,2) NOT NULL,
    "invoice_id" TEXT,
    "reference_no" TEXT,
    "notes" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_ledger_pkey" PRIMARY KEY ("ledger_id")
);

-- CreateIndex
CREATE INDEX "party_ledger_party_id_created_at_idx" ON "party_ledger"("party_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "party_ledger_shop_id_created_at_idx" ON "party_ledger"("shop_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("party_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE SET NULL ON UPDATE CASCADE;
