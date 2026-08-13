import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { mulberry32 } from "../scripts/seed-demo/prng.js";
import {
  generateDemoDataset,
  CUSTOMER_COUNT,
  PRODUCT_COUNT,
  ORDER_COUNT,
  INACTIVE_CUSTOMER_COUNT,
  TEST_TENANT_CUSTOMER_COUNT,
  TEST_TENANT_ORDER_COUNT,
  ORDER_STATUS_COUNTS,
} from "../scripts/seed-demo/generate.js";
import { WRITER_URL, SUPERUSER_URL, waitForDb } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("mulberry32 seeded PRNG", () => {
  it("is deterministic: same seed produces the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = mulberry32(42);
    const b = mulberry32(43);
    expect(a()).not.toBe(b());
  });
});

describe("generateDemoDataset", () => {
  it("is deterministic: same seed yields identical row counts and content on repeat generation", () => {
    const first = generateDemoDataset(42);
    const second = generateDemoDataset(42);

    expect(second.summary).toEqual(first.summary);
    expect(second.customers.length).toBe(first.customers.length);
    expect(second.orders.length).toBe(first.orders.length);
    expect(second.orderItems.length).toBe(first.orderItems.length);

    // Spot-check actual content, not just counts.
    expect(second.customers[0]).toEqual(first.customers[0]);
    expect(second.customers[first.customers.length - 1]).toEqual(
      first.customers[first.customers.length - 1],
    );
    expect(second.orders[100]).toEqual(first.orders[100]);
    expect(second.orderItems[100]).toEqual(first.orderItems[100]);
  });

  it("different seeds still hit the same structural row-count targets", () => {
    const a = generateDemoDataset(42);
    const b = generateDemoDataset(7);

    expect(a.summary.customers).toBe(CUSTOMER_COUNT);
    expect(b.summary.customers).toBe(CUSTOMER_COUNT);
    expect(a.summary.inactiveCustomers).toBe(INACTIVE_CUSTOMER_COUNT);
    expect(b.summary.inactiveCustomers).toBe(INACTIVE_CUSTOMER_COUNT);
    expect(a.summary.testTenantOrders).toBe(TEST_TENANT_ORDER_COUNT);
    expect(b.summary.testTenantOrders).toBe(TEST_TENANT_ORDER_COUNT);
    expect(a.summary.cancelledOrders).toBe(ORDER_STATUS_COUNTS.cancelled);

    // Content differs across seeds (not just a static fixture).
    expect(a.customers[10].email).not.toBe(b.customers[10].email);
  });

  it("produces roughly 200k rows across all four tables with FKs intact", () => {
    const dataset = generateDemoDataset(42);

    expect(dataset.products.length).toBe(PRODUCT_COUNT);
    expect(dataset.customers.length).toBe(CUSTOMER_COUNT);
    expect(dataset.orders.length).toBe(ORDER_COUNT);
    expect(dataset.summary.totalRows).toBeGreaterThan(190_000);
    expect(dataset.summary.totalRows).toBeLessThan(220_000);

    const customerIds = new Set(dataset.customers.map((c) => c.id));
    const productIds = new Set(dataset.products.map((p) => p.id));
    const orderIds = new Set(dataset.orders.map((o) => o.id));

    for (const order of dataset.orders) {
      expect(customerIds.has(order.customerId)).toBe(true);
    }
    for (const item of dataset.orderItems) {
      expect(orderIds.has(item.orderId)).toBe(true);
      expect(productIds.has(item.productId)).toBe(true);
    }
  });

  it("~40k inactive customers dated before 2025, with a low-hundreds test tenant inside that population", () => {
    const dataset = generateDemoDataset(42);
    const cutoff = new Date("2025-01-01T00:00:00Z");

    const inactive = dataset.customers.filter((c) => c.lastLogin < cutoff);
    expect(inactive.length).toBe(INACTIVE_CUSTOMER_COUNT);
    expect(inactive.length).toBe(40_000);

    const tenantCustomers = dataset.customers.filter((c) => c.segment === "test_tenant");
    expect(tenantCustomers.length).toBe(TEST_TENANT_CUSTOMER_COUNT);
    // The tenant is entirely inside the inactive population.
    for (const c of tenantCustomers) {
      expect(c.lastLogin < cutoff).toBe(true);
    }

    const tenantOrders = dataset.orders.filter((o) => {
      const c = dataset.customers[o.customerId - 1];
      return c.segment === "test_tenant";
    });
    expect(tenantOrders.length).toBe(TEST_TENANT_ORDER_COUNT);
    expect(tenantOrders.length).toBeGreaterThan(100);
    expect(tenantOrders.length).toBeLessThan(1000);
  });

  it("has a single-status group of orders exceeding the 10,000-row hard cap", () => {
    const dataset = generateDemoDataset(42);
    const cancelled = dataset.orders.filter((o) => o.status === "cancelled");
    expect(cancelled.length).toBe(ORDER_STATUS_COUNTS.cancelled);
    expect(cancelled.length).toBeGreaterThan(10_000);
  });
});

