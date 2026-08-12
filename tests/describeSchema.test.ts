import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { describeSchema } from "../src/tools/describeSchema.js";
import type { AppConfig } from "../src/config.js";
import {
  READONLY_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

function makeConfig(overrides: Partial<AppConfig["allowlist"]> = {}): AppConfig {
  return {
    database: {
      readonlyConnectionString: READONLY_URL,
      writerConnectionString: READONLY_URL,
    },
    allowlist: {
      read: {
        schemas: ["public"],
        tables: [],
      },
      write: {
        schemas: [],
        tables: [],
      },
      ...overrides,
    } as AppConfig["allowlist"],
  };
}

describe("describe_schema", () => {
  let roPool: pg.Pool;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    roPool = new pg.Pool({ connectionString: READONLY_URL, max: 2 });

    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS order_items CASCADE`);
      await c.query(`DROP TABLE IF EXISTS orders CASCADE`);
      await c.query(`DROP TABLE IF EXISTS customers CASCADE`);
      await c.query(`DROP TABLE IF EXISTS secret_tokens CASCADE`);

      await c.query(`
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true
        )
      `);
      await c.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL REFERENCES customers(id),
          total_cents INT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await c.query(`
        CREATE TABLE order_items (
          id SERIAL PRIMARY KEY,
          order_id INT NOT NULL REFERENCES orders(id),
          sku TEXT NOT NULL,
          qty INT NOT NULL
        )
      `);
      await c.query(`
        CREATE TABLE secret_tokens (
          id SERIAL PRIMARY KEY,
          token TEXT NOT NULL
        )
      `);
      // Seed rows so rowCountEstimate > 0 after ANALYZE
      await c.query(`INSERT INTO customers (email) VALUES ('a@example.com'), ('b@example.com')`);
      await c.query(`INSERT INTO orders (customer_id, total_cents) VALUES (1, 1000), (2, 2000)`);
      await c.query(`INSERT INTO order_items (order_id, sku, qty) VALUES (1, 'SKU-1', 2)`);
      await c.query(`INSERT INTO secret_tokens (token) VALUES ('shh')`);
      await c.query(`ANALYZE customers; ANALYZE orders; ANALYZE order_items; ANALYZE secret_tokens;`);
    });
  });

  afterAll(async () => {
    await roPool?.end();
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS order_items CASCADE`);
      await c.query(`DROP TABLE IF EXISTS orders CASCADE`);
      await c.query(`DROP TABLE IF EXISTS customers CASCADE`);
      await c.query(`DROP TABLE IF EXISTS secret_tokens CASCADE`);
    });
  });

  it("returns tables, columns with types, foreign keys, and row-count estimates", async () => {
    const config = makeConfig();
    const tables = await describeSchema(roPool, config);

    const customers = tables.find((t) => t.table === "customers");
    expect(customers).toBeDefined();
    expect(customers!.columns.length).toBeGreaterThan(0);
    const emailCol = customers!.columns.find((c) => c.name === "email");
    expect(emailCol).toBeDefined();
    expect(emailCol!.type).toMatch(/text/i);
    expect(typeof customers!.rowCountEstimate).toBe("number");

    const orders = tables.find((t) => t.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.foreignKeys.length).toBeGreaterThan(0);
    const fk = orders!.foreignKeys.find((f) => f.column === "customer_id");
    expect(fk).toBeDefined();
    expect(fk!.referencesTable).toBe("customers");
  });

  it("tables outside the read allowlist do not appear", async () => {
    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: READONLY_URL,
      },
      allowlist: {
        read: {
          tables: ["public.customers", "public.orders"],
        },
        write: { schemas: [], tables: [] },
      },
    };
    const tables = await describeSchema(roPool, config);
    const names = tables.map((t) => `${t.schema}.${t.table}`);
    expect(names).toContain("public.customers");
    expect(names).toContain("public.orders");
    expect(names).not.toContain("public.secret_tokens");
    expect(names).not.toContain("public.order_items");
  });

  it("FKs referencing non-allowlisted tables are dropped from output", async () => {
    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: READONLY_URL,
      },
      allowlist: {
        read: {
          tables: ["public.customers"],
        },
        write: { schemas: [], tables: [] },
      },
    };
    const tables = await describeSchema(roPool, config);
    const names = tables.map((t) => `${t.schema}.${t.table}`);
    // secret_tokens is not allowlisted; even though orders references customers,
    // orders itself is not allowlisted so neither appears at all
    expect(names).toContain("public.customers");
    expect(names).not.toContain("public.secret_tokens");

    // If we allow orders but not secret_tokens, the FK to secret_tokens must be hidden
    const config2: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: READONLY_URL,
      },
      allowlist: {
        read: {
          tables: ["public.orders"],
        },
        write: { schemas: [], tables: [] },
      },
    };
    const tables2 = await describeSchema(roPool, config2);
    const orders = tables2.find((t) => t.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.foreignKeys).toEqual([]);
  });

  it("row-count estimates are numeric", async () => {
    const config = makeConfig();
    const tables = await describeSchema(roPool, config);
    for (const t of tables) {
      expect(typeof t.rowCountEstimate).toBe("number");
      expect(Number.isFinite(t.rowCountEstimate)).toBe(true);
    }
  });
});
