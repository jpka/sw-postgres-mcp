import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { explainPlan } from "../src/tools/explainPlan.js";
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

describe("explain_plan tool", () => {
  let roPool: pg.Pool;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    roPool = new pg.Pool({ connectionString: READONLY_URL, max: 2 });

    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS t3x_customers CASCADE`);
      await c.query(`DROP TABLE IF EXISTS t3x_secret_tokens CASCADE`);
      await c.query(`
        CREATE TABLE t3x_customers (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true
        )
      `);
      await c.query(`
        CREATE TABLE t3x_secret_tokens (
          id SERIAL PRIMARY KEY,
          token TEXT NOT NULL
        )
      `);
      await c.query(
        `INSERT INTO t3x_customers (email, active) VALUES ('a@example.com', true), ('b@example.com', false)`,
      );
      await c.query(`INSERT INTO t3x_secret_tokens (token) VALUES ('shh')`);
      await c.query(`ANALYZE t3x_customers; ANALYZE t3x_secret_tokens;`);
    });
  });

  afterAll(async () => {
    await roPool?.end();
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS t3x_customers CASCADE`);
      await c.query(`DROP TABLE IF EXISTS t3x_secret_tokens CASCADE`);
    });
  });

  it("returns cost and estimated rows for a candidate statement", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3x_customers"] },
    });
    const result = await explainPlan(
      roPool,
      {
        statement: "SELECT * FROM t3x_customers WHERE email LIKE 'a%'",
        reason: "estimate read cost",
      },
      config,
    );

    expect(typeof result.cost).toBe("number");
    expect(result.cost).toBeGreaterThanOrEqual(0);
    expect(typeof result.rows).toBe("number");
    expect(result.rows).toBeGreaterThanOrEqual(0);
    expect(result.plan).toBeDefined();
  });

  it("supports positional parameters", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3x_customers"] },
    });
    const result = await explainPlan(
      roPool,
      {
        statement: "SELECT * FROM t3x_customers WHERE id = $1",
        params: [1],
        reason: "estimate single-row lookup",
      },
      config,
    );

    expect(result.rows).toBeGreaterThanOrEqual(0);
  });

  it("rejects multi-statement input with a structured error", async () => {
    const config = makeConfig();
    await expect(
      explainPlan(roPool, { statement: "SELECT 1; SELECT 2", reason: "test" }, config),
    ).rejects.toMatchObject({ code: "MULTI_STATEMENT" });
  });

  it("rejects non-SELECT statements with a structured error", async () => {
    const config = makeConfig();
    await expect(
      explainPlan(
        roPool,
        { statement: "DELETE FROM t3x_customers", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({ code: "NOT_SELECT" });
  });

  it("rejects statements that touch a table outside the read allowlist", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3x_customers"] },
    });
    await expect(
      explainPlan(
        roPool,
        { statement: "SELECT * FROM t3x_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({ code: "TABLE_NOT_ALLOWLISTED" });
  });

  it("requires a reason string", async () => {
    const config = makeConfig();
    await expect(
      explainPlan(roPool, { statement: "SELECT 1", reason: "" }, config),
    ).rejects.toMatchObject({ code: "MISSING_REASON" });
  });
});