import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runQuery } from "../src/tools/query.js";
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

describe("query tool", () => {
  let roPool: pg.Pool;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    roPool = new pg.Pool({ connectionString: READONLY_URL, max: 2 });

    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS t3q_customers CASCADE`);
      await c.query(`DROP TABLE IF EXISTS t3q_secret_tokens CASCADE`);
      await c.query(`
        CREATE TABLE t3q_customers (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true
        )
      `);
      await c.query(`
        CREATE TABLE t3q_secret_tokens (
          id SERIAL PRIMARY KEY,
          token TEXT NOT NULL
        )
      `);
      await c.query(
        `INSERT INTO t3q_customers (email, active) VALUES ('a@example.com', true), ('b@example.com', false)`,
      );
      await c.query(`INSERT INTO t3q_secret_tokens (token) VALUES ('shh')`);
    });
  });

  afterAll(async () => {
    await roPool?.end();
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS t3q_customers CASCADE`);
      await c.query(`DROP TABLE IF EXISTS t3q_secret_tokens CASCADE`);
    });
  });

  it("returns columns, rows, and row_count for a SELECT against an allowlisted table", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      { statement: "SELECT id, email FROM t3q_customers ORDER BY id", reason: "test read" },
      config,
    );

    expect(result.columns).toEqual(["id", "email"]);
    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ email: "a@example.com" });
  });

  it("supports positional parameters and a limit", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT id, email FROM t3q_customers WHERE active = $1",
        params: [true],
        limit: 1,
        reason: "test params",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].email).toBe("a@example.com");
  });

  it("handles a trailing semicolon when a limit is applied", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT id, email FROM t3q_customers ORDER BY id;",
        limit: 1,
        reason: "test trailing semicolon",
      },
      config,
    );

    expect(result.row_count).toBe(1);
  });

  it("handles multiple trailing semicolons when a limit is applied", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT id, email FROM t3q_customers ORDER BY id;;",
        limit: 1,
        reason: "test multiple trailing semicolons",
      },
      config,
    );

    expect(result.row_count).toBe(1);
  });

  it("a string literal containing -- is not stripped as a comment", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT '--' AS marker",
        limit: 1,
        reason: "test literal with comment-looking text",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].marker).toBe("--");
  });

  it("a string literal containing a semicolon is not mistaken for a terminator", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT 'a;b' AS marker",
        limit: 1,
        reason: "test literal with semicolon",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].marker).toBe("a;b");
  });

  it("dollar-quoted literals containing a semicolon are not mistaken for a terminator", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT $$hello;world$$ AS marker",
        limit: 1,
        reason: "test dollar-quoted literal with semicolon",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].marker).toBe("hello;world");
  });

  it("trailing line comments are dropped before a limit wrapper", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT 'x' AS marker -- trailing comment",
        limit: 1,
        reason: "test trailing line comment",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].marker).toBe("x");
  });

  it("trailing block comments are dropped before a limit wrapper", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT 'y' AS marker /* trailing block */",
        limit: 1,
        reason: "test trailing block comment",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].marker).toBe("y");
  });

  it("a terminator followed by whitespace and a trailing comment is dropped before a limit wrapper", async () => {
    const config = makeConfig();
    const result = await runQuery(
      roPool,
      { statement: "SELECT 1 AS n; -- trailing comment", limit: 1, reason: "test" },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].n).toBe(1);
  });

  it("an escape string with an escaped quote and semicolon is not mistaken for a terminator", async () => {
    const config = makeConfig();
    const result = await runQuery(
      roPool,
      {
        statement: "SELECT E'hello\\'world;' AS marker",
        limit: 1,
        reason: "test escape string",
      },
      config,
    );

    expect(result.row_count).toBe(1);
    expect(result.rows[0].marker).toBe("hello'world;");
  });

  it("ONLY table references are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM ONLY t3q_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });

    const allowed = await runQuery(
      roPool,
      { statement: "SELECT * FROM ONLY t3q_customers", reason: "test" },
      config,
    );
    expect(allowed.row_count).toBe(2);
  });

  it("parenthesized ONLY table references are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM ONLY (t3q_secret_tokens)", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });

    const allowed = await runQuery(
      roPool,
      { statement: "SELECT * FROM ONLY (t3q_customers)", reason: "test" },
      config,
    );
    expect(allowed.row_count).toBe(2);
  });

  it("comma-joined tables are all allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers, t3q_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("aliased comma-joined tables are all allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers c, t3q_secret_tokens s", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("LATERAL references are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers, LATERAL (SELECT token FROM t3q_secret_tokens) s", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("derived tables are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM (SELECT token FROM t3q_secret_tokens) AS sub", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("subqueries in WHERE are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers WHERE id IN (SELECT id FROM t3q_secret_tokens)", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("relations after a JOIN ... ON condition are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers c1 JOIN t3q_customers c2 ON c1.id = c2.id, t3q_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("relations after a JOIN ... USING condition are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers c1 JOIN t3q_customers c2 USING (id), t3q_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("relations after a LEFT JOIN ... ON condition are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_customers c1 LEFT JOIN t3q_customers c2 ON c1.id = c2.id, t3q_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("parenthesized join groups are still allowlist-checked", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM (t3q_secret_tokens s JOIN t3q_customers a ON s.id = a.id)", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("quoted mixed-case relations are still allowlist-checked", async () => {
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS "t3q_SecretTokens"`);
      await c.query(`CREATE TABLE "t3q_SecretTokens" (token TEXT)`);
      await c.query(`INSERT INTO "t3q_SecretTokens" (token) VALUES ('shh')`);
      await c.query(`GRANT SELECT ON "t3q_SecretTokens" TO readonly`);
    });

    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    try {
      await expect(
        runQuery(
          roPool,
          { statement: 'SELECT * FROM public."t3q_SecretTokens"', reason: "test" },
          config,
        ),
      ).rejects.toMatchObject({
        code: "TABLE_NOT_ALLOWLISTED",
        message: "Table public.t3q_SecretTokens is not in the read allowlist.",
      });
    } finally {
      await withSuperuser(async (c) => {
        await c.query(`DROP TABLE IF EXISTS "t3q_SecretTokens"`);
      });
    }
  });

  it("refuses a mutating statement with a structured error before hitting the database", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "INSERT INTO t3q_customers (email) VALUES ('c@example.com')", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "NOT_SELECT",
      message: "Only read-only SELECT statements are allowed.",
      hint: expect.any(String),
    });
  });

  it("readonly role provably cannot write (test fails if the role were swapped for a permissive one)", async () => {
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS t3q_guard`);
      await c.query(`CREATE TABLE t3q_guard (id int primary key)`);
      await c.query(`GRANT SELECT ON t3q_guard TO readonly`);
    });

    const direct = new pg.Pool({ connectionString: READONLY_URL });
    try {
      await expect(
        direct.query(`INSERT INTO t3q_guard (id) VALUES (1)`),
      ).rejects.toThrow(/permission denied|not allowed|insufficient_privilege/i);
    } finally {
      await direct.end();
      await withSuperuser(async (c) => {
        await c.query(`DROP TABLE IF EXISTS t3q_guard`);
      });
    }
  });

  it("rejects multi-statement input with a structured error", async () => {
    const config = makeConfig();
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT 1; SELECT 2", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({ code: "MULTI_STATEMENT" });
  });

  it("rejects statements that touch a table outside the read allowlist", async () => {
    const config = makeConfig({
      read: { schemas: [], tables: ["public.t3q_customers"] },
    });
    await expect(
      runQuery(
        roPool,
        { statement: "SELECT * FROM t3q_secret_tokens", reason: "test" },
        config,
      ),
    ).rejects.toMatchObject({
      code: "TABLE_NOT_ALLOWLISTED",
      message: "Table public.t3q_secret_tokens is not in the read allowlist.",
    });
  });

  it("requires a reason string", async () => {
    const config = makeConfig();
    await expect(
      runQuery(roPool, { statement: "SELECT 1", reason: "" }, config),
    ).rejects.toMatchObject({ code: "MISSING_REASON" });
  });
});