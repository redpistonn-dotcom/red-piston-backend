/**
 * seed_vehicles.cjs
 *
 * One-time seed for the Indian vehicle hierarchy:
 *   VehicleManufacturer  →  VehicleModel  →  Vehicle (base fitment row per model)
 *
 * Run:  node prisma/seed_vehicles.cjs
 *
 * Safe to re-run — all operations use upsert.
 */

'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// MANUFACTURERS
// vehicleTypes: car | 2wheeler | commercial | tractor
// ─────────────────────────────────────────────────────────────────────────────
const MANUFACTURERS = [
  // ── Passenger Cars ──────────────────────────────────────────────────────────
  { name: 'Maruti Suzuki',      slug: 'maruti-suzuki',      country: 'India',        parentGroup: 'Suzuki Group',         vehicleTypes: ['car'],                   sortOrder: 1  },
  { name: 'Hyundai',            slug: 'hyundai',             country: 'South Korea',  parentGroup: null,                    vehicleTypes: ['car'],                   sortOrder: 2  },
  { name: 'Tata Motors',        slug: 'tata-motors',         country: 'India',        parentGroup: 'Tata Group',           vehicleTypes: ['car', 'commercial'],     sortOrder: 3  },
  { name: 'Mahindra',           slug: 'mahindra',            country: 'India',        parentGroup: 'Mahindra Group',       vehicleTypes: ['car', 'commercial', 'tractor'], sortOrder: 4 },
  { name: 'Toyota',             slug: 'toyota',              country: 'Japan',        parentGroup: null,                    vehicleTypes: ['car'],                   sortOrder: 5  },
  { name: 'Honda Cars India',   slug: 'honda-cars',          country: 'Japan',        parentGroup: 'Honda Group',          vehicleTypes: ['car'],                   sortOrder: 6  },
  { name: 'Kia India',          slug: 'kia',                 country: 'South Korea',  parentGroup: 'Hyundai Motor Group',  vehicleTypes: ['car'],                   sortOrder: 7  },
  { name: 'MG Motor India',     slug: 'mg-motor',            country: 'China/UK',     parentGroup: 'SAIC Motor',           vehicleTypes: ['car'],                   sortOrder: 8  },
  { name: 'Skoda Auto India',   slug: 'skoda',               country: 'Czech',        parentGroup: 'Volkswagen Group',     vehicleTypes: ['car'],                   sortOrder: 9  },
  { name: 'Volkswagen India',   slug: 'volkswagen',          country: 'Germany',      parentGroup: 'Volkswagen Group',     vehicleTypes: ['car'],                   sortOrder: 10 },
  { name: 'Renault India',      slug: 'renault',             country: 'France',       parentGroup: null,                    vehicleTypes: ['car'],                   sortOrder: 11 },
  { name: 'Nissan India',       slug: 'nissan',              country: 'Japan',        parentGroup: null,                    vehicleTypes: ['car'],                   sortOrder: 12 },
  { name: 'Jeep India',         slug: 'jeep',                country: 'USA',          parentGroup: 'Stellantis',           vehicleTypes: ['car'],                   sortOrder: 13 },
  { name: 'Ford India',         slug: 'ford',                country: 'USA',          parentGroup: null,                    vehicleTypes: ['car'],                   sortOrder: 14 },
  { name: 'Chevrolet India',    slug: 'chevrolet',           country: 'USA',          parentGroup: 'General Motors',       vehicleTypes: ['car'],                   sortOrder: 15 },
  { name: 'BMW India',          slug: 'bmw',                 country: 'Germany',      parentGroup: 'BMW Group',            vehicleTypes: ['car'],                   sortOrder: 16 },
  { name: 'Mercedes-Benz India',slug: 'mercedes-benz',       country: 'Germany',      parentGroup: 'Daimler Group',        vehicleTypes: ['car'],                   sortOrder: 17 },
  { name: 'Audi India',         slug: 'audi',                country: 'Germany',      parentGroup: 'Volkswagen Group',     vehicleTypes: ['car'],                   sortOrder: 18 },
  { name: 'Citroen India',      slug: 'citroen',             country: 'France',       parentGroup: 'Stellantis',           vehicleTypes: ['car'],                   sortOrder: 19 },
  { name: 'Isuzu India',        slug: 'isuzu',               country: 'Japan',        parentGroup: null,                    vehicleTypes: ['car'],                   sortOrder: 20 },
  { name: 'Datsun India',       slug: 'datsun',              country: 'Japan',        parentGroup: 'Renault-Nissan Alliance',vehicleTypes: ['car'],                  sortOrder: 21 },
  { name: 'Force Motors',       slug: 'force-motors',        country: 'India',        parentGroup: null,                    vehicleTypes: ['car', 'commercial'],     sortOrder: 22 },
  { name: 'Volvo Cars India',   slug: 'volvo-cars',          country: 'Sweden',       parentGroup: 'Geely Group',          vehicleTypes: ['car'],                   sortOrder: 23 },
  // ── 2-Wheelers ─────────────────────────────────────────────────────────────
  { name: 'Hero MotoCorp',          slug: 'hero-motocorp',    country: 'India',   parentGroup: 'Hero Group',    vehicleTypes: ['2wheeler'],              sortOrder: 30 },
  { name: 'Bajaj Auto',             slug: 'bajaj-auto',       country: 'India',   parentGroup: 'Bajaj Group',   vehicleTypes: ['2wheeler', 'commercial'], sortOrder: 31 },
  { name: 'TVS Motor Company',      slug: 'tvs-motor',        country: 'India',   parentGroup: 'TVS Group',     vehicleTypes: ['2wheeler'],              sortOrder: 32 },
  { name: 'Honda Motorcycles (HMSI)',slug: 'honda-motorcycles',country: 'Japan',  parentGroup: 'Honda Group',   vehicleTypes: ['2wheeler'],              sortOrder: 33 },
  { name: 'Royal Enfield',          slug: 'royal-enfield',    country: 'India',   parentGroup: 'Eicher Motors', vehicleTypes: ['2wheeler'],              sortOrder: 34 },
  { name: 'Yamaha India',           slug: 'yamaha',           country: 'Japan',   parentGroup: 'Yamaha Motor',  vehicleTypes: ['2wheeler'],              sortOrder: 35 },
  { name: 'Suzuki Motorcycles India',slug:'suzuki-motorcycles',country: 'Japan',  parentGroup: 'Suzuki Group',  vehicleTypes: ['2wheeler'],              sortOrder: 36 },
  { name: 'KTM India',              slug: 'ktm',              country: 'Austria', parentGroup: 'Pierer Mobility',vehicleTypes: ['2wheeler'],             sortOrder: 37 },
  { name: 'Ola Electric',           slug: 'ola-electric',     country: 'India',   parentGroup: null,            vehicleTypes: ['2wheeler'],              sortOrder: 38 },
  { name: 'Ather Energy',           slug: 'ather-energy',     country: 'India',   parentGroup: null,            vehicleTypes: ['2wheeler'],              sortOrder: 39 },
  { name: 'Revolt Intellicorp',     slug: 'revolt',           country: 'India',   parentGroup: null,            vehicleTypes: ['2wheeler'],              sortOrder: 40 },
  // ── Commercial Vehicles ─────────────────────────────────────────────────────
  { name: 'Ashok Leyland',      slug: 'ashok-leyland',   country: 'India',   parentGroup: 'Hinduja Group',   vehicleTypes: ['commercial'],  sortOrder: 50 },
  { name: 'VECV Eicher Trucks', slug: 'vecv-eicher',     country: 'India',   parentGroup: 'VE Commercial Vehicles', vehicleTypes: ['commercial'], sortOrder: 51 },
  { name: 'Piaggio Vehicles India',slug:'piaggio-india', country: 'Italy',   parentGroup: 'Piaggio Group',   vehicleTypes: ['commercial'],  sortOrder: 52 },
  { name: 'BharatBenz',         slug: 'bharatbenz',      country: 'India/Germany', parentGroup: 'Daimler India Commercial Vehicles', vehicleTypes: ['commercial'], sortOrder: 53 },
  { name: 'SML Isuzu',          slug: 'sml-isuzu',       country: 'India',   parentGroup: 'Sumitomo/Isuzu',  vehicleTypes: ['commercial'],  sortOrder: 54 },
  // ── Tractors ────────────────────────────────────────────────────────────────
  { name: 'Sonalika Tractors',  slug: 'sonalika',        country: 'India',   parentGroup: 'International Tractors Ltd', vehicleTypes: ['tractor'], sortOrder: 60 },
  { name: 'TAFE / Massey Ferguson', slug: 'tafe',        country: 'India',   parentGroup: 'TAFE Group',      vehicleTypes: ['tractor'],     sortOrder: 61 },
  { name: 'John Deere India',   slug: 'john-deere',      country: 'USA',     parentGroup: null,               vehicleTypes: ['tractor'],     sortOrder: 62 },
  { name: 'Escorts Kubota',     slug: 'escorts-kubota',  country: 'India',   parentGroup: 'Escorts Group',   vehicleTypes: ['tractor'],     sortOrder: 63 },
  { name: 'New Holland Agriculture', slug: 'new-holland',country: 'USA',     parentGroup: 'CNH Industrial',  vehicleTypes: ['tractor'],     sortOrder: 64 },
  { name: 'Swaraj',             slug: 'swaraj',          country: 'India',   parentGroup: 'Mahindra Group',  vehicleTypes: ['tractor'],     sortOrder: 65 },
  { name: 'Eicher Tractors',    slug: 'eicher-tractors', country: 'India',   parentGroup: 'TAFE Group',      vehicleTypes: ['tractor'],     sortOrder: 66 },
];

