-- CreateTable
CREATE TABLE "user_types" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "user_id" SERIAL NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "avatar_url" TEXT,
    "password_hash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "user_type_id" INTEGER,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "login_count" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "shop_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "verification_status" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "verification_note" TEXT,
    "verified_at" TIMESTAMP(3),
    "verified_by" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "auth_providers" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PHONE_OTP',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "shop_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "device_info" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "gender" TEXT,
    "date_of_birth" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_notifications" BOOLEAN NOT NULL DEFAULT true,
    "sms_notifications" BOOLEAN NOT NULL DEFAULT true,
    "dark_mode" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'en',

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "wallet_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "address_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Home',
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "landmark" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("address_id")
);

-- CreateTable
CREATE TABLE "customer_vehicles" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "vehicle_id" TEXT,
    "nickname" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "variant" TEXT,
    "year" INTEGER NOT NULL,
    "fuel_type" TEXT,
    "registration_no" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_profiles" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "admin_role" TEXT NOT NULL DEFAULT 'SUPPORT',
    "department" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "ip_whitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "shop_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_name" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "shop_description" TEXT,
    "logo_url" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "plan" TEXT NOT NULL DEFAULT 'FREE',
    "plan_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("shop_id")
);

-- CreateTable
CREATE TABLE "shop_users" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CASHIER',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "invited_by" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3),

    CONSTRAINT "shop_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "vehicle_id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "variant" TEXT,
    "year_from" INTEGER NOT NULL,
    "year_to" INTEGER,
    "fuel_type" TEXT,
    "engine_cc" INTEGER,
    "engine_code" TEXT,
    "transmission" TEXT,
    "body_type" TEXT,
    "vehicle_type" TEXT NOT NULL DEFAULT 'Car',
    "abs_equipped" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "master_parts" (
    "master_part_id" TEXT NOT NULL,
    "part_name" TEXT NOT NULL,
    "brand" TEXT,
    "category_l1" TEXT,
    "category_l2" TEXT,
    "oem_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "barcodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hsn_code" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 18.00,
    "unit_of_sale" TEXT NOT NULL DEFAULT 'Piece',
    "description" TEXT,
    "specifications" JSONB,
    "image_url" TEXT,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_universal" BOOLEAN NOT NULL DEFAULT false,
    "requires_fitment" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_parts_pkey" PRIMARY KEY ("master_part_id")
);

-- CreateTable
CREATE TABLE "part_fitments" (
    "fitment_id" TEXT NOT NULL,
    "master_part_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "fit_type" TEXT NOT NULL,
    "position" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SHOP_CONFIRMED',
    "notes" TEXT,

    CONSTRAINT "part_fitments_pkey" PRIMARY KEY ("fitment_id")
);

-- CreateTable
CREATE TABLE "shop_inventory" (
    "inventory_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "master_part_id" TEXT NOT NULL,
    "selling_price" DECIMAL(10,2) NOT NULL,
    "buying_price" DECIMAL(10,2),
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "reserved_qty" INTEGER NOT NULL DEFAULT 0,
    "min_stock_alert" INTEGER NOT NULL DEFAULT 5,
    "rack_location" TEXT,
    "shop_specific_notes" TEXT,
    "is_marketplace_listed" BOOLEAN NOT NULL DEFAULT false,
    "last_purchased_at" TIMESTAMP(3),
    "last_sold_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_inventory_pkey" PRIMARY KEY ("inventory_id")
);

-- CreateTable
CREATE TABLE "movements" (
    "movement_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "inventory_id" TEXT NOT NULL,
    "created_by" INTEGER,
    "type" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2),
    "total_amount" DECIMAL(10,2),
    "gst_amount" DECIMAL(10,2),
    "profit" DECIMAL(10,2),
    "invoice_id" TEXT,
    "party_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movements_pkey" PRIMARY KEY ("movement_id")
);

