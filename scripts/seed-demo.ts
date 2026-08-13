#!/usr/bin/env node
/**
 * Seeds the synthetic e-commerce demo database (issue #10).
 *
 *   npm run seed:demo
 *   npm run seed:demo -- --seed=7
 *   npm run seed:demo -- --connection="postgres://user:pass@host:5432/db"
 *
 * Connection resolution mirrors src/config.ts's writer connection string
 * precedence, so this works unmodified against the disposable Docker
 * Postgres (docker-compose.yml) or any plain local/remote Postgres:
 *
 *   --connection flag > DATABASE_URL_WRITER > POSTGRES_WRITER_URL >
 *   DATABASE_URL > the docker-compose writer default.
 *
 * The target role just needs CREATE on the public schema (to apply the
 * demo-schema migration if it hasn't run yet) and DML on the four demo
 * tables; the `writer` role from docker/init/01-roles.sql already has both.
 *
 * Deterministic: the entire dataset is generated up front by
 * generateDemoDataset(seed) (scripts/seed-demo/generate.ts), a pure
 * function with no wall-clock or Math.random() inputs. The same seed
 * always produces the same rows, so re-running this command reproduces
 * the exact same demo database. Each run truncates the four demo tables
 * first, so it is safe to run repeatedly from a non-empty state too.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { generateDemoDataset, type DemoDataset } from "./seed-demo/generate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL_PATH = join(__dirname, "..", "docker", "init", "03-demo-schema.sql");

const DEFAULT_WRITER_URL = "postgres://writer:writer_password@localhost:5432/mcp_test";

function parseArgs(argv: string[]): { seed: number; connection: string } {
  let seed = 42;
  let connection: string | undefined;
  for (const arg of argv) {
    const seedMatch = arg.match(/^--seed=(\d+)$/);
    const connMatch = arg.match(/^--connection=(.+)$/);
    if (seedMatch) seed = Number(seedMatch[1]);
    else if (connMatch) connection = connMatch[1];
  }
  connection =
    connection ??
    process.env.DATABASE_URL_WRITER ??
    process.env.POSTGRES_WRITER_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_WRITER_URL;
  return { seed, connection };
}

async function batchInsert(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  batchSize = 1000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const tuples: string[] = [];
    batch.forEach((row, rowIdx) => {
      const placeholders = row.map(
        (_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`,
      );
      tuples.push(`(${placeholders.join(",")})`);
      values.push(...row);
    });
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`;
    await client.query(sql, values);
  }
}

async function insertDataset(client: pg.Client, dataset: DemoDataset): Promise<void> {
  console.log(`Inserting ${dataset.products.length} products...`);
  await batchInsert(
    client,
    "products",
    ["id", "sku", "name", "category", "price", "created_at"],
    dataset.products.map((p) => [p.id, p.sku, p.name, p.category, p.price, p.createdAt]),
  );

  console.log(`Inserting ${dataset.customers.length} customers...`);
  await batchInsert(
    client,
    "customers",
    ["id", "email", "full_name", "country", "segment", "created_at", "last_login"],
    dataset.customers.map((c) => [
      c.id,
      c.email,
      c.fullName,
      c.country,
      c.segment,
      c.createdAt,
      c.lastLogin,
    ]),
  );

  console.log(`Inserting ${dataset.orders.length} orders...`);
  await batchInsert(
    client,
    "orders",
    ["id", "customer_id", "status", "created_at", "total_amount"],
    dataset.orders.map((o) => [o.id, o.customerId, o.status, o.createdAt, o.totalAmount]),
  );

  console.log(`Inserting ${dataset.orderItems.length} order_items...`);
  await batchInsert(
    client,
    "order_items",
    ["id", "order_id", "product_id", "quantity", "unit_price"],
    dataset.orderItems.map((oi) => [
      oi.id,
      oi.orderId,
      oi.productId,
      oi.quantity,
      oi.unitPrice,
    ]),
  );
}

/**
 * Reseeding inserts explicit `id` values (so ids/FKs are byte-identical
 * across runs for a given seed) rather than letting Postgres assign them
 * via each column's sequence DEFAULT. That means the sequences never
 * auto-advance during the insert, so anything inserted afterwards through
 * ordinary `INSERT ... DEFAULT` (a human poking at the demo db, or another
 * tool) would collide with the ids we just wrote. setval() resyncs each
 * sequence to the max id actually present so the *next* nextval() call
 * continues on cleanly from there.
 */
