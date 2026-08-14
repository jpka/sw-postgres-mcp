import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  READONLY_URL,
  WRITER_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");

interface CallToolContentBlock {
  type: string;
  text: string;
}

describe("e2e: spawned server over real stdio", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tmpDir: string;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);

    // Scratch table (prefixed e2e_* so it can't collide with the permanent
    // demo dataset or other test scratch tables) so describe_schema has
    // deterministic content to assert on.
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS e2e_pings CASCADE`);
      await c.query(`CREATE TABLE e2e_pings (id SERIAL PRIMARY KEY, note TEXT NOT NULL)`);
      await c.query(`INSERT INTO e2e_pings (note) VALUES ('hello')`);
      await c.query(`ANALYZE e2e_pings`);
    });

    // Hermetic config so the spawned server's allowlist/approval behaviour
    // doesn't depend on the repo's config.json. Env vars in the spawn below
    // (DATABASE_URL_*) still win over the file for connection strings.
    tmpDir = mkdtempSync(join(tmpdir(), "sw-postgres-mcp-e2e-"));
    writeFileSync(
      join(tmpDir, "e2e-config.json"),
      JSON.stringify({
        allowlist: {
          read: { schemas: ["public"] },
          write: { schemas: [], tables: [] },
        },
        write: { approvalRequiredAboveRows: 100, hardMaxRows: 50000 },
      }),
    );

    // Boot the real entrypoint (src/index.ts via tsx, so no build step is
    // needed and dist/ can't go stale) as a separate OS process and speak MCP
    // to it over actual stdio pipes. This exercises main()'s startup glue —
    // loadConfig from a real env, assertRolesDistinct, startServer — that
    // in-process tests bypass.
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, "src/index.ts"],
      cwd: root,
      env: {
        DATABASE_URL_READONLY: READONLY_URL,
        DATABASE_URL_WRITER: WRITER_URL,
        SW_POSTGRES_CONFIG: join(tmpDir, "e2e-config.json"),
        SW_APPROVAL_SERVER_ENABLED: "false",
        SW_CALLER_ID: "e2e-test",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => {
      process.stderr.write(`[e2e:server] ${chunk}`);
    });

    client = new Client({ name: "e2e-client", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS e2e_pings CASCADE`);
    }).catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("completes the MCP initialize handshake as sw-postgres-mcp", async () => {
    expect(client.getServerVersion().name).toBe("sw-postgres-mcp");
  });

  it("lists tools over stdio, including describe_schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("describe_schema");
  });

  it("describe_schema returns live schema content over stdio", async () => {
    const result = await client.callTool({ name: "describe_schema", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content as CallToolContentBlock[])[0].text;
    const parsed = JSON.parse(text) as {
      tables: Array<{ schema: string; table: string; columns: unknown[]; rowCountEstimate: number }>;
    };
    const pings = parsed.tables.find((t) => t.table === "e2e_pings");
    expect(pings).toBeDefined();
    expect(pings!.schema).toBe("public");
    expect(pings!.columns.length).toBeGreaterThan(0);
    expect(typeof pings!.rowCountEstimate).toBe("number");
  });

  it("query reads through the readonly connection passed via env", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: { statement: "SELECT note FROM e2e_pings", reason: "e2e check" },
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content as CallToolContentBlock[])[0].text;
    const parsed = JSON.parse(text) as { columns: string[]; rows: Array<Record<string, unknown>> };
    expect(parsed.columns).toContain("note");
    expect(parsed.rows).toContainEqual({ note: "hello" });
  });
});