-- CreateTable
CREATE TABLE "parties" (
    "party_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "type" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "credit_limit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "outstanding" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("party_id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "invoice_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "party_id" TEXT,
    "created_by" INTEGER,
    "party_name" TEXT,
    "party_phone" TEXT,
    "party_gstin" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxable_amount" DECIMAL(10,2) NOT NULL,
    "cgst" DECIMAL(10,2) NOT NULL,
    "sgst" DECIMAL(10,2) NOT NULL,
    "igst" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "payment_mode" TEXT NOT NULL,
    "cash_amount" DECIMAL(10,2),
    "upi_amount" DECIMAL(10,2),
    "credit_amount" DECIMAL(10,2),
    "paid_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pdf_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("invoice_id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "item_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "inventory_id" TEXT NOT NULL,
    "part_name" TEXT NOT NULL,
    "brand" TEXT,
    "hsn_code" TEXT,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxable_amt" DECIMAL(10,2) NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "cgst" DECIMAL(10,2) NOT NULL,
    "sgst" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "mode" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "po_id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "party_id" TEXT,
    "created_by" INTEGER,
    "supplier_name" TEXT,
    "supplier_phone" TEXT,
    "supplier_gstin" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "taxable_amount" DECIMAL(10,2) NOT NULL,
    "cgst" DECIMAL(10,2) NOT NULL,
    "sgst" DECIMAL(10,2) NOT NULL,
    "igst" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "payment_mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expected_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("po_id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "item_id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "inventory_id" TEXT NOT NULL,
    "part_name" TEXT NOT NULL,
    "hsn_code" TEXT,
    "ordered_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "taxable_amt" DECIMAL(10,2) NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "cgst" DECIMAL(10,2) NOT NULL,
    "sgst" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "job_cards" (
    "job_id" TEXT NOT NULL,
    "job_number" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "created_by" INTEGER,
    "assigned_to" TEXT,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "vehicle_make" TEXT NOT NULL,
    "vehicle_model" TEXT NOT NULL,
    "vehicle_year" INTEGER,
    "vehicle_reg" TEXT,
    "vehicle_fuel" TEXT,
    "odometer_in" INTEGER,
    "odometer_out" INTEGER,
    "complaint" TEXT,
    "diagnosis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "estimated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "labour_charge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "parts_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "payment_mode" TEXT,
    "payment_status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_cards_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "job_card_items" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "inventory_id" TEXT,
    "description" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PART',

    CONSTRAINT "job_card_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_orders" (
    "order_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "customer_id" INTEGER,
    "customer_vehicle_id" TEXT,
    "shop_id" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_phone" TEXT NOT NULL,
    "delivery_address_id" TEXT,
    "delivery_address" TEXT,
    "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "payment_mode" TEXT,
    "razorpay_order_id" TEXT,
    "razorpay_payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "cancel_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "marketplace_order_items" (
    "item_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "inventory_id" TEXT NOT NULL,
    "part_name" TEXT NOT NULL,
    "brand" TEXT,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "marketplace_order_items_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "marketplace_reviews" (
    "review_id" TEXT NOT NULL,
    "master_part_id" TEXT NOT NULL,
    "inventory_id" TEXT,
    "order_id" TEXT,
    "user_id" INTEGER,
    "customer_name" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "verified_purchase" BOOLEAN NOT NULL DEFAULT false,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_reviews_pkey" PRIMARY KEY ("review_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_types_slug_key" ON "user_types"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "auth_providers_user_id_idx" ON "auth_providers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_providers_provider_provider_id_key" ON "auth_providers"("provider", "provider_id");

-- CreateIndex
CREATE INDEX "otp_codes_phone_expires_at_idx" ON "otp_codes"("phone", "expires_at" DESC);

-- CreateIndex
CREATE INDEX "otp_codes_email_expires_at_idx" ON "otp_codes"("email", "expires_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_user_id_key" ON "customer_profiles"("user_id");

-- CreateIndex
CREATE INDEX "customer_addresses_user_id_idx" ON "customer_addresses"("user_id");

-- CreateIndex
CREATE INDEX "customer_vehicles_user_id_idx" ON "customer_vehicles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_profiles_user_id_key" ON "admin_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_phone_key" ON "shops"("phone");

-- CreateIndex
CREATE INDEX "shop_users_shop_id_idx" ON "shop_users"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_users_shop_id_user_id_key" ON "shop_users"("shop_id", "user_id");

-- CreateIndex
CREATE INDEX "vehicles_make_model_idx" ON "vehicles"("make", "model");

-- CreateIndex
CREATE INDEX "master_parts_part_name_idx" ON "master_parts"("part_name");

-- CreateIndex
CREATE INDEX "master_parts_brand_idx" ON "master_parts"("brand");

-- CreateIndex
CREATE UNIQUE INDEX "part_fitments_master_part_id_vehicle_id_key" ON "part_fitments"("master_part_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "shop_inventory_shop_id_idx" ON "shop_inventory"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_inventory_shop_id_master_part_id_key" ON "shop_inventory"("shop_id", "master_part_id");

-- CreateIndex
CREATE INDEX "movements_shop_id_created_at_idx" ON "movements"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "movements_inventory_id_idx" ON "movements"("inventory_id");

-- CreateIndex
CREATE INDEX "parties_shop_id_idx" ON "parties"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "invoices_shop_id_created_at_idx" ON "invoices"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invoice_payments_invoice_id_idx" ON "invoice_payments"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_po_number_key" ON "purchase_orders"("po_number");

-- CreateIndex
CREATE INDEX "purchase_orders_shop_id_created_at_idx" ON "purchase_orders"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "job_cards_job_number_key" ON "job_cards"("job_number");

-- CreateIndex
CREATE INDEX "job_cards_shop_id_created_at_idx" ON "job_cards"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_orders_order_number_key" ON "marketplace_orders"("order_number");

-- CreateIndex
CREATE INDEX "marketplace_orders_customer_id_created_at_idx" ON "marketplace_orders"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "marketplace_orders_shop_id_created_at_idx" ON "marketplace_orders"("shop_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "marketplace_reviews_master_part_id_idx" ON "marketplace_reviews"("master_part_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_user_type_id_fkey" FOREIGN KEY ("user_type_id") REFERENCES "user_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_providers" ADD CONSTRAINT "auth_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_vehicles" ADD CONSTRAINT "customer_vehicles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_vehicles" ADD CONSTRAINT "customer_vehicles_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_profiles" ADD CONSTRAINT "admin_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_users" ADD CONSTRAINT "shop_users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_users" ADD CONSTRAINT "shop_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_fitments" ADD CONSTRAINT "part_fitments_master_part_id_fkey" FOREIGN KEY ("master_part_id") REFERENCES "master_parts"("master_part_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_fitments" ADD CONSTRAINT "part_fitments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_inventory" ADD CONSTRAINT "shop_inventory_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_inventory" ADD CONSTRAINT "shop_inventory_master_part_id_fkey" FOREIGN KEY ("master_part_id") REFERENCES "master_parts"("master_part_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "shop_inventory"("inventory_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("party_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("party_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "shop_inventory"("inventory_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("invoice_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("party_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("po_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "shop_inventory"("inventory_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_card_items" ADD CONSTRAINT "job_card_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job_cards"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_card_items" ADD CONSTRAINT "job_card_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "shop_inventory"("inventory_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_customer_vehicle_id_fkey" FOREIGN KEY ("customer_vehicle_id") REFERENCES "customer_vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_orders" ADD CONSTRAINT "marketplace_orders_delivery_address_id_fkey" FOREIGN KEY ("delivery_address_id") REFERENCES "customer_addresses"("address_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_items" ADD CONSTRAINT "marketplace_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "marketplace_orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_order_items" ADD CONSTRAINT "marketplace_order_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "shop_inventory"("inventory_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_master_part_id_fkey" FOREIGN KEY ("master_part_id") REFERENCES "master_parts"("master_part_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "shop_inventory"("inventory_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reviews" ADD CONSTRAINT "marketplace_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
