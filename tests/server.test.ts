import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { DEFAULT_WRITE_CONFIG } from "../src/config.js";
import { createPools } from "../src/db.js";
import { READONLY_URL, WRITER_URL, SUPERUSER_URL, waitForDb, withSuperuser } from "./helpers.js";

describe("MCP server describe_schema", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);

    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS _srv_orders CASCADE`);
      await c.query(`DROP TABLE IF EXISTS _srv_customers CASCADE`);
      await c.query(`
        CREATE TABLE _srv_customers (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL
        )
      `);
      await c.query(`
        CREATE TABLE _srv_orders (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL REFERENCES _srv_customers(id),
          total_cents INT NOT NULL
        )
      `);
      await c.query(`INSERT INTO _srv_customers (email) VALUES ('x@example.com')`);
      await c.query(`INSERT INTO _srv_orders (customer_id, total_cents) VALUES (1, 500)`);
      await c.query(`ANALYZE _srv_customers; ANALYZE _srv_orders;`);
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
      await c.query(`DROP TABLE IF EXISTS _srv_orders CASCADE`);
      await c.query(`DROP TABLE IF EXISTS _srv_customers CASCADE`);
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
    const customers = parsed.tables.find((t) => t.table === "_srv_customers");
    expect(customers).toBeDefined();
    expect(customers!.columns.length).toBeGreaterThan(0);
    expect(typeof customers!.rowCountEstimate).toBe("number");

    const orders = parsed.tables.find((t) => t.table === "_srv_orders");
    expect(orders).toBeDefined();
    expect((orders!.foreignKeys as unknown[]).length).toBeGreaterThan(0);
  });
});
