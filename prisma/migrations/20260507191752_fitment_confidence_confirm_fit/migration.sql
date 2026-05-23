/*
  Warnings:

  - Added the required column `updated_at` to the `part_fitments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "part_fitments" ADD COLUMN     "confidence" TEXT NOT NULL DEFAULT 'unverified',
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "confirm_fit_requests" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "master_part_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "variant" TEXT,
    "year" INTEGER NOT NULL,
    "fuel_type" TEXT,
    "reg_no" TEXT,
    "user_note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "shop_note" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" INTEGER,
    "saved_to_fitments" BOOLEAN NOT NULL DEFAULT false,
    "fitment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "confirm_fit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "confirm_fit_requests_user_id_idx" ON "confirm_fit_requests"("user_id");

-- CreateIndex
CREATE INDEX "confirm_fit_requests_shop_id_idx" ON "confirm_fit_requests"("shop_id");

-- CreateIndex
CREATE INDEX "confirm_fit_requests_master_part_id_idx" ON "confirm_fit_requests"("master_part_id");

-- CreateIndex
CREATE INDEX "part_fitments_vehicle_id_idx" ON "part_fitments"("vehicle_id");

-- CreateIndex
CREATE INDEX "part_fitments_master_part_id_idx" ON "part_fitments"("master_part_id");

-- AddForeignKey
ALTER TABLE "confirm_fit_requests" ADD CONSTRAINT "confirm_fit_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirm_fit_requests" ADD CONSTRAINT "confirm_fit_requests_master_part_id_fkey" FOREIGN KEY ("master_part_id") REFERENCES "master_parts"("master_part_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirm_fit_requests" ADD CONSTRAINT "confirm_fit_requests_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("shop_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirm_fit_requests" ADD CONSTRAINT "confirm_fit_requests_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "confirm_fit_requests" ADD CONSTRAINT "confirm_fit_requests_fitment_id_fkey" FOREIGN KEY ("fitment_id") REFERENCES "part_fitments"("fitment_id") ON DELETE SET NULL ON UPDATE CASCADE;
