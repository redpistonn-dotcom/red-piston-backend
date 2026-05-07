import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const vehicles = [
  // Maruti Suzuki
  { make: 'Maruti Suzuki', model: 'Swift', variant: 'VXI', yearFrom: 2017, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Swift', variant: 'ZXI', yearFrom: 2017, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Swift', variant: 'VDI', yearFrom: 2017, yearTo: null, fuelType: 'Diesel', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Swift', variant: 'ZDI', yearFrom: 2017, yearTo: null, fuelType: 'Diesel', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Baleno', variant: 'Delta', yearFrom: 2015, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Baleno', variant: 'Zeta', yearFrom: 2015, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Alto', variant: 'LXI', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'WagonR', variant: 'LXI', yearFrom: 2019, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Maruti Suzuki', model: 'Dzire', variant: 'VXI', yearFrom: 2017, yearTo: null, fuelType: 'Petrol', bodyType: 'Sedan' },
  { make: 'Maruti Suzuki', model: 'Vitara Brezza', variant: 'VDI', yearFrom: 2016, yearTo: 2022, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Maruti Suzuki', model: 'Grand Vitara', variant: 'Alpha', yearFrom: 2022, yearTo: null, fuelType: 'Petrol', bodyType: 'SUV' },
  { make: 'Maruti Suzuki', model: 'Ciaz', variant: 'Alpha', yearFrom: 2014, yearTo: null, fuelType: 'Petrol', bodyType: 'Sedan' },
  { make: 'Maruti Suzuki', model: 'Ertiga', variant: 'VXI', yearFrom: 2018, yearTo: null, fuelType: 'Petrol', bodyType: 'MPV' },
  // Hyundai
  { make: 'Hyundai', model: 'i20', variant: 'Sportz', yearFrom: 2014, yearTo: 2020, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Hyundai', model: 'i20', variant: 'Asta', yearFrom: 2020, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Hyundai', model: 'Creta', variant: 'SX', yearFrom: 2015, yearTo: null, fuelType: 'Petrol', bodyType: 'SUV' },
  { make: 'Hyundai', model: 'Creta', variant: 'SX', yearFrom: 2015, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Hyundai', model: 'Venue', variant: 'SX', yearFrom: 2019, yearTo: null, fuelType: 'Petrol', bodyType: 'SUV' },
  { make: 'Hyundai', model: 'Grand i10', variant: 'Sportz', yearFrom: 2013, yearTo: 2019, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Hyundai', model: 'Verna', variant: 'SX', yearFrom: 2017, yearTo: null, fuelType: 'Petrol', bodyType: 'Sedan' },
  // Tata
  { make: 'Tata', model: 'Nexon', variant: 'XZA+', yearFrom: 2017, yearTo: null, fuelType: 'Petrol', bodyType: 'SUV' },
  { make: 'Tata', model: 'Nexon', variant: 'XZA+', yearFrom: 2017, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Tata', model: 'Tiago', variant: 'XZA', yearFrom: 2016, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Tata', model: 'Harrier', variant: 'XZA+', yearFrom: 2019, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Tata', model: 'Punch', variant: 'Accomplished', yearFrom: 2021, yearTo: null, fuelType: 'Petrol', bodyType: 'SUV' },
  // Honda
  { make: 'Honda', model: 'City', variant: 'VX', yearFrom: 2014, yearTo: null, fuelType: 'Petrol', bodyType: 'Sedan' },
  { make: 'Honda', model: 'Amaze', variant: 'VX', yearFrom: 2013, yearTo: null, fuelType: 'Petrol', bodyType: 'Sedan' },
  { make: 'Honda', model: 'Jazz', variant: 'VX', yearFrom: 2015, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  { make: 'Honda', model: 'WR-V', variant: 'VX', yearFrom: 2017, yearTo: null, fuelType: 'Petrol', bodyType: 'SUV' },
  // Toyota
  { make: 'Toyota', model: 'Innova', variant: 'GX', yearFrom: 2012, yearTo: 2015, fuelType: 'Diesel', bodyType: 'MPV' },
  { make: 'Toyota', model: 'Innova Crysta', variant: 'GX', yearFrom: 2016, yearTo: null, fuelType: 'Diesel', bodyType: 'MPV' },
  { make: 'Toyota', model: 'Fortuner', variant: 'GR Sport', yearFrom: 2016, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Toyota', model: 'Glanza', variant: 'V', yearFrom: 2019, yearTo: null, fuelType: 'Petrol', bodyType: 'Hatchback' },
  // Mahindra
  { make: 'Mahindra', model: 'Scorpio', variant: 'S10', yearFrom: 2014, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Mahindra', model: 'XUV500', variant: 'W10', yearFrom: 2012, yearTo: 2021, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Mahindra', model: 'XUV700', variant: 'AX7', yearFrom: 2021, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Mahindra', model: 'Thar', variant: 'LX', yearFrom: 2020, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  { make: 'Mahindra', model: 'Bolero', variant: 'ZLX', yearFrom: 2012, yearTo: null, fuelType: 'Diesel', bodyType: 'SUV' },
  // Two-wheelers
  { make: 'Hero', model: 'Splendor Plus', variant: 'Standard', yearFrom: 2014, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Hero', model: 'HF Deluxe', variant: 'Standard', yearFrom: 2014, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Hero', model: 'Passion Pro', variant: 'Standard', yearFrom: 2015, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Bajaj', model: 'Pulsar 150', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Bajaj', model: 'Pulsar 220', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Bajaj', model: 'Platina', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'TVS', model: 'Apache RTR 160', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'TVS', model: 'Jupiter', variant: 'Standard', yearFrom: 2013, yearTo: null, fuelType: 'Petrol', bodyType: 'Scooter' },
  { make: 'Honda Motorcycles', model: 'Activa 6G', variant: 'Standard', yearFrom: 2020, yearTo: null, fuelType: 'Petrol', bodyType: 'Scooter' },
  { make: 'Honda Motorcycles', model: 'Shine', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Royal Enfield', model: 'Classic 350', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
  { make: 'Royal Enfield', model: 'Bullet 350', variant: 'Standard', yearFrom: 2012, yearTo: null, fuelType: 'Petrol', bodyType: 'Motorcycle' },
];

const masterParts = [
  { oemNumber: '04465-02220', partName: 'Front Brake Pad Set', brand: 'Toyota Genuine', categoryL1: 'Brakes', hsnCode: '8708', gstRate: 28, unitOfSale: 'Set', status: 'VERIFIED', source: 'MANUAL' },
  { oemNumber: '58101-2MA00', partName: 'Front Brake Pad Set', brand: 'Hyundai Genuine', categoryL1: 'Brakes', hsnCode: '8708', gstRate: 28, unitOfSale: 'Set', status: 'VERIFIED', source: 'MANUAL' },
  { oemNumber: '1567A-78K00', partName: 'Oil Filter', brand: 'Maruti Genuine', categoryL1: 'Filters', hsnCode: '8421', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Oil Filter - Universal Petrol', brand: 'Bosch', categoryL1: 'Filters', hsnCode: '8421', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Air Filter', brand: 'K&N', categoryL1: 'Filters', hsnCode: '8421', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Spark Plug', brand: 'NGK', categoryL1: 'Ignition', hsnCode: '8511', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { oemNumber: '12290-51G11', partName: 'Spark Plug', brand: 'Maruti Genuine', categoryL1: 'Ignition', hsnCode: '8511', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Wiper Blade Front 22 inch', brand: 'Bosch', categoryL1: 'Body & Exterior', hsnCode: '8512', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Engine Oil 5W-30 1L', brand: 'Castrol', categoryL1: 'Engine Oils', hsnCode: '2710', gstRate: 18, unitOfSale: 'Litre', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Coolant 1L', brand: 'Honda Genuine', categoryL1: 'Fluids', hsnCode: '3820', gstRate: 18, unitOfSale: 'Litre', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Rear Brake Shoe Set', brand: 'Bosch', categoryL1: 'Brakes', hsnCode: '8708', gstRate: 28, unitOfSale: 'Set', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Clutch Plate Set', brand: 'LUK', categoryL1: 'Clutch & Transmission', hsnCode: '8708', gstRate: 28, unitOfSale: 'Set', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Alternator Belt', brand: 'Gates', categoryL1: 'Engine', hsnCode: '4010', gstRate: 18, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Battery 35Ah', brand: 'Amaron', categoryL1: 'Electrical', hsnCode: '8507', gstRate: 28, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
  { partName: 'Battery 45Ah', brand: 'Exide', categoryL1: 'Electrical', hsnCode: '8507', gstRate: 28, unitOfSale: 'Piece', status: 'VERIFIED', source: 'MANUAL' },
];

async function main() {
  console.log('Seeding database...');

  // Seed vehicles
  console.log('Inserting vehicles...');
  for (const v of vehicles) {
    await prisma.vehicle.upsert({
      where: {
        // Use a unique combination
        vehicleId: '00000000-0000-0000-0000-000000000000', // dummy, always insert
      },
      update: {},
      create: v,
    }).catch(() => prisma.vehicle.create({ data: v }));
  }

  // Seed master parts
  console.log('Inserting master parts...');
  for (const p of masterParts) {
    await prisma.masterPart.create({ data: p }).catch(e => console.log('Part already exists:', p.partName));
  }

  // Create a demo shop
  const shop = await prisma.shop.upsert({
    where: { phone: '9999999999' },
    update: {},
    create: {
      name: "Raju Auto Parts",
      ownerName: "Raju",
      phone: "9999999999",
      gstin: "36AABCS1429B1Z1",
      address: "Shop No. 5, Afzal Gunj, Hyderabad",
      city: "Hyderabad",
      pincode: "500002",
      latitude: 17.3850,
      longitude: 78.4867,
    },
  });

  console.log('Demo shop created:', shop.shopId);

  // Create demo user linked to shop
  await prisma.user.upsert({
    where: { phone: '9999999999' },
    update: {},
    create: {
      phone: '9999999999',
      name: 'Raju',
      role: 'SHOP_OWNER',
      shopId: shop.shopId,
    },
  });

  console.log('Seeding complete!');
  console.log('Demo login: phone=9999999999, OTP will be printed in console (dev mode)');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
