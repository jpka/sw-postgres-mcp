import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { DEFAULT_WRITE_CONFIG } from "../src/config.js";
import { createPools } from "../src/db.js";
import { READONLY_URL, WRITER_URL, SUPERUSER_URL, waitForDb, withSuperuser } from "./helpers.js";

describe("MCP server tools", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);

    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS srv_orders CASCADE`);
      await c.query(`DROP TABLE IF EXISTS srv_customers CASCADE`);
      await c.query(`
        CREATE TABLE srv_customers (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL
        )
      `);
      await c.query(`
        CREATE TABLE srv_orders (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL REFERENCES srv_customers(id),
          total_cents INT NOT NULL
        )
      `);
      await c.query(`INSERT INTO srv_customers (email) VALUES ('x@example.com')`);
      await c.query(`INSERT INTO srv_orders (customer_id, total_cents) VALUES (1, 500)`);
      await c.query(`ANALYZE srv_customers; ANALYZE srv_orders;`);
    });

    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { schemas: ["public"] },
        write: { schemas: [], tables: [] },
      },
      write: DEFAULT_WRITE_CONFIG,
    };

    serverPools = createPools(config);
    const server = createServer(serverPools, config);

    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await serverPools?.readonlyPool.end().catch(() => {});
    await serverPools?.writerPool.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS srv_orders CASCADE`);
      await c.query(`DROP TABLE IF EXISTS srv_customers CASCADE`);
    });
  });

  it("appears in list_tools and returns real results via call_tool", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("describe_schema");

    const result = await client.callTool({ name: "describe_schema", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { tables: Array<{ schema: string; table: string; columns: unknown[]; foreignKeys: unknown[]; rowCountEstimate: number }> };
    expect(Array.isArray(parsed.tables)).toBe(true);
    const srv_customers = parsed.tables.find((t) => t.table === "srv_customers");
    expect(srv_customers).toBeDefined();
    expect(srv_customers!.columns.length).toBeGreaterThan(0);
    expect(typeof srv_customers!.rowCountEstimate).toBe("number");

    const srv_orders = parsed.tables.find((t) => t.table === "srv_orders");
    expect(srv_orders).toBeDefined();
    expect((srv_orders!.foreignKeys as unknown[]).length).toBeGreaterThan(0);
  });

  it("query returns rows via call_tool", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: { statement: "SELECT id, email FROM srv_customers ORDER BY id", reason: "server test" },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { columns: string[]; rows: unknown[]; row_count: number };
    expect(parsed.columns).toContain("email");
    expect(parsed.row_count).toBe(1);
    expect(parsed.rows).toHaveLength(1);
  });

  it("explain_plan returns cost and estimated rows via call_tool", async () => {
    const result = await client.callTool({
      name: "explain_plan",
      arguments: { statement: "SELECT * FROM srv_customers", reason: "server test" },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { cost: number; rows: number; plan: unknown };
    expect(typeof parsed.cost).toBe("number");
    expect(typeof parsed.rows).toBe("number");
    expect(parsed.plan).toBeDefined();
  });

  it("query rejects a call without reason with a structured error", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: { statement: "SELECT 1" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { code: string; message: string; hint: string };
    expect(parsed.code).toBe("INVALID_ARGUMENTS");
    expect(parsed.message).toMatch(/reason/);
    expect(parsed.hint).toBeTruthy();
  });

  it("multi-statement input surfaces as structured JSON, not a prefixed or raw error", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: { statement: "SELECT 1; SELECT 2", reason: "server test" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toMatch(/^query failed:/);
    const parsed = JSON.parse(text) as { code: string; message: string; hint: string };
    expect(parsed.code).toBe("MULTI_STATEMENT");
    expect(parsed.hint).toBeTruthy();
  });

  it("database failures surface as structured JSON without raw Postgres exception text", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: { statement: "SELECT FROM nowhere_at_all", reason: "server test" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).not.toMatch(/at or near/i);
    expect(text).not.toMatch(/ERROR:/i);
    const parsed = JSON.parse(text) as { code: string; message: string; hint: string };
    expect(parsed.code).toBe("QUERY_FAILED");
    expect(parsed.hint).toBeTruthy();
  });

  // Regression test for the self-approval hole CodeRabbit flagged on PR #18:
  // approve_plan must not be reachable by the same agent that requests a
  // gated write. TwoPhaseWrite.approvePlan() still exists (src/writeCore.ts)
  // for ticket #7's future human-approval surface to call directly, but it
  // must never be exposed through this agent-facing MCP tool surface.
  it("approve_plan is not exposed on the agent-facing MCP tool surface", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain("approve_plan");

    const result = await client.callTool({
      name: "approve_plan",
      arguments: { plan_token: "does-not-matter" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { code: string; message: string; hint: string };
    expect(parsed.code).toBe("UNKNOWN_TOOL");
    expect(parsed.message).toMatch(/approve_plan/);
  });
});