async function resyncSequences(client: pg.Client, dataset: DemoDataset): Promise<void> {
  const maxIds: Array<[sequence: string, table: string]> = [
    ["customers_id_seq", "customers"],
    ["products_id_seq", "products"],
    ["orders_id_seq", "orders"],
    ["order_items_id_seq", "order_items"],
  ];
  for (const [sequence, table] of maxIds) {
    await client.query(
      `SELECT setval($1, COALESCE((SELECT max(id) FROM ${table}), 1), true)`,
      [sequence],
    );
  }
}

async function verify(client: pg.Client): Promise<void> {
  const counts = await client.query<{ table_name: string; n: string }>(`
    SELECT 'customers' AS table_name, count(*)::text AS n FROM customers
    UNION ALL SELECT 'products', count(*)::text FROM products
    UNION ALL SELECT 'orders', count(*)::text FROM orders
    UNION ALL SELECT 'order_items', count(*)::text FROM order_items
  `);
  const inactive = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM customers WHERE last_login < '2025-01-01'`,
  );
  const tenant = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.segment = 'test_tenant'`,
  );
  const cancelled = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM orders WHERE status = 'cancelled'`,
  );

  console.log("\nVerification (queried back from the database):");
  for (const row of counts.rows) console.log(`  ${row.table_name}: ${row.n}`);
  console.log(`  inactive customers (last_login < 2025-01-01): ${inactive.rows[0].n}`);
  console.log(`  test tenant orders (segment = 'test_tenant'): ${tenant.rows[0].n}`);
  console.log(`  cancelled orders (>10,000-row hard-cap group): ${cancelled.rows[0].n}`);
}

async function main(): Promise<void> {
  const { seed, connection } = parseArgs(process.argv.slice(2));

  console.log(`Seeding demo database (seed=${seed})`);
  console.log(`Connection: ${connection.replace(/:[^:@]*@/, ":***@")}`);

  console.log("Generating dataset in memory (deterministic, seeded PRNG)...");
  const dataset = generateDemoDataset(seed);
  const s = dataset.summary;
  console.log(
    [
      `  customers:    ${s.customers}`,
      `  products:     ${s.products}`,
      `  orders:       ${s.orders}`,
      `  order_items:  ${s.orderItems}`,
      `  total rows:   ${s.totalRows}`,
      `  inactive customers (last_login < 2025): ${s.inactiveCustomers}`,
      `  test tenant customers: ${s.testTenantCustomers}`,
      `  test tenant orders:    ${s.testTenantOrders}`,
      `  cancelled orders (>10k hard-cap group): ${s.cancelledOrders}`,
    ].join("\n"),
  );

  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try {
    // Only apply the schema migration (CREATE TABLE/INDEX + grants) when the
    // demo tables aren't there yet. `CREATE INDEX IF NOT EXISTS` is *not*
    // safe to blindly re-run as a non-owning role: Postgres checks table
    // ownership before it even gets to the "already exists, skip" check, so
    // re-running the raw migration SQL as `writer` against a schema that the
    // disposable Docker Postgres already created (as the `postgres`
    // superuser, via docker-entrypoint-initdb.d) fails with "must be owner
    // of table" even though there is nothing to do. Checking first sidesteps
    // that entirely instead of relying on catching the error.
    const existing = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('public.customers') AS reg",
    );
    if (!existing.rows[0].reg) {
      console.log("\nApplying demo schema migration (schema not present yet)...");
      const migrationSql = readFileSync(MIGRATION_SQL_PATH, "utf-8");
      await client.query(migrationSql);
    } else {
      console.log("\nDemo schema already present (e.g. applied by docker-entrypoint-initdb.d); skipping migration.");
    }

    // Plain TRUNCATE, not `RESTART IDENTITY`: resetting a sequence's start
    // value via RESTART IDENTITY is DDL that requires *owning* the
    // sequence, which `writer` deliberately doesn't (the disposable Docker
    // Postgres creates these tables/sequences as the `postgres` superuser).
    // `writer` does have UPDATE on the sequences though (granted by
    // docker/init/03-demo-schema.sql), so setval() below achieves the same
    // "next id starts after what we just inserted" result via a function
    // call instead of DDL.
    console.log("Truncating demo tables for a clean, deterministic reseed...");
    await client.query("TRUNCATE TABLE order_items, orders, customers, products CASCADE");

    await insertDataset(client, dataset);
    await resyncSequences(client, dataset);
    await verify(client);

    console.log("\nDone.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("seed:demo failed:", err);
  process.exitCode = 1;
});
