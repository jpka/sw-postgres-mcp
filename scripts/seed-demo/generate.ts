/**
 * Pure, DB-free generation of the synthetic e-commerce demo dataset
 * (issue #10). No I/O here on purpose: scripts/seed-demo.ts owns the
 * database connection and inserts; this module just builds the in-memory
 * rows so the generation logic can be unit-tested without Postgres.
 *
 * Row-count design (default seed, ~208k rows total):
 *   - products:     2,000
 *   - customers:    50,000  (40,000 inactive / last_login before 2025,
 *                            10,000 active)
 *   - orders:       60,000  (status counts are fixed exactly, see
 *                            ORDER_STATUS_COUNTS below; `status = 'cancelled'`
 *                            alone is 13,200 rows > the 10,000 hard cap)
 *   - order_items:  ~96,000 (1-4 items/order via seeded weighted choice)
 *
 * Test tenant: customers 1-8 (TEST_TENANT_CUSTOMER_COUNT) are flagged
 * segment='test_tenant' and always inactive; between them they place
 * TEST_TENANT_ORDER_COUNT (320) orders, a low-hundreds group isolable with
 * `WHERE segment = 'test_tenant'` (joined from customers) or
 * `WHERE customer_id IN (1,2,...,8)`.
 *
 * A fixed reference date (not the real "now") is used for all "recent"
 * bounds so the same seed produces byte-identical output regardless of
 * which day the generator actually runs.
 */

import {
  mulberry32,
  randomInt,
  randomFloat,
  choice,
  weightedIndex,
  shuffle,
  randomDateBetween,
  type Rng,
} from "./prng.js";

export const DEMO_REFERENCE_DATE = new Date("2026-08-13T00:00:00Z");

export const PRODUCT_COUNT = 2_000;
export const CUSTOMER_COUNT = 50_000;
export const INACTIVE_CUSTOMER_COUNT = 40_000;
export const ACTIVE_CUSTOMER_COUNT = CUSTOMER_COUNT - INACTIVE_CUSTOMER_COUNT;
export const TEST_TENANT_CUSTOMER_COUNT = 8;
export const TEST_TENANT_ORDERS_PER_CUSTOMER = 40;
export const TEST_TENANT_ORDER_COUNT =
  TEST_TENANT_CUSTOMER_COUNT * TEST_TENANT_ORDERS_PER_CUSTOMER; // 320

export const ORDER_COUNT = 60_000;

export const ORDER_STATUSES = [
  "pending",
  "paid",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Exact per-status counts across all 60,000 orders. Sum must equal ORDER_COUNT. */
export const ORDER_STATUS_COUNTS: Record<OrderStatus, number> = {
  delivered: 24_000,
  shipped: 9_000,
  paid: 6_000,
  pending: 4_800,
  cancelled: 13_200, // > 10,000: the single-status hard-cap-busting group
  refunded: 3_000,
};

const ORDER_STATUS_COUNT_SUM = Object.values(ORDER_STATUS_COUNTS).reduce(
  (a, b) => a + b,
  0,
);
if (ORDER_STATUS_COUNT_SUM !== ORDER_COUNT) {
  throw new Error(
    `ORDER_STATUS_COUNTS must sum to ORDER_COUNT (${ORDER_COUNT}), got ${ORDER_STATUS_COUNT_SUM}`,
  );
}

// [itemCount, relativeWeight] pairs. Average ~1.6 items/order -> ~96k order_items.
const ORDER_ITEM_COUNT_WEIGHTS: Array<[count: number, weight: number]> = [
  [1, 60],
  [2, 25],
  [3, 10],
  [4, 5],
];

const CATEGORIES = [
  "Electronics",
  "Home & Kitchen",
  "Books",
  "Clothing",
  "Sports & Outdoors",
  "Beauty",
  "Toys & Games",
  "Automotive",
  "Grocery",
  "Office Supplies",
  "Pet Supplies",
  "Health",
] as const;

const PRODUCT_ADJECTIVES = [
  "Wireless",
  "Compact",
  "Premium",
  "Portable",
  "Eco-Friendly",
  "Heavy-Duty",
  "Ultra-Light",
  "Classic",
  "Deluxe",
  "Everyday",
  "Pro",
  "Essential",
];

const PRODUCT_NOUNS: Record<(typeof CATEGORIES)[number], string[]> = {
  Electronics: ["Headphones", "Charger", "Speaker", "Webcam", "Router", "Monitor"],
  "Home & Kitchen": ["Blender", "Cookware Set", "Toaster", "Lamp", "Storage Bin", "Kettle"],
  Books: ["Novel", "Cookbook", "Journal", "Field Guide", "Biography", "Notebook"],
  Clothing: ["T-Shirt", "Jacket", "Hoodie", "Socks", "Beanie", "Jeans"],
  "Sports & Outdoors": ["Water Bottle", "Yoga Mat", "Tent", "Backpack", "Bike Helmet", "Cooler"],
  Beauty: ["Moisturizer", "Shampoo", "Lip Balm", "Sunscreen", "Face Mask", "Body Wash"],
  "Toys & Games": ["Puzzle", "Board Game", "Building Blocks", "Action Figure", "Card Game", "Plush Toy"],
  Automotive: ["Phone Mount", "Floor Mats", "Jump Starter", "Tire Gauge", "Seat Cover", "Dash Cam"],
  Grocery: ["Coffee Beans", "Granola", "Olive Oil", "Tea Sampler", "Trail Mix", "Hot Sauce"],
  "Office Supplies": ["Desk Organizer", "Stapler", "Notebook Set", "Whiteboard", "Pen Pack", "Monitor Stand"],
  "Pet Supplies": ["Dog Leash", "Cat Tree", "Pet Bed", "Chew Toy", "Feeding Bowl", "Litter Box"],
  Health: ["Vitamins", "First Aid Kit", "Thermometer", "Resistance Bands", "Foam Roller", "Heating Pad"],
};

const FIRST_NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Cameron",
  "Avery", "Quinn", "Skyler", "Reese", "Drew", "Sam", "Rowan", "Emerson",
  "Priya", "Wei", "Fatima", "Diego", "Amara", "Kofi", "Elena", "Hiro",
  "Noor", "Mateo", "Yuki", "Ines", "Tariq", "Sana",
];
const LAST_NAMES = [
  "Nguyen", "Smith", "Garcia", "Patel", "Kim", "Johnson", "Chen", "Okafor",
  "Rossi", "Kowalski", "Silva", "Andersson", "Haddad", "Tanaka", "Novak",
  "Osei", "Fernandez", "Larsen", "Ivanov", "Costa",
];
const EMAIL_DOMAINS = [
  "example.com", "mail-example.net", "inbox-example.org", "example.co",
  "freemail-example.com",
];
const COUNTRIES = [
  "United States", "Canada", "United Kingdom", "Germany", "France",
  "Brazil", "Japan", "Australia", "India", "Nigeria", "Mexico", "Spain",
];