// The above tests exercise dataset generation in isolation, with no
// database involved. The tests below run the actual documented command
// (`npm run seed:demo`) against a live Postgres and verify the row-count
// shape acceptance criteria by querying the data back, the same way a
// human running the command would.
//
// This is the only test file that touches the bare `customers` / `orders`
// / `order_items` / `products` tables -- they're the permanent demo schema
// (docker/init/03-demo-schema.sql), not scratch tables, so unlike every
// other *.test.ts file here there is nothing to DROP/CREATE/tear down
// around it. describeSchema.test.ts deliberately uses a `ds_`-prefixed
// scratch schema instead of the bare names for exactly this reason.
describe("npm run seed:demo against a live Postgres", () => {
  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
  }, 30_000);

  it(
    "seeds ~200k rows with the documented row-count shape, intact FKs, and is deterministic across reseeds",
    async () => {
      const runSeed = () =>
        execFileAsync("npm", ["run", "seed:demo", "--silent", "--", `--connection=${WRITER_URL}`], {
          cwd: process.cwd(),
          maxBuffer: 16 * 1024 * 1024,
        });

      await runSeed();

      const client = new pg.Client({ connectionString: WRITER_URL });
      await client.connect();
      try {
        const counts = await client.query<{
          customers: number;
          products: number;
          orders: number;
          order_items: number;
        }>(`
          SELECT
            (SELECT count(*) FROM customers)::int AS customers,
            (SELECT count(*) FROM products)::int AS products,
            (SELECT count(*) FROM orders)::int AS orders,
            (SELECT count(*) FROM order_items)::int AS order_items
        `);
        const row = counts.rows[0];

        // ~200k rows total across the four tables.
        const total = row.customers + row.products + row.orders + row.order_items;
        expect(total).toBeGreaterThan(190_000);
        expect(total).toBeLessThan(220_000);
        expect(row.customers).toBe(CUSTOMER_COUNT);
        expect(row.products).toBe(PRODUCT_COUNT);
        expect(row.orders).toBe(ORDER_COUNT);

        // ~40,000 inactive customer accounts (no login since before 2025).
        const inactive = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM customers WHERE last_login < '2025-01-01'`,
        );
        expect(inactive.rows[0].n).toBe(INACTIVE_CUSTOMER_COUNT);
        expect(inactive.rows[0].n).toBe(40_000);

        // A single identifiable "test tenant" of a few hundred rows, entirely
        // inside the inactive population.
        const tenant = await client.query<{ customers: number; orders: number }>(`
          SELECT
            (SELECT count(*) FROM customers WHERE segment = 'test_tenant')::int AS customers,
            (SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id
               WHERE c.segment = 'test_tenant')::int AS orders
        `);
        expect(tenant.rows[0].customers).toBe(TEST_TENANT_CUSTOMER_COUNT);
        expect(tenant.rows[0].orders).toBe(TEST_TENANT_ORDER_COUNT);
        expect(tenant.rows[0].orders).toBeGreaterThan(100);
        expect(tenant.rows[0].orders).toBeLessThan(1_000);
        const tenantInactive = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM customers WHERE segment = 'test_tenant' AND last_login >= '2025-01-01'`,
        );
        expect(tenantInactive.rows[0].n).toBe(0);

        // Something exceeding 10,000 rows in a single logical group, to later
        // demonstrate a hard-cap refusal.
        const cancelled = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM orders WHERE status = 'cancelled'`,
        );
        expect(cancelled.rows[0].n).toBe(ORDER_STATUS_COUNTS.cancelled);
        expect(cancelled.rows[0].n).toBeGreaterThan(10_000);

        // Foreign keys intact: no orphaned orders or order_items.
        const orphanOrders = await client.query<{ n: number }>(`
          SELECT count(*)::int AS n FROM orders o
          LEFT JOIN customers c ON c.id = o.customer_id WHERE c.id IS NULL
        `);
        expect(orphanOrders.rows[0].n).toBe(0);
        const orphanItems = await client.query<{ n: number }>(`
          SELECT count(*)::int AS n FROM order_items oi
          LEFT JOIN orders o ON o.id = oi.order_id
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.id IS NULL OR p.id IS NULL
        `);
        expect(orphanItems.rows[0].n).toBe(0);
      } finally {
        await client.end();
      }

      // Deterministic: reseeding (default seed) from a non-empty state
      // truncates and regenerates the exact same row counts.
      await runSeed();
      const client2 = new pg.Client({ connectionString: WRITER_URL });
      await client2.connect();
      try {
        const recount = await client2.query<{ n: number }>(
          `SELECT (
             (SELECT count(*) FROM customers) +
             (SELECT count(*) FROM products) +
             (SELECT count(*) FROM orders) +
             (SELECT count(*) FROM order_items)
           )::int AS n`,
        );
        const inactive2 = await client2.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM customers WHERE last_login < '2025-01-01'`,
        );
        expect(inactive2.rows[0].n).toBe(INACTIVE_CUSTOMER_COUNT);
        expect(recount.rows[0].n).toBe(
          CUSTOMER_COUNT + PRODUCT_COUNT + ORDER_COUNT + generateDemoDataset(42).orderItems.length,
        );
      } finally {
        await client2.end();
      }
    },
    180_000,
  );
});