// ─────────────────────────────────────────────────────────────────────────────
// MODELS  { mfg, name, slug, vehicleType, bodyType, yearFrom, yearTo }
// yearTo: null = still in production
// ─────────────────────────────────────────────────────────────────────────────
const MODELS = [

  // ════════════════════ MARUTI SUZUKI ════════════════════
  { mfg:'maruti-suzuki', name:'Alto 800',       slug:'alto-800',        vehicleType:'car', bodyType:'hatchback', yearFrom:1983, yearTo:2023 },
  { mfg:'maruti-suzuki', name:'Alto K10',        slug:'alto-k10',        vehicleType:'car', bodyType:'hatchback', yearFrom:2010, yearTo:null },
  { mfg:'maruti-suzuki', name:'WagonR',           slug:'wagonr',          vehicleType:'car', bodyType:'hatchback', yearFrom:1999, yearTo:null },
  { mfg:'maruti-suzuki', name:'Swift',            slug:'swift',           vehicleType:'car', bodyType:'hatchback', yearFrom:2005, yearTo:null },
  { mfg:'maruti-suzuki', name:'Dzire',            slug:'dzire',           vehicleType:'car', bodyType:'sedan',     yearFrom:2008, yearTo:null },
  { mfg:'maruti-suzuki', name:'Baleno',           slug:'baleno',          vehicleType:'car', bodyType:'hatchback', yearFrom:2015, yearTo:null },
  { mfg:'maruti-suzuki', name:'Ertiga',           slug:'ertiga',          vehicleType:'car', bodyType:'mpv',       yearFrom:2012, yearTo:null },
  { mfg:'maruti-suzuki', name:'XL6',              slug:'xl6',             vehicleType:'car', bodyType:'mpv',       yearFrom:2019, yearTo:null },
  { mfg:'maruti-suzuki', name:'Brezza',           slug:'brezza',          vehicleType:'car', bodyType:'suv',       yearFrom:2016, yearTo:null },
  { mfg:'maruti-suzuki', name:'Grand Vitara',     slug:'grand-vitara',    vehicleType:'car', bodyType:'suv',       yearFrom:2022, yearTo:null },
  { mfg:'maruti-suzuki', name:'Fronx',            slug:'fronx',           vehicleType:'car', bodyType:'crossover', yearFrom:2023, yearTo:null },
  { mfg:'maruti-suzuki', name:'Jimny',            slug:'jimny',           vehicleType:'car', bodyType:'suv',       yearFrom:2023, yearTo:null },
  { mfg:'maruti-suzuki', name:'S-Presso',         slug:'s-presso',        vehicleType:'car', bodyType:'hatchback', yearFrom:2019, yearTo:null },
  { mfg:'maruti-suzuki', name:'Celerio',          slug:'celerio',         vehicleType:'car', bodyType:'hatchback', yearFrom:2014, yearTo:null },
  { mfg:'maruti-suzuki', name:'Ignis',            slug:'ignis',           vehicleType:'car', bodyType:'crossover', yearFrom:2017, yearTo:null },
  { mfg:'maruti-suzuki', name:'Ciaz',             slug:'ciaz',            vehicleType:'car', bodyType:'sedan',     yearFrom:2014, yearTo:2023 },
  { mfg:'maruti-suzuki', name:'Eeco',             slug:'eeco',            vehicleType:'car', bodyType:'van',       yearFrom:2010, yearTo:null },
  { mfg:'maruti-suzuki', name:'Omni',             slug:'omni',            vehicleType:'car', bodyType:'van',       yearFrom:1984, yearTo:2019 },
  { mfg:'maruti-suzuki', name:'Gypsy',            slug:'gypsy',           vehicleType:'car', bodyType:'suv',       yearFrom:1985, yearTo:2019 },

  // ════════════════════ HYUNDAI ════════════════════
  { mfg:'hyundai', name:'Santro',            slug:'santro',          vehicleType:'car', bodyType:'hatchback', yearFrom:1998, yearTo:2022 },
  { mfg:'hyundai', name:'Grand i10 Nios',   slug:'grand-i10-nios',  vehicleType:'car', bodyType:'hatchback', yearFrom:2013, yearTo:null },
  { mfg:'hyundai', name:'i20',              slug:'i20',              vehicleType:'car', bodyType:'hatchback', yearFrom:2008, yearTo:null },
  { mfg:'hyundai', name:'Verna',            slug:'verna',            vehicleType:'car', bodyType:'sedan',     yearFrom:2006, yearTo:null },
  { mfg:'hyundai', name:'Creta',            slug:'creta',            vehicleType:'car', bodyType:'suv',       yearFrom:2015, yearTo:null },
  { mfg:'hyundai', name:'Venue',            slug:'venue',            vehicleType:'car', bodyType:'suv',       yearFrom:2019, yearTo:null },
  { mfg:'hyundai', name:'Tucson',           slug:'tucson',           vehicleType:'car', bodyType:'suv',       yearFrom:2016, yearTo:null },
  { mfg:'hyundai', name:'Exter',            slug:'exter',            vehicleType:'car', bodyType:'suv',       yearFrom:2023, yearTo:null },
  { mfg:'hyundai', name:'Aura',             slug:'aura',             vehicleType:'car', bodyType:'sedan',     yearFrom:2020, yearTo:null },
  { mfg:'hyundai', name:'Alcazar',          slug:'alcazar',          vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'hyundai', name:'Ioniq 5',          slug:'ioniq-5',          vehicleType:'car', bodyType:'suv',       yearFrom:2022, yearTo:null },
  { mfg:'hyundai', name:'Kona Electric',    slug:'kona-electric',    vehicleType:'car', bodyType:'suv',       yearFrom:2019, yearTo:null },

  // ════════════════════ TATA MOTORS — Cars ════════════════════
  { mfg:'tata-motors', name:'Indica',       slug:'indica',       vehicleType:'car', bodyType:'hatchback', yearFrom:1998, yearTo:2018 },
  { mfg:'tata-motors', name:'Indigo',       slug:'indigo',       vehicleType:'car', bodyType:'sedan',     yearFrom:2002, yearTo:2018 },
  { mfg:'tata-motors', name:'Nano',         slug:'nano',         vehicleType:'car', bodyType:'hatchback', yearFrom:2008, yearTo:2018 },
  { mfg:'tata-motors', name:'Tiago',        slug:'tiago',        vehicleType:'car', bodyType:'hatchback', yearFrom:2016, yearTo:null },
  { mfg:'tata-motors', name:'Tiago EV',     slug:'tiago-ev',     vehicleType:'car', bodyType:'hatchback', yearFrom:2022, yearTo:null },
  { mfg:'tata-motors', name:'Tigor',        slug:'tigor',        vehicleType:'car', bodyType:'sedan',     yearFrom:2017, yearTo:null },
  { mfg:'tata-motors', name:'Altroz',       slug:'altroz',       vehicleType:'car', bodyType:'hatchback', yearFrom:2020, yearTo:null },
  { mfg:'tata-motors', name:'Nexon',        slug:'nexon',        vehicleType:'car', bodyType:'suv',       yearFrom:2017, yearTo:null },
  { mfg:'tata-motors', name:'Nexon EV',     slug:'nexon-ev',     vehicleType:'car', bodyType:'suv',       yearFrom:2020, yearTo:null },
  { mfg:'tata-motors', name:'Harrier',      slug:'harrier',      vehicleType:'car', bodyType:'suv',       yearFrom:2019, yearTo:null },
  { mfg:'tata-motors', name:'Safari',       slug:'safari',       vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'tata-motors', name:'Punch',        slug:'punch',        vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'tata-motors', name:'Punch EV',     slug:'punch-ev',     vehicleType:'car', bodyType:'suv',       yearFrom:2024, yearTo:null },
  { mfg:'tata-motors', name:'Curvv',        slug:'curvv',        vehicleType:'car', bodyType:'suv',       yearFrom:2024, yearTo:null },
  { mfg:'tata-motors', name:'Curvv EV',     slug:'curvv-ev',     vehicleType:'car', bodyType:'suv',       yearFrom:2024, yearTo:null },
  { mfg:'tata-motors', name:'Sierra EV',    slug:'sierra-ev',    vehicleType:'car', bodyType:'suv',       yearFrom:2025, yearTo:null },
  // Tata Commercial
  { mfg:'tata-motors', name:'Ace',          slug:'ace',          vehicleType:'commercial', bodyType:'mini-truck',  yearFrom:2005, yearTo:null },
  { mfg:'tata-motors', name:'Ace EV',       slug:'ace-ev',       vehicleType:'commercial', bodyType:'mini-truck',  yearFrom:2021, yearTo:null },
  { mfg:'tata-motors', name:'Intra V30',    slug:'intra-v30',    vehicleType:'commercial', bodyType:'mini-truck',  yearFrom:2018, yearTo:null },
  { mfg:'tata-motors', name:'407',          slug:'407',          vehicleType:'commercial', bodyType:'truck',        yearFrom:1986, yearTo:null },
  { mfg:'tata-motors', name:'608',          slug:'608',          vehicleType:'commercial', bodyType:'truck',        yearFrom:2009, yearTo:null },
  { mfg:'tata-motors', name:'712',          slug:'712',          vehicleType:'commercial', bodyType:'truck',        yearFrom:1983, yearTo:null },
  { mfg:'tata-motors', name:'909',          slug:'909',          vehicleType:'commercial', bodyType:'truck',        yearFrom:2015, yearTo:null },
  { mfg:'tata-motors', name:'1109',         slug:'1109',         vehicleType:'commercial', bodyType:'truck',        yearFrom:2018, yearTo:null },
  { mfg:'tata-motors', name:'LPT 1518',     slug:'lpt-1518',     vehicleType:'commercial', bodyType:'truck',        yearFrom:2010, yearTo:null },
  { mfg:'tata-motors', name:'LPT 2518',     slug:'lpt-2518',     vehicleType:'commercial', bodyType:'truck',        yearFrom:2010, yearTo:null },
  { mfg:'tata-motors', name:'Prima 4930',   slug:'prima-4930',   vehicleType:'commercial', bodyType:'truck',        yearFrom:2012, yearTo:null },
  { mfg:'tata-motors', name:'Signa 4923',   slug:'signa-4923',   vehicleType:'commercial', bodyType:'truck',        yearFrom:2016, yearTo:null },
  { mfg:'tata-motors', name:'Winger',       slug:'winger',       vehicleType:'commercial', bodyType:'van',          yearFrom:2007, yearTo:null },
  { mfg:'tata-motors', name:'Magic Express',slug:'magic-express',vehicleType:'commercial', bodyType:'van',          yearFrom:2012, yearTo:null },
  { mfg:'tata-motors', name:'Starbus Ultra',slug:'starbus-ultra',vehicleType:'commercial', bodyType:'bus',          yearFrom:2012, yearTo:null },

  // ════════════════════ MAHINDRA — Cars/SUVs ════════════════════
  { mfg:'mahindra', name:'Thar',            slug:'thar',         vehicleType:'car', bodyType:'suv',   yearFrom:2010, yearTo:null },
  { mfg:'mahindra', name:'Scorpio',         slug:'scorpio',      vehicleType:'car', bodyType:'suv',   yearFrom:2002, yearTo:null },
  { mfg:'mahindra', name:'Scorpio N',       slug:'scorpio-n',    vehicleType:'car', bodyType:'suv',   yearFrom:2022, yearTo:null },
  { mfg:'mahindra', name:'XUV700',          slug:'xuv700',       vehicleType:'car', bodyType:'suv',   yearFrom:2021, yearTo:null },
  { mfg:'mahindra', name:'XUV300',          slug:'xuv300',       vehicleType:'car', bodyType:'suv',   yearFrom:2019, yearTo:null },
  { mfg:'mahindra', name:'XUV400 EV',       slug:'xuv400-ev',    vehicleType:'car', bodyType:'suv',   yearFrom:2023, yearTo:null },
  { mfg:'mahindra', name:'Bolero',          slug:'bolero',       vehicleType:'car', bodyType:'suv',   yearFrom:2000, yearTo:null },
  { mfg:'mahindra', name:'Bolero Neo',      slug:'bolero-neo',   vehicleType:'car', bodyType:'suv',   yearFrom:2021, yearTo:null },
  { mfg:'mahindra', name:'XUV500',          slug:'xuv500',       vehicleType:'car', bodyType:'suv',   yearFrom:2011, yearTo:2021 },
  { mfg:'mahindra', name:'Marazzo',         slug:'marazzo',      vehicleType:'car', bodyType:'mpv',   yearFrom:2018, yearTo:null },
  { mfg:'mahindra', name:'TUV300',          slug:'tuv300',       vehicleType:'car', bodyType:'suv',   yearFrom:2015, yearTo:2021 },
  { mfg:'mahindra', name:'KUV100',          slug:'kuv100',       vehicleType:'car', bodyType:'hatchback', yearFrom:2016, yearTo:null },
  { mfg:'mahindra', name:'Verito',          slug:'verito',       vehicleType:'car', bodyType:'sedan', yearFrom:2010, yearTo:2019 },
  { mfg:'mahindra', name:'BE 6e',           slug:'be-6e',        vehicleType:'car', bodyType:'suv',   yearFrom:2024, yearTo:null },
  { mfg:'mahindra', name:'XEV 9e',          slug:'xev-9e',       vehicleType:'car', bodyType:'suv',   yearFrom:2024, yearTo:null },
  // Mahindra Commercial
  { mfg:'mahindra', name:'Bolero Pickup',   slug:'bolero-pickup',  vehicleType:'commercial', bodyType:'pickup',         yearFrom:2006, yearTo:null },
  { mfg:'mahindra', name:'Bolero Camper',   slug:'bolero-camper',  vehicleType:'commercial', bodyType:'pickup',         yearFrom:2010, yearTo:null },
  { mfg:'mahindra', name:'Supro',           slug:'supro',          vehicleType:'commercial', bodyType:'mini-truck',     yearFrom:2015, yearTo:null },
  { mfg:'mahindra', name:'Jeeto',           slug:'jeeto',          vehicleType:'commercial', bodyType:'mini-truck',     yearFrom:2015, yearTo:null },
  { mfg:'mahindra', name:'Alfa Plus',       slug:'alfa-plus',      vehicleType:'commercial', bodyType:'3-wheeler',      yearFrom:2010, yearTo:null },
  { mfg:'mahindra', name:'Treo EV',         slug:'treo-ev',        vehicleType:'commercial', bodyType:'3-wheeler',      yearFrom:2019, yearTo:null },
  // Mahindra Tractors
  { mfg:'mahindra', name:'245 DI',          slug:'mahindra-245',   vehicleType:'tractor', bodyType:'tractor',  yearFrom:1985, yearTo:null },
  { mfg:'mahindra', name:'265 DI',          slug:'mahindra-265',   vehicleType:'tractor', bodyType:'tractor',  yearFrom:1985, yearTo:null },
  { mfg:'mahindra', name:'415 DI',          slug:'mahindra-415',   vehicleType:'tractor', bodyType:'tractor',  yearFrom:1994, yearTo:null },
  { mfg:'mahindra', name:'475 DI',          slug:'mahindra-475',   vehicleType:'tractor', bodyType:'tractor',  yearFrom:1994, yearTo:null },
  { mfg:'mahindra', name:'575 DI',          slug:'mahindra-575',   vehicleType:'tractor', bodyType:'tractor',  yearFrom:1994, yearTo:null },
  { mfg:'mahindra', name:'605 DI',          slug:'mahindra-605',   vehicleType:'tractor', bodyType:'tractor',  yearFrom:2010, yearTo:null },
  { mfg:'mahindra', name:'Yuvo 415',        slug:'yuvo-415',       vehicleType:'tractor', bodyType:'tractor',  yearFrom:2017, yearTo:null },
  { mfg:'mahindra', name:'Yuvo 575',        slug:'yuvo-575',       vehicleType:'tractor', bodyType:'tractor',  yearFrom:2017, yearTo:null },
  { mfg:'mahindra', name:'Arjun NOVO 605',  slug:'arjun-novo-605', vehicleType:'tractor', bodyType:'tractor',  yearFrom:2015, yearTo:null },
  { mfg:'mahindra', name:'OJA 3140',        slug:'oja-3140',       vehicleType:'tractor', bodyType:'tractor',  yearFrom:2022, yearTo:null },

  // ════════════════════ TOYOTA ════════════════════
  { mfg:'toyota', name:'Innova',            slug:'innova',             vehicleType:'car', bodyType:'mpv',     yearFrom:2004, yearTo:2015 },
  { mfg:'toyota', name:'Innova Crysta',     slug:'innova-crysta',      vehicleType:'car', bodyType:'mpv',     yearFrom:2016, yearTo:null },
  { mfg:'toyota', name:'Innova HyCross',    slug:'innova-hycross',     vehicleType:'car', bodyType:'mpv',     yearFrom:2022, yearTo:null },
  { mfg:'toyota', name:'Fortuner',          slug:'fortuner',           vehicleType:'car', bodyType:'suv',     yearFrom:2009, yearTo:null },
  { mfg:'toyota', name:'Corolla Altis',     slug:'corolla-altis',      vehicleType:'car', bodyType:'sedan',   yearFrom:2003, yearTo:2020 },
  { mfg:'toyota', name:'Glanza',            slug:'glanza',             vehicleType:'car', bodyType:'hatchback',yearFrom:2019, yearTo:null },
  { mfg:'toyota', name:'Urban Cruiser Hyryder', slug:'hyryder',        vehicleType:'car', bodyType:'suv',     yearFrom:2022, yearTo:null },
  { mfg:'toyota', name:'Camry',             slug:'camry',              vehicleType:'car', bodyType:'sedan',   yearFrom:2012, yearTo:null },
  { mfg:'toyota', name:'Yaris',             slug:'yaris',              vehicleType:'car', bodyType:'sedan',   yearFrom:2018, yearTo:2022 },
  { mfg:'toyota', name:'Land Cruiser',      slug:'land-cruiser',       vehicleType:'car', bodyType:'suv',     yearFrom:2000, yearTo:null },
  { mfg:'toyota', name:'Hilux',             slug:'hilux',              vehicleType:'car', bodyType:'pickup',  yearFrom:2021, yearTo:null },
  { mfg:'toyota', name:'Rumion',            slug:'rumion',             vehicleType:'car', bodyType:'mpv',     yearFrom:2023, yearTo:null },

  // ════════════════════ HONDA CARS ════════════════════
  { mfg:'honda-cars', name:'City',          slug:'city',         vehicleType:'car', bodyType:'sedan',     yearFrom:1998, yearTo:null },
  { mfg:'honda-cars', name:'Amaze',         slug:'amaze',        vehicleType:'car', bodyType:'sedan',     yearFrom:2013, yearTo:null },
  { mfg:'honda-cars', name:'Jazz',          slug:'jazz',         vehicleType:'car', bodyType:'hatchback', yearFrom:2009, yearTo:2020 },
  { mfg:'honda-cars', name:'WR-V',          slug:'wrv',          vehicleType:'car', bodyType:'crossover', yearFrom:2017, yearTo:null },
  { mfg:'honda-cars', name:'Elevate',       slug:'elevate',      vehicleType:'car', bodyType:'suv',       yearFrom:2023, yearTo:null },
  { mfg:'honda-cars', name:'BR-V',          slug:'brv',          vehicleType:'car', bodyType:'suv',       yearFrom:2016, yearTo:2020 },

  // ════════════════════ KIA ════════════════════
  { mfg:'kia', name:'Seltos',              slug:'seltos',       vehicleType:'car', bodyType:'suv',  yearFrom:2019, yearTo:null },
  { mfg:'kia', name:'Sonet',              slug:'sonet',        vehicleType:'car', bodyType:'suv',  yearFrom:2020, yearTo:null },
  { mfg:'kia', name:'Carens',             slug:'carens',       vehicleType:'car', bodyType:'mpv',  yearFrom:2022, yearTo:null },
  { mfg:'kia', name:'EV6',               slug:'ev6',          vehicleType:'car', bodyType:'suv',  yearFrom:2022, yearTo:null },
  { mfg:'kia', name:'EV9',               slug:'ev9',          vehicleType:'car', bodyType:'suv',  yearFrom:2024, yearTo:null },

  // ════════════════════ MG MOTOR ════════════════════
  { mfg:'mg-motor', name:'Hector',         slug:'hector',       vehicleType:'car', bodyType:'suv',       yearFrom:2019, yearTo:null },
  { mfg:'mg-motor', name:'Hector Plus',    slug:'hector-plus',  vehicleType:'car', bodyType:'suv',       yearFrom:2020, yearTo:null },
  { mfg:'mg-motor', name:'Astor',          slug:'astor',        vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'mg-motor', name:'Gloster',        slug:'gloster',      vehicleType:'car', bodyType:'suv',       yearFrom:2020, yearTo:null },
  { mfg:'mg-motor', name:'ZS EV',          slug:'zs-ev',        vehicleType:'car', bodyType:'suv',       yearFrom:2020, yearTo:null },
  { mfg:'mg-motor', name:'Comet EV',       slug:'comet-ev',     vehicleType:'car', bodyType:'hatchback', yearFrom:2023, yearTo:null },
  { mfg:'mg-motor', name:'Windsor EV',     slug:'windsor-ev',   vehicleType:'car', bodyType:'suv',       yearFrom:2024, yearTo:null },

  // ════════════════════ SKODA ════════════════════
  { mfg:'skoda', name:'Octavia',           slug:'octavia',  vehicleType:'car', bodyType:'sedan', yearFrom:2001, yearTo:null },
  { mfg:'skoda', name:'Rapid',             slug:'rapid',    vehicleType:'car', bodyType:'sedan', yearFrom:2011, yearTo:2021 },
  { mfg:'skoda', name:'Slavia',            slug:'slavia',   vehicleType:'car', bodyType:'sedan', yearFrom:2022, yearTo:null },
  { mfg:'skoda', name:'Kushaq',            slug:'kushaq',   vehicleType:'car', bodyType:'suv',   yearFrom:2021, yearTo:null },
  { mfg:'skoda', name:'Superb',            slug:'superb',   vehicleType:'car', bodyType:'sedan', yearFrom:2001, yearTo:null },
  { mfg:'skoda', name:'Kodiaq',            slug:'kodiaq',   vehicleType:'car', bodyType:'suv',   yearFrom:2017, yearTo:null },

  // ════════════════════ VOLKSWAGEN ════════════════════
  { mfg:'volkswagen', name:'Polo',         slug:'polo',    vehicleType:'car', bodyType:'hatchback', yearFrom:2010, yearTo:2022 },
  { mfg:'volkswagen', name:'Vento',        slug:'vento',   vehicleType:'car', bodyType:'sedan',     yearFrom:2010, yearTo:2022 },
  { mfg:'volkswagen', name:'Taigun',       slug:'taigun',  vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'volkswagen', name:'Virtus',       slug:'virtus',  vehicleType:'car', bodyType:'sedan',     yearFrom:2022, yearTo:null },
  { mfg:'volkswagen', name:'Tiguan',       slug:'tiguan',  vehicleType:'car', bodyType:'suv',       yearFrom:2017, yearTo:null },

  // ════════════════════ RENAULT ════════════════════
  { mfg:'renault', name:'Kwid',            slug:'kwid',    vehicleType:'car', bodyType:'hatchback', yearFrom:2015, yearTo:null },
  { mfg:'renault', name:'Duster',          slug:'duster',  vehicleType:'car', bodyType:'suv',       yearFrom:2012, yearTo:null },
  { mfg:'renault', name:'Triber',          slug:'triber',  vehicleType:'car', bodyType:'mpv',       yearFrom:2019, yearTo:null },
  { mfg:'renault', name:'Kiger',           slug:'kiger',   vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'renault', name:'Lodgy',           slug:'lodgy',   vehicleType:'car', bodyType:'mpv',       yearFrom:2015, yearTo:2020 },
  { mfg:'renault', name:'Captur',          slug:'captur',  vehicleType:'car', bodyType:'suv',       yearFrom:2017, yearTo:2020 },

  // ════════════════════ NISSAN ════════════════════
  { mfg:'nissan', name:'Micra',            slug:'micra',    vehicleType:'car', bodyType:'hatchback', yearFrom:2010, yearTo:2020 },
  { mfg:'nissan', name:'Sunny',            slug:'sunny',    vehicleType:'car', bodyType:'sedan',     yearFrom:2011, yearTo:2014 },
  { mfg:'nissan', name:'Terrano',          slug:'terrano',  vehicleType:'car', bodyType:'suv',       yearFrom:2013, yearTo:2019 },
  { mfg:'nissan', name:'Kicks',            slug:'kicks',    vehicleType:'car', bodyType:'suv',       yearFrom:2019, yearTo:null },
  { mfg:'nissan', name:'Magnite',          slug:'magnite',  vehicleType:'car', bodyType:'suv',       yearFrom:2020, yearTo:null },

  // ════════════════════ JEEP ════════════════════
  { mfg:'jeep', name:'Compass',            slug:'compass',       vehicleType:'car', bodyType:'suv', yearFrom:2017, yearTo:null },
  { mfg:'jeep', name:'Meridian',           slug:'meridian',      vehicleType:'car', bodyType:'suv', yearFrom:2022, yearTo:null },
  { mfg:'jeep', name:'Wrangler',           slug:'wrangler',      vehicleType:'car', bodyType:'suv', yearFrom:2016, yearTo:null },
  { mfg:'jeep', name:'Grand Cherokee',     slug:'grand-cherokee',vehicleType:'car', bodyType:'suv', yearFrom:2019, yearTo:null },

  // ════════════════════ FORD (discontinued in India) ════════════════════
  { mfg:'ford', name:'Figo',               slug:'figo',       vehicleType:'car', bodyType:'hatchback', yearFrom:2010, yearTo:2021 },
  { mfg:'ford', name:'EcoSport',           slug:'ecosport',   vehicleType:'car', bodyType:'suv',       yearFrom:2013, yearTo:2021 },
  { mfg:'ford', name:'Freestyle',          slug:'freestyle',  vehicleType:'car', bodyType:'crossover', yearFrom:2018, yearTo:2021 },
  { mfg:'ford', name:'Aspire',             slug:'aspire',     vehicleType:'car', bodyType:'sedan',     yearFrom:2015, yearTo:2021 },
  { mfg:'ford', name:'Endeavour',          slug:'endeavour',  vehicleType:'car', bodyType:'suv',       yearFrom:2003, yearTo:2022 },
  { mfg:'ford', name:'Mustang',            slug:'mustang',    vehicleType:'car', bodyType:'coupe',     yearFrom:2016, yearTo:2021 },
  { mfg:'ford', name:'Ikon',               slug:'ikon',       vehicleType:'car', bodyType:'sedan',     yearFrom:2001, yearTo:2011 },

  // ════════════════════ CHEVROLET (discontinued in India 2017) ════════════════════
  { mfg:'chevrolet', name:'Spark',         slug:'spark',       vehicleType:'car', bodyType:'hatchback', yearFrom:2007, yearTo:2017 },
  { mfg:'chevrolet', name:'Beat',          slug:'beat',        vehicleType:'car', bodyType:'hatchback', yearFrom:2010, yearTo:2017 },
  { mfg:'chevrolet', name:'Sail',          slug:'sail',        vehicleType:'car', bodyType:'sedan',     yearFrom:2012, yearTo:2017 },
  { mfg:'chevrolet', name:'Cruze',         slug:'cruze',       vehicleType:'car', bodyType:'sedan',     yearFrom:2009, yearTo:2016 },
  { mfg:'chevrolet', name:'Trailblazer',   slug:'trailblazer', vehicleType:'car', bodyType:'suv',       yearFrom:2012, yearTo:2018 },
  { mfg:'chevrolet', name:'Captiva',       slug:'captiva',     vehicleType:'car', bodyType:'suv',       yearFrom:2008, yearTo:2016 },
  { mfg:'chevrolet', name:'Aveo',          slug:'aveo',        vehicleType:'car', bodyType:'sedan',     yearFrom:2006, yearTo:2010 },
  { mfg:'chevrolet', name:'Optra',         slug:'optra',       vehicleType:'car', bodyType:'sedan',     yearFrom:2003, yearTo:2009 },

  // ════════════════════ BMW ════════════════════
  { mfg:'bmw', name:'3 Series',     slug:'3-series',  vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'bmw', name:'5 Series',     slug:'5-series',  vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'bmw', name:'7 Series',     slug:'7-series',  vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'bmw', name:'X1',           slug:'bmw-x1',    vehicleType:'car', bodyType:'suv',   yearFrom:2010, yearTo:null },
  { mfg:'bmw', name:'X3',           slug:'bmw-x3',    vehicleType:'car', bodyType:'suv',   yearFrom:2010, yearTo:null },
  { mfg:'bmw', name:'X5',           slug:'bmw-x5',    vehicleType:'car', bodyType:'suv',   yearFrom:2000, yearTo:null },
  { mfg:'bmw', name:'X7',           slug:'bmw-x7',    vehicleType:'car', bodyType:'suv',   yearFrom:2019, yearTo:null },

  // ════════════════════ MERCEDES-BENZ ════════════════════
  { mfg:'mercedes-benz', name:'C-Class',    slug:'c-class',  vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'mercedes-benz', name:'E-Class',    slug:'e-class',  vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'mercedes-benz', name:'S-Class',    slug:'s-class',  vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'mercedes-benz', name:'GLA',        slug:'gla',      vehicleType:'car', bodyType:'suv',   yearFrom:2014, yearTo:null },
  { mfg:'mercedes-benz', name:'GLC',        slug:'glc',      vehicleType:'car', bodyType:'suv',   yearFrom:2015, yearTo:null },
  { mfg:'mercedes-benz', name:'GLE',        slug:'gle',      vehicleType:'car', bodyType:'suv',   yearFrom:2015, yearTo:null },
  { mfg:'mercedes-benz', name:'GLS',        slug:'gls',      vehicleType:'car', bodyType:'suv',   yearFrom:2016, yearTo:null },

  // ════════════════════ AUDI ════════════════════
  { mfg:'audi', name:'A4',  slug:'a4',     vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'audi', name:'A6',  slug:'a6',     vehicleType:'car', bodyType:'sedan', yearFrom:2000, yearTo:null },
  { mfg:'audi', name:'Q3',  slug:'q3',     vehicleType:'car', bodyType:'suv',   yearFrom:2012, yearTo:null },
  { mfg:'audi', name:'Q5',  slug:'q5',     vehicleType:'car', bodyType:'suv',   yearFrom:2008, yearTo:null },
  { mfg:'audi', name:'Q7',  slug:'q7',     vehicleType:'car', bodyType:'suv',   yearFrom:2006, yearTo:null },
  { mfg:'audi', name:'e-tron',slug:'e-tron',vehicleType:'car', bodyType:'suv',  yearFrom:2021, yearTo:null },

  // ════════════════════ CITROEN ════════════════════
  { mfg:'citroen', name:'C3',         slug:'c3',         vehicleType:'car', bodyType:'hatchback', yearFrom:2022, yearTo:null },
  { mfg:'citroen', name:'eC3',        slug:'ec3',        vehicleType:'car', bodyType:'hatchback', yearFrom:2023, yearTo:null },
  { mfg:'citroen', name:'C5 Aircross',slug:'c5-aircross',vehicleType:'car', bodyType:'suv',       yearFrom:2021, yearTo:null },
  { mfg:'citroen', name:'Basalt',     slug:'basalt',     vehicleType:'car', bodyType:'suv',       yearFrom:2024, yearTo:null },

  // ════════════════════ ISUZU ════════════════════
  { mfg:'isuzu', name:'D-Max V-Cross',slug:'d-max-v-cross', vehicleType:'car', bodyType:'pickup', yearFrom:2016, yearTo:null },
  { mfg:'isuzu', name:'MU-X',         slug:'mu-x',          vehicleType:'car', bodyType:'suv',    yearFrom:2020, yearTo:null },

  // ════════════════════ DATSUN (discontinued) ════════════════════
  { mfg:'datsun', name:'Go',          slug:'datsun-go',     vehicleType:'car', bodyType:'hatchback', yearFrom:2014, yearTo:2022 },
  { mfg:'datsun', name:'Go+',         slug:'datsun-go-plus',vehicleType:'car', bodyType:'mpv',       yearFrom:2015, yearTo:2022 },
  { mfg:'datsun', name:'Redi-Go',     slug:'redi-go',       vehicleType:'car', bodyType:'hatchback', yearFrom:2016, yearTo:2022 },

  // ════════════════════ FORCE MOTORS ════════════════════
  { mfg:'force-motors', name:'Gurkha',        slug:'gurkha',         vehicleType:'car',        bodyType:'suv',      yearFrom:2010, yearTo:null },
  { mfg:'force-motors', name:'Traveller 3700',slug:'traveller-3700', vehicleType:'commercial', bodyType:'van',      yearFrom:1991, yearTo:null },
  { mfg:'force-motors', name:'Traveller 17',  slug:'traveller-17',   vehicleType:'commercial', bodyType:'van',      yearFrom:2010, yearTo:null },
  { mfg:'force-motors', name:'Trax Toofan',   slug:'trax-toofan',    vehicleType:'commercial', bodyType:'van',      yearFrom:2015, yearTo:null },
  { mfg:'force-motors', name:'Trump 40',      slug:'trump-40',       vehicleType:'commercial', bodyType:'truck',    yearFrom:2016, yearTo:null },

  // ════════════════════ HERO MOTOCORP ════════════════════
  { mfg:'hero-motocorp', name:'HF 100',           slug:'hf-100',         vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2023, yearTo:null },
  { mfg:'hero-motocorp', name:'HF Deluxe',         slug:'hf-deluxe',      vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2001, yearTo:null },
  { mfg:'hero-motocorp', name:'Splendor Plus',     slug:'splendor-plus',  vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:1994, yearTo:null },
  { mfg:'hero-motocorp', name:'Splendor iSmart',   slug:'splendor-ismart',vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2014, yearTo:null },
  { mfg:'hero-motocorp', name:'Super Splendor',    slug:'super-splendor', vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2002, yearTo:null },
  { mfg:'hero-motocorp', name:'Passion Pro',       slug:'passion-pro',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2001, yearTo:null },
  { mfg:'hero-motocorp', name:'Glamour',           slug:'glamour',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2005, yearTo:null },
  { mfg:'hero-motocorp', name:'Xtreme 125R',       slug:'xtreme-125r',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2023, yearTo:null },
  { mfg:'hero-motocorp', name:'Xtreme 160R',       slug:'xtreme-160r',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2020, yearTo:null },
  { mfg:'hero-motocorp', name:'XPulse 200',        slug:'xpulse-200',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'hero-motocorp', name:'XPulse 200T',       slug:'xpulse-200t',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2020, yearTo:null },
  { mfg:'hero-motocorp', name:'Maestro Edge 110',  slug:'maestro-edge-110', vehicleType:'2wheeler', bodyType:'scooter',  yearFrom:2012, yearTo:null },
  { mfg:'hero-motocorp', name:'Maestro Edge 125',  slug:'maestro-edge-125', vehicleType:'2wheeler', bodyType:'scooter',  yearFrom:2016, yearTo:null },
  { mfg:'hero-motocorp', name:'Pleasure Plus',     slug:'pleasure-plus',  vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2018, yearTo:null },
  { mfg:'hero-motocorp', name:'Destini 125',       slug:'destini-125',    vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2018, yearTo:null },
  { mfg:'hero-motocorp', name:'Xoom 110',          slug:'xoom-110',       vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2023, yearTo:null },

  // ════════════════════ BAJAJ AUTO ════════════════════
  { mfg:'bajaj-auto', name:'CT 100',          slug:'ct-100',         vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2000, yearTo:null },
  { mfg:'bajaj-auto', name:'CT 110',          slug:'ct-110',         vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2017, yearTo:null },
  { mfg:'bajaj-auto', name:'Platina 100',     slug:'platina-100',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2006, yearTo:null },
  { mfg:'bajaj-auto', name:'Platina 110 H-Gear', slug:'platina-110', vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'bajaj-auto', name:'Discover 110',    slug:'discover-110',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2004, yearTo:null },
  { mfg:'bajaj-auto', name:'Discover 125',    slug:'discover-125',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2012, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar 125',      slug:'pulsar-125',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar 150',      slug:'pulsar-150',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2001, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar 180',      slug:'pulsar-180',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2001, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar 200NS',    slug:'pulsar-200ns',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2012, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar 220F',     slug:'pulsar-220f',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2007, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar RS200',    slug:'pulsar-rs200',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2015, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar N250',     slug:'pulsar-n250',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },
  { mfg:'bajaj-auto', name:'Pulsar F250',     slug:'pulsar-f250',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },
  { mfg:'bajaj-auto', name:'Dominar 250',     slug:'dominar-250',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'bajaj-auto', name:'Dominar 400',     slug:'dominar-400',    vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2017, yearTo:null },
  { mfg:'bajaj-auto', name:'Avenger Street 220', slug:'avenger-220', vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2005, yearTo:null },
  { mfg:'bajaj-auto', name:'Chetak EV',       slug:'chetak-ev',      vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2020, yearTo:null },
  // Bajaj 3-wheelers
  { mfg:'bajaj-auto', name:'RE Compact',      slug:'re-compact',     vehicleType:'commercial', bodyType:'3-wheeler', yearFrom:1960, yearTo:null },
  { mfg:'bajaj-auto', name:'RE Maxima',       slug:'re-maxima',      vehicleType:'commercial', bodyType:'3-wheeler', yearFrom:2010, yearTo:null },
  { mfg:'bajaj-auto', name:'Maxima Cargo',    slug:'maxima-cargo',   vehicleType:'commercial', bodyType:'3-wheeler', yearFrom:2012, yearTo:null },

  // ════════════════════ TVS MOTOR ════════════════════
  { mfg:'tvs-motor', name:'XL100',            slug:'xl100',           vehicleType:'2wheeler', bodyType:'moped',      yearFrom:1975, yearTo:null },
  { mfg:'tvs-motor', name:'Star City+',       slug:'star-city-plus',  vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2006, yearTo:null },
  { mfg:'tvs-motor', name:'Sport',            slug:'tvs-sport',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2009, yearTo:null },
  { mfg:'tvs-motor', name:'Raider 125',       slug:'raider-125',      vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },
  { mfg:'tvs-motor', name:'Radeon 110',       slug:'radeon-110',      vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2018, yearTo:null },
  { mfg:'tvs-motor', name:'Ronin 225',        slug:'ronin-225',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2022, yearTo:null },
  { mfg:'tvs-motor', name:'Apache RTR 160',   slug:'apache-rtr-160',  vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2011, yearTo:null },
  { mfg:'tvs-motor', name:'Apache RTR 180',   slug:'apache-rtr-180',  vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2010, yearTo:null },
  { mfg:'tvs-motor', name:'Apache RTR 200 4V',slug:'apache-rtr-200',  vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2016, yearTo:null },
  { mfg:'tvs-motor', name:'Apache RR 310',    slug:'apache-rr-310',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2017, yearTo:null },
  { mfg:'tvs-motor', name:'Jupiter 110',      slug:'jupiter-110',     vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2013, yearTo:null },
  { mfg:'tvs-motor', name:'Jupiter 125',      slug:'jupiter-125',     vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2021, yearTo:null },
  { mfg:'tvs-motor', name:'Ntorq 125',        slug:'ntorq-125',       vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2018, yearTo:null },
  { mfg:'tvs-motor', name:'Zest 110',         slug:'zest-110',        vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2014, yearTo:null },
  { mfg:'tvs-motor', name:'iQube Electric',   slug:'iqube-electric',  vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2020, yearTo:null },

  // ════════════════════ HONDA MOTORCYCLES (HMSI) ════════════════════
  { mfg:'honda-motorcycles', name:'Activa 110',    slug:'activa-110',    vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2001, yearTo:null },
  { mfg:'honda-motorcycles', name:'Activa 125',    slug:'activa-125',    vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2012, yearTo:null },
  { mfg:'honda-motorcycles', name:'Activa 6G',     slug:'activa-6g',     vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2019, yearTo:2023 },
  { mfg:'honda-motorcycles', name:'Dio 110',       slug:'dio-110',       vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2002, yearTo:null },
  { mfg:'honda-motorcycles', name:'Grazia 125',    slug:'grazia-125',    vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2018, yearTo:null },
  { mfg:'honda-motorcycles', name:'Shine 100',     slug:'shine-100',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2022, yearTo:null },
  { mfg:'honda-motorcycles', name:'Shine 125',     slug:'shine-125',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2006, yearTo:null },
  { mfg:'honda-motorcycles', name:'SP 125',        slug:'sp-125',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'honda-motorcycles', name:'Unicorn',       slug:'unicorn',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2004, yearTo:null },
  { mfg:'honda-motorcycles', name:'Hornet 2.0',    slug:'hornet-2',      vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2020, yearTo:null },
  { mfg:'honda-motorcycles', name:'CB300R',        slug:'cb300r',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'honda-motorcycles', name:'CB350',         slug:'cb350',         vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2020, yearTo:null },
  { mfg:'honda-motorcycles', name:'CB350RS',       slug:'cb350rs',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },
  { mfg:'honda-motorcycles', name:'CBR150R',       slug:'cbr150r',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2013, yearTo:null },

  // ════════════════════ ROYAL ENFIELD ════════════════════
  { mfg:'royal-enfield', name:'Bullet 350',        slug:'bullet-350',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:1955, yearTo:null },
  { mfg:'royal-enfield', name:'Bullet 500',        slug:'bullet-500',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:1955, yearTo:2019 },
  { mfg:'royal-enfield', name:'Classic 350',       slug:'classic-350',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2009, yearTo:null },
  { mfg:'royal-enfield', name:'Meteor 350',        slug:'meteor-350',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2020, yearTo:null },
  { mfg:'royal-enfield', name:'Hunter 350',        slug:'hunter-350',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2022, yearTo:null },
  { mfg:'royal-enfield', name:'Himalayan 411',     slug:'himalayan-411',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2016, yearTo:null },
  { mfg:'royal-enfield', name:'Himalayan 450',     slug:'himalayan-450',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2023, yearTo:null },
  { mfg:'royal-enfield', name:'Scram 411',         slug:'scram-411',         vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2022, yearTo:null },
  { mfg:'royal-enfield', name:'Super Meteor 650',  slug:'super-meteor-650',  vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2023, yearTo:null },
  { mfg:'royal-enfield', name:'Interceptor 650',   slug:'interceptor-650',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2018, yearTo:null },
  { mfg:'royal-enfield', name:'Continental GT 650',slug:'continental-gt-650',vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2018, yearTo:null },
  { mfg:'royal-enfield', name:'Thunderbird 350',   slug:'thunderbird-350',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2002, yearTo:2020 },

  // ════════════════════ YAMAHA ════════════════════
  { mfg:'yamaha', name:'FZ 25',        slug:'fz-25',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2017, yearTo:null },
  { mfg:'yamaha', name:'FZS-FI',       slug:'fzs-fi',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2012, yearTo:null },
  { mfg:'yamaha', name:'FZ-S V3',      slug:'fz-s-v3',      vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'yamaha', name:'MT-15',        slug:'mt-15',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'yamaha', name:'R15 V4',       slug:'r15-v4',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },
  { mfg:'yamaha', name:'R15 V3',       slug:'r15-v3',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2017, yearTo:2021 },
  { mfg:'yamaha', name:'MT-03',        slug:'mt-03',        vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2020, yearTo:null },
  { mfg:'yamaha', name:'YZF-R3',       slug:'yzf-r3',       vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2015, yearTo:null },
  { mfg:'yamaha', name:'Aerox 155',    slug:'aerox-155',    vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2021, yearTo:null },
  { mfg:'yamaha', name:'Ray ZR 125',   slug:'ray-zr-125',   vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2017, yearTo:null },
  { mfg:'yamaha', name:'Fascino 125',  slug:'fascino-125',  vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2015, yearTo:null },

  // ════════════════════ SUZUKI MOTORCYCLES ════════════════════
  { mfg:'suzuki-motorcycles', name:'Access 125',        slug:'access-125',   vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2007, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Burgman Street 125',slug:'burgman-125',  vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2018, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Avenis 125',        slug:'avenis-125',   vehicleType:'2wheeler', bodyType:'scooter',   yearFrom:2021, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Gixxer SF 150',     slug:'gixxer-sf-150',vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2014, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Gixxer 150',        slug:'gixxer-150',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2014, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Gixxer SF 250',     slug:'gixxer-sf-250',vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Gixxer 250',        slug:'gixxer-250',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'V-Strom SX',        slug:'v-strom-sx',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2022, yearTo:null },
  { mfg:'suzuki-motorcycles', name:'Hayabusa',          slug:'hayabusa',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },

  // ════════════════════ KTM ════════════════════
  { mfg:'ktm', name:'125 Duke',        slug:'125-duke',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2018, yearTo:null },
  { mfg:'ktm', name:'200 Duke',        slug:'200-duke',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2012, yearTo:null },
  { mfg:'ktm', name:'250 Duke',        slug:'250-duke',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2017, yearTo:null },
  { mfg:'ktm', name:'390 Duke',        slug:'390-duke',   vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2013, yearTo:null },
  { mfg:'ktm', name:'250 Adventure',   slug:'250-adventure',vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2021, yearTo:null },
  { mfg:'ktm', name:'390 Adventure',   slug:'390-adventure',vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'ktm', name:'RC 125',          slug:'rc-125',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2014, yearTo:null },
  { mfg:'ktm', name:'RC 200',          slug:'rc-200',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2014, yearTo:null },
  { mfg:'ktm', name:'RC 390',          slug:'rc-390',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2014, yearTo:null },

  // ════════════════════ OLA ELECTRIC ════════════════════
  { mfg:'ola-electric', name:'S1 Air',   slug:'s1-air',  vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2023, yearTo:null },
  { mfg:'ola-electric', name:'S1',       slug:'s1',      vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2021, yearTo:null },
  { mfg:'ola-electric', name:'S1 Pro',   slug:'s1-pro',  vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2021, yearTo:null },
  { mfg:'ola-electric', name:'S1 X',     slug:'s1-x',    vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2023, yearTo:null },
  { mfg:'ola-electric', name:'S1 X+',    slug:'s1-x-plus',vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2023, yearTo:null },

  // ════════════════════ ATHER ENERGY ════════════════════
  { mfg:'ather-energy', name:'450X',  slug:'450x',  vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2018, yearTo:null },
  { mfg:'ather-energy', name:'450S',  slug:'450s',  vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2022, yearTo:null },
  { mfg:'ather-energy', name:'Rizta', slug:'rizta', vehicleType:'2wheeler', bodyType:'scooter', yearFrom:2024, yearTo:null },

  // ════════════════════ REVOLT ════════════════════
  { mfg:'revolt', name:'RV400',        slug:'rv400',     vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2019, yearTo:null },
  { mfg:'revolt', name:'RV400 BRZ',    slug:'rv400-brz', vehicleType:'2wheeler', bodyType:'motorcycle', yearFrom:2023, yearTo:null },

  // ════════════════════ ASHOK LEYLAND ════════════════════
  { mfg:'ashok-leyland', name:'Dost',          slug:'dost',          vehicleType:'commercial', bodyType:'truck',  yearFrom:2011, yearTo:null },
  { mfg:'ashok-leyland', name:'Dost+',         slug:'dost-plus',     vehicleType:'commercial', bodyType:'truck',  yearFrom:2017, yearTo:null },
  { mfg:'ashok-leyland', name:'Partner',       slug:'partner',       vehicleType:'commercial', bodyType:'truck',  yearFrom:2014, yearTo:null },
  { mfg:'ashok-leyland', name:'Boss 1315',     slug:'boss-1315',     vehicleType:'commercial', bodyType:'truck',  yearFrom:2019, yearTo:null },
  { mfg:'ashok-leyland', name:'Ecomet 1015',   slug:'ecomet-1015',   vehicleType:'commercial', bodyType:'truck',  yearFrom:2015, yearTo:null },
  { mfg:'ashok-leyland', name:'Captain 2820',  slug:'captain-2820',  vehicleType:'commercial', bodyType:'truck',  yearFrom:2014, yearTo:null },
  { mfg:'ashok-leyland', name:'U-Truck 3118',  slug:'u-truck-3118',  vehicleType:'commercial', bodyType:'truck',  yearFrom:2014, yearTo:null },
  { mfg:'ashok-leyland', name:'Lynx Bus',      slug:'lynx-bus',      vehicleType:'commercial', bodyType:'bus',    yearFrom:2014, yearTo:null },
  { mfg:'ashok-leyland', name:'Jan Bus',       slug:'jan-bus',       vehicleType:'commercial', bodyType:'bus',    yearFrom:2002, yearTo:null },
  { mfg:'ashok-leyland', name:'Viking Bus',    slug:'viking-bus',    vehicleType:'commercial', bodyType:'bus',    yearFrom:1986, yearTo:null },

  // ════════════════════ VECV EICHER TRUCKS ════════════════════
  { mfg:'vecv-eicher', name:'Eicher Pro 1049', slug:'eicher-pro-1049',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },
  { mfg:'vecv-eicher', name:'Eicher Pro 2049', slug:'eicher-pro-2049',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },
  { mfg:'vecv-eicher', name:'Eicher Pro 2059', slug:'eicher-pro-2059',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },
  { mfg:'vecv-eicher', name:'Eicher Pro 3008', slug:'eicher-pro-3008',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },
  { mfg:'vecv-eicher', name:'Eicher Pro 3016', slug:'eicher-pro-3016',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },
  { mfg:'vecv-eicher', name:'Eicher Pro 6016', slug:'eicher-pro-6016',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },
  { mfg:'vecv-eicher', name:'Eicher Pro 8016', slug:'eicher-pro-8016',vehicleType:'commercial', bodyType:'truck', yearFrom:2014, yearTo:null },

  // ════════════════════ PIAGGIO INDIA ════════════════════
  { mfg:'piaggio-india', name:'Ape City Plus', slug:'ape-city-plus', vehicleType:'commercial', bodyType:'3-wheeler', yearFrom:1999, yearTo:null },
  { mfg:'piaggio-india', name:'Ape HT',        slug:'ape-ht',        vehicleType:'commercial', bodyType:'3-wheeler', yearFrom:2013, yearTo:null },
  { mfg:'piaggio-india', name:'Porter 700',    slug:'porter-700',    vehicleType:'commercial', bodyType:'mini-truck',yearFrom:2011, yearTo:null },
  { mfg:'piaggio-india', name:'Porter 1000',   slug:'porter-1000',   vehicleType:'commercial', bodyType:'mini-truck',yearFrom:2016, yearTo:null },

  // ════════════════════ BHARATBENZ ════════════════════
  { mfg:'bharatbenz', name:'914',  slug:'bharatbenz-914',  vehicleType:'commercial', bodyType:'truck', yearFrom:2012, yearTo:null },
  { mfg:'bharatbenz', name:'1217', slug:'bharatbenz-1217', vehicleType:'commercial', bodyType:'truck', yearFrom:2012, yearTo:null },
  { mfg:'bharatbenz', name:'2528', slug:'bharatbenz-2528', vehicleType:'commercial', bodyType:'truck', yearFrom:2012, yearTo:null },
  { mfg:'bharatbenz', name:'4028', slug:'bharatbenz-4028', vehicleType:'commercial', bodyType:'truck', yearFrom:2016, yearTo:null },

  // ════════════════════ SML ISUZU ════════════════════
  { mfg:'sml-isuzu', name:'Samrat GS',     slug:'samrat-gs',     vehicleType:'commercial', bodyType:'truck', yearFrom:2010, yearTo:null },
  { mfg:'sml-isuzu', name:'Super GS 7.2',  slug:'super-gs-7',    vehicleType:'commercial', bodyType:'truck', yearFrom:2012, yearTo:null },

  // ════════════════════ SONALIKA TRACTORS ════════════════════
  { mfg:'sonalika', name:'DI 35',       slug:'di-35',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'sonalika', name:'DI 42',       slug:'di-42',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'sonalika', name:'DI 47',       slug:'di-47',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'sonalika', name:'DI 50',       slug:'di-50',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'sonalika', name:'DI 60',       slug:'di-60',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'sonalika', name:'GT 20',       slug:'gt-20',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
  { mfg:'sonalika', name:'GT 35',       slug:'gt-35',       vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
  { mfg:'sonalika', name:'Worldtrac 90',slug:'worldtrac-90',vehicleType:'tractor', bodyType:'tractor', yearFrom:2015, yearTo:null },

  // ════════════════════ TAFE / MASSEY FERGUSON ════════════════════
  { mfg:'tafe', name:'MF 241 DI',    slug:'mf-241',    vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'tafe', name:'MF 1035',      slug:'mf-1035',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'tafe', name:'MF 5118',      slug:'mf-5118',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
  { mfg:'tafe', name:'MF 7235',      slug:'mf-7235',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2012, yearTo:null },
  { mfg:'tafe', name:'TAFE 35 DI',   slug:'tafe-35',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'tafe', name:'TAFE 45 DI',   slug:'tafe-45',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },

  // ════════════════════ JOHN DEERE ════════════════════
  { mfg:'john-deere', name:'3028E',   slug:'3028e',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2014, yearTo:null },
  { mfg:'john-deere', name:'5050D',   slug:'5050d',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2003, yearTo:null },
  { mfg:'john-deere', name:'5060E',   slug:'5060e',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
  { mfg:'john-deere', name:'5065E',   slug:'5065e',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2012, yearTo:null },
  { mfg:'john-deere', name:'5075E',   slug:'5075e',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2012, yearTo:null },
  { mfg:'john-deere', name:'5105',    slug:'5105',    vehicleType:'tractor', bodyType:'tractor', yearFrom:2005, yearTo:null },
  { mfg:'john-deere', name:'5310',    slug:'5310',    vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },

  // ════════════════════ ESCORTS KUBOTA ════════════════════
  { mfg:'escorts-kubota', name:'Farmtrac 45',   slug:'farmtrac-45',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2005, yearTo:null },
  { mfg:'escorts-kubota', name:'Farmtrac 60',   slug:'farmtrac-60',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2005, yearTo:null },
  { mfg:'escorts-kubota', name:'Powertrac 439', slug:'powertrac-439', vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'escorts-kubota', name:'Powertrac 445', slug:'powertrac-445', vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'escorts-kubota', name:'Digitrac 50',   slug:'digitrac-50',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2021, yearTo:null },

  // ════════════════════ NEW HOLLAND ════════════════════
  { mfg:'new-holland', name:'3230 NX',    slug:'3230-nx',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'new-holland', name:'3600-2 TX',  slug:'3600-2-tx', vehicleType:'tractor', bodyType:'tractor', yearFrom:2005, yearTo:null },
  { mfg:'new-holland', name:'3630 TX+',   slug:'3630-tx',   vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
  { mfg:'new-holland', name:'Excel 4710', slug:'excel-4710',vehicleType:'tractor', bodyType:'tractor', yearFrom:2013, yearTo:null },
  { mfg:'new-holland', name:'T4.90',      slug:'t4-90',     vehicleType:'tractor', bodyType:'tractor', yearFrom:2018, yearTo:null },

  // ════════════════════ SWARAJ ════════════════════
  { mfg:'swaraj', name:'724 FE',  slug:'swaraj-724',  vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'swaraj', name:'735 XT',  slug:'swaraj-735',  vehicleType:'tractor', bodyType:'tractor', yearFrom:2005, yearTo:null },
  { mfg:'swaraj', name:'744 XT',  slug:'swaraj-744',  vehicleType:'tractor', bodyType:'tractor', yearFrom:2005, yearTo:null },
  { mfg:'swaraj', name:'855 XT',  slug:'swaraj-855',  vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
  { mfg:'swaraj', name:'963 FE',  slug:'swaraj-963',  vehicleType:'tractor', bodyType:'tractor', yearFrom:2012, yearTo:null },

  // ════════════════════ EICHER TRACTORS ════════════════════
  { mfg:'eicher-tractors', name:'241',  slug:'eicher-241', vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'eicher-tractors', name:'333',  slug:'eicher-333', vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'eicher-tractors', name:'380',  slug:'eicher-380', vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'eicher-tractors', name:'485',  slug:'eicher-485', vehicleType:'tractor', bodyType:'tractor', yearFrom:2000, yearTo:null },
  { mfg:'eicher-tractors', name:'557',  slug:'eicher-557', vehicleType:'tractor', bodyType:'tractor', yearFrom:2010, yearTo:null },
];

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚗 Seeding Indian vehicle database...\n');

  // ── Step 1: Upsert manufacturers ────────────────────────────────────────────
  console.log(`  Upserting ${MANUFACTURERS.length} manufacturers...`);
  const mfgMap = {}; // slug → manufacturerId
  for (const m of MANUFACTURERS) {
    const rec = await prisma.vehicleManufacturer.upsert({
      where:  { slug: m.slug },
      update: { name: m.name, parentGroup: m.parentGroup, country: m.country, vehicleTypes: m.vehicleTypes, sortOrder: m.sortOrder },
      create: { name: m.name, slug: m.slug, parentGroup: m.parentGroup, country: m.country, vehicleTypes: m.vehicleTypes, sortOrder: m.sortOrder },
    });
    mfgMap[m.slug] = rec.manufacturerId;
  }
  console.log(`  ✅ Manufacturers done.\n`);

  // ── Step 2: Upsert models ───────────────────────────────────────────────────
  console.log(`  Upserting ${MODELS.length} models...`);
  let modelCount = 0;
  for (const m of MODELS) {
    const manufacturerId = mfgMap[m.mfg];
    if (!manufacturerId) {
      console.warn(`  ⚠️  Skipping model "${m.name}" — manufacturer slug "${m.mfg}" not found`);
      continue;
    }
    await prisma.vehicleModel.upsert({
      where:  { manufacturerId_name: { manufacturerId, name: m.name } },
      update: { slug: m.slug, vehicleType: m.vehicleType, bodyType: m.bodyType, yearFrom: m.yearFrom, yearTo: m.yearTo, sortOrder: m.sortOrder || 0 },
      create: { manufacturerId, name: m.name, slug: m.slug, vehicleType: m.vehicleType, bodyType: m.bodyType, yearFrom: m.yearFrom, yearTo: m.yearTo, sortOrder: m.sortOrder || 0 },
    });
    modelCount++;
  }
  console.log(`  ✅ ${modelCount} models done.\n`);

  // ── Step 3: Create base Vehicle rows (one per model — covers full year range) ─
  // These rows are used for PartFitment. One base row per model lets shops add
  // fitments immediately without needing a year-specific row.
  console.log('  Creating base Vehicle rows for fitment...');
  const allModels = await prisma.vehicleModel.findMany({
    include: { manufacturer: true },
  });

  let vehicleCount = 0;
  for (const model of allModels) {
    const existing = await prisma.vehicle.findFirst({
      where: {
        make: model.manufacturer.name,
        model: model.name,
        variant: null,
        yearFrom: model.yearFrom,
        modelId: model.modelId,
      },
    });
    if (!existing) {
      await prisma.vehicle.create({
        data: {
          make:          model.manufacturer.name,
          model:         model.name,
          variant:       null,
          yearFrom:      model.yearFrom,
          yearTo:        model.yearTo,
          vehicleType:   model.vehicleType,
          bodyType:      model.bodyType,
          modelId:       model.modelId,
        },
      });
      vehicleCount++;
    }
  }
  console.log(`  ✅ ${vehicleCount} new Vehicle rows created.\n`);

  const totalMfg    = await prisma.vehicleManufacturer.count();
  const totalModels = await prisma.vehicleModel.count();
  const totalVeh    = await prisma.vehicle.count();

  console.log('═══════════════════════════════════════');
  console.log('  Seed complete!');
  console.log(`  Manufacturers : ${totalMfg}`);
  console.log(`  Models        : ${totalModels}`);
  console.log(`  Vehicle rows  : ${totalVeh}`);
  console.log('═══════════════════════════════════════\n');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