export interface DemoCustomer {
  id: number;
  email: string;
  fullName: string;
  country: string;
  segment: "standard" | "test_tenant";
  createdAt: Date;
  lastLogin: Date;
}

export interface DemoProduct {
  id: number;
  sku: string;
  name: string;
  category: string;
  price: number;
  createdAt: Date;
}

export interface DemoOrder {
  id: number;
  customerId: number;
  status: OrderStatus;
  createdAt: Date;
  totalAmount: number;
}

export interface DemoOrderItem {
  id: number;
  orderId: number;
  productId: number;
  quantity: number;
  unitPrice: number;
}

export interface DemoDatasetSummary {
  seed: number;
  totalRows: number;
  customers: number;
  products: number;
  orders: number;
  orderItems: number;
  inactiveCustomers: number;
  testTenantCustomers: number;
  testTenantOrders: number;
  cancelledOrders: number;
}

export interface DemoDataset {
  customers: DemoCustomer[];
  products: DemoProduct[];
  orders: DemoOrder[];
  orderItems: DemoOrderItem[];
  summary: DemoDatasetSummary;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function generateProducts(rng: Rng): DemoProduct[] {
  const products: DemoProduct[] = [];
  const catalogStart = new Date("2015-01-01T00:00:00Z");
  for (let i = 1; i <= PRODUCT_COUNT; i++) {
    const category = choice(rng, CATEGORIES);
    const noun = choice(rng, PRODUCT_NOUNS[category]);
    const adjective = choice(rng, PRODUCT_ADJECTIVES);
    // Log-ish spread so most items are cheap and a tail is expensive, like a real catalog.
    const basePrice = randomFloat(rng, 4.99, 39.99);
    const priceMultiplier = randomInt(rng, 1, 12);
    const price = round2(basePrice * (1 + priceMultiplier / 6));
    products.push({
      id: i,
      sku: `SKU-${String(i).padStart(6, "0")}`,
      name: `${adjective} ${noun}`,
      category,
      price,
      createdAt: randomDateBetween(rng, catalogStart, DEMO_REFERENCE_DATE),
    });
  }
  return products;
}

function generateCustomers(rng: Rng): DemoCustomer[] {
  const customers: DemoCustomer[] = [];
  const customerCreatedStart = new Date("2015-01-01T00:00:00Z");
  const inactiveLoginStart = new Date("2019-01-01T00:00:00Z");
  const inactiveLoginEnd = new Date("2024-12-31T23:59:59Z");
  const activeLoginStart = new Date("2025-01-01T00:00:00Z");

  for (let i = 1; i <= CUSTOMER_COUNT; i++) {
    // ids 1..TEST_TENANT_CUSTOMER_COUNT: the test tenant (always inactive).
    // ids (TEST_TENANT_CUSTOMER_COUNT+1)..INACTIVE_CUSTOMER_COUNT: other inactive accounts.
    // ids beyond that: active accounts.
    const isTenant = i <= TEST_TENANT_CUSTOMER_COUNT;
    const isInactive = i <= INACTIVE_CUSTOMER_COUNT;

    const lastLogin = isInactive
      ? randomDateBetween(rng, inactiveLoginStart, inactiveLoginEnd)
      : randomDateBetween(rng, activeLoginStart, DEMO_REFERENCE_DATE);
    const createdAt = randomDateBetween(rng, customerCreatedStart, lastLogin);

    const firstName = choice(rng, FIRST_NAMES);
    const lastName = choice(rng, LAST_NAMES);
    const domain = choice(rng, EMAIL_DOMAINS);
    const email = `${firstName}.${lastName}.${i}@${domain}`.toLowerCase();

    customers.push({
      id: i,
      email,
      fullName: `${firstName} ${lastName}`,
      country: choice(rng, COUNTRIES),
      segment: isTenant ? "test_tenant" : "standard",
      createdAt,
      lastLogin,
    });
  }
  return customers;
}

function generateOrdersAndItems(
  rng: Rng,
  customers: DemoCustomer[],
  products: DemoProduct[],
): { orders: DemoOrder[]; orderItems: DemoOrderItem[] } {
  const customerById = new Map<number, DemoCustomer>();
  for (const c of customers) customerById.set(c.id, c);

  const tenantIds: number[] = [];
  const activeIds: number[] = [];
  const inactiveNonTenantIds: number[] = [];
  for (const c of customers) {
    if (c.segment === "test_tenant") tenantIds.push(c.id);
    else if (c.lastLogin >= new Date("2025-01-01T00:00:00Z")) activeIds.push(c.id);
    else inactiveNonTenantIds.push(c.id);
  }

  // Exact per-status pool, shuffled so status is unrelated to insertion order,
  // but the total count per status is guaranteed regardless of seed.
  const statusPool: OrderStatus[] = [];
  for (const status of ORDER_STATUSES) {
    for (let i = 0; i < ORDER_STATUS_COUNTS[status]; i++) statusPool.push(status);
  }
  const shuffledStatuses = shuffle(rng, statusPool);

  const orders: DemoOrder[] = [];
  const orderItems: DemoOrderItem[] = [];
  let nextOrderItemId = 1;

  for (let orderIndex = 0; orderIndex < ORDER_COUNT; orderIndex++) {
    const orderId = orderIndex + 1;
    let customerId: number;
    if (orderIndex < TEST_TENANT_ORDER_COUNT) {
      customerId = tenantIds[orderIndex % tenantIds.length];
    } else {
      // 80% of remaining volume goes to active customers, 20% to inactive
      // (non-tenant) customers -- old accounts can still have historical orders.
      customerId =
        rng() < 0.8 ? choice(rng, activeIds) : choice(rng, inactiveNonTenantIds);
    }

    const customer = customerById.get(customerId)!;
    const createdAt = randomDateBetween(rng, customer.createdAt, customer.lastLogin);
    const status = shuffledStatuses[orderIndex];

    const itemCountIdx = weightedIndex(
      rng,
      ORDER_ITEM_COUNT_WEIGHTS.map(([, w]) => w),
    );
    const itemCount = ORDER_ITEM_COUNT_WEIGHTS[itemCountIdx][0];

    let totalAmount = 0;
    for (let k = 0; k < itemCount; k++) {
      const product = products[randomInt(rng, 0, products.length - 1)];
      const quantity = randomInt(rng, 1, 3);
      const unitPrice = product.price;
      totalAmount += quantity * unitPrice;
      orderItems.push({
        id: nextOrderItemId++,
        orderId,
        productId: product.id,
        quantity,
        unitPrice,
      });
    }

    orders.push({
      id: orderId,
      customerId,
      status,
      createdAt,
      totalAmount: round2(totalAmount),
    });
  }

  return { orders, orderItems };
}

/** Deterministically generate the full in-memory demo dataset for a given seed. */
export function generateDemoDataset(seed: number): DemoDataset {
  const rng = mulberry32(seed);

  const products = generateProducts(rng);
  const customers = generateCustomers(rng);
  const { orders, orderItems } = generateOrdersAndItems(rng, customers, products);

  const inactiveCustomers = customers.filter(
    (c) => c.lastLogin < new Date("2025-01-01T00:00:00Z"),
  ).length;
  const testTenantCustomers = customers.filter((c) => c.segment === "test_tenant").length;
  const testTenantOrderCount = orders.filter((o) => {
    const c = customers[o.customerId - 1];
    return c.segment === "test_tenant";
  }).length;
  const cancelledOrders = orders.filter((o) => o.status === "cancelled").length;

  const totalRows = customers.length + products.length + orders.length + orderItems.length;

  return {
    customers,
    products,
    orders,
    orderItems,
    summary: {
      seed,
      totalRows,
      customers: customers.length,
      products: products.length,
      orders: orders.length,
      orderItems: orderItems.length,
      inactiveCustomers,
      testTenantCustomers,
      testTenantOrders: testTenantOrderCount,
      cancelledOrders,
    },
  };
}
