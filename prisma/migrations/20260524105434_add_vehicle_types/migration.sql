-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "vehicle_type_id" INTEGER;

-- CreateTable
CREATE TABLE "vehicle_types" (
    "vehicle_type_id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_types_pkey" PRIMARY KEY ("vehicle_type_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_name_key" ON "vehicle_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_slug_key" ON "vehicle_types"("slug");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("vehicle_type_id") ON DELETE SET NULL ON UPDATE CASCADE;
