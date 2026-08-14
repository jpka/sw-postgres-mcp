import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { createPools } from "../src/db.js";
import { DEFAULT_WRITE_CONFIG, type AppConfig } from "../src/config.js";
import { TwoPhaseWrite } from "../src/writeCore.js";
import { startApprovalServer, type ApprovalServerHandle } from "../src/approvalServer.js";
import { parseDdlStatement } from "../src/tools/ddlTarget.js";
import {
  READONLY_URL,
  WRITER_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

/** A fresh, valid, unquoted Postgres identifier — no hyphens, always starts with a letter. */
function migTableName(): string {
  return `_mig_${randomUUID().replace(/-/g, "_")}`;
}

async function tableExists(table: string): Promise<boolean> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
    return r.rows[0].reg !== null;
  });
}

async function columnExists(table: string, column: string): Promise<boolean> {
  return withSuperuser(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

async function indexExists(indexName: string): Promise<boolean> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT to_regclass($1) AS reg`, [`public.${indexName}`]);
    return r.rows[0].reg !== null;
  });
}

/** Cleans up every table this suite may have created, regardless of which test left it behind. */
async function dropAllMigTables(): Promise<void> {
  await withSuperuser(async (c) => {
    const res = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '_mig\\_%' ESCAPE '\\'`,
    );
    for (const row of res.rows as Array<{ table_name: string }>) {
      await c.query(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`);
    }
  });
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): { isError: boolean; body: Record<string, unknown> } {
  const text = result.content[0].text;
  return { isError: result.isError ?? false, body: JSON.parse(text) };
}

/** Rows written for one test's unique `reason`, oldest first. */
async function auditRowsForReason(reason: string): Promise<Record<string, unknown>[]> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT * FROM mcp_audit.log WHERE reason = $1 ORDER BY id ASC`, [
      reason,
    ]);
    return r.rows;
  });
}

describe("parseDdlStatement — DDL target extraction (#9)", () => {
  it("extracts CREATE TABLE's target, defaulting to public when unqualified", () => {
    expect(parseDdlStatement("CREATE TABLE customers (id serial primary key)")).toEqual({
      kind: "CREATE_TABLE",
      targets: [{ schema: "public", table: "customers" }],
    });
    expect(
      parseDdlStatement("CREATE TABLE IF NOT EXISTS sales.customers (id serial primary key)"),
    ).toEqual({
      kind: "CREATE_TABLE",
      targets: [{ schema: "sales", table: "customers" }],
    });
  });

  it("extracts ALTER TABLE's target through IF EXISTS / ONLY", () => {
    expect(
      parseDdlStatement("ALTER TABLE IF EXISTS ONLY sales.customers ADD COLUMN x int"),
    ).toEqual({
      kind: "ALTER_TABLE",
      targets: [{ schema: "sales", table: "customers" }],
    });
  });

  it("extracts every target from a multi-table DROP TABLE", () => {
    expect(parseDdlStatement("DROP TABLE IF EXISTS customers, orders CASCADE")).toEqual({
      kind: "DROP_TABLE",
      targets: [
        { schema: "public", table: "customers" },
        { schema: "public", table: "orders" },
      ],
    });
  });

  it("extracts CREATE INDEX's target from the ON clause, with or without an index name", () => {
    expect(parseDdlStatement("CREATE INDEX idx_x ON customers (email)")).toEqual({
      kind: "CREATE_INDEX",
      targets: [{ schema: "public", table: "customers" }],
    });
    expect(
      parseDdlStatement(
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_x ON sales.customers (email)",
      ),
    ).toEqual({
      kind: "CREATE_INDEX",
      targets: [{ schema: "sales", table: "customers" }],
    });
  });

  it("is not fooled by a quoted index name containing the literal text 'ON <table>' (CWE-863 regression)", () => {
    // The index name is consumed positionally, not found by searching the
    // statement text for "ON" — a naive text search would match the "ON"
    // inside this quoted name and misreport the target as public.customers
    // instead of the real target, restricted.secrets.
    expect(
      parseDdlStatement('CREATE INDEX "i ON public.customers " ON restricted.secrets (col)'),
    ).toEqual({
      kind: "CREATE_INDEX",
      targets: [{ schema: "restricted", table: "secrets" }],
    });
  });

  it("rejects a three-part database.schema.table name rather than mis-parsing it as schema.table", () => {
    // PostgreSQL accepts this pro-forma three-part form only when `database`
    // matches the currently-connected database — this parser can't know
    // that, so it must refuse rather than silently read the wrong two parts
    // (which would drop the real table name entirely).
    expect(parseDdlStatement("CREATE TABLE mydb.restricted.secrets (id int)")).toEqual({
      kind: "CREATE_TABLE",
      targets: [],
    });
    expect(parseDdlStatement("ALTER TABLE mydb.restricted.secrets ADD COLUMN x int")).toEqual({
      kind: "ALTER_TABLE",
      targets: [],
    });
  });

  it("does not false-positive on a semicolon or keyword-looking text inside a string literal", () => {
    expect(
      parseDdlStatement(
        "CREATE TABLE t (id int, note text default 'a; DROP TABLE other -- comment')",
      ),
    ).toEqual({
      kind: "CREATE_TABLE",
      targets: [{ schema: "public", table: "t" }],
    });
  });

  it("reports DROP INDEX and anything else as UNSUPPORTED with no targets", () => {
    expect(parseDdlStatement("DROP INDEX idx_x")).toEqual({ kind: "UNSUPPORTED", targets: [] });
    expect(parseDdlStatement("SELECT 1")).toEqual({ kind: "UNSUPPORTED", targets: [] });
  });
});

describe("run_migration (#9)", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  let write: TwoPhaseWrite;
  let approval: ApprovalServerHandle;
  let baseUrl: string;
  let config: AppConfig;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await dropAllMigTables();

    config = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { schemas: ["public"] },
        // Schema-wide, not an explicit table list: run_migration's CREATE
        // TABLE targets a table that doesn't exist yet, so allowlist
        // enforcement has to work from the extracted name alone, not a
        // catalog lookup — this exercises exactly that.
        write: { schemas: ["public"] },
      },
      write: {
        ...DEFAULT_WRITE_CONFIG,
        // Deliberately huge — AC2 asserts run_migration ignores these
        // entirely. If any threshold-bypass code path accidentally applied
        // to run_migration, every test below would see `status: "previewed"`
        // instead of `"awaiting_approval"` and fail immediately.
        approvalRequiredAboveRows: 1_000_000,
        hardMaxRows: 2_000_000,
      },
      approvalServer: { enabled: true, port: 0 },
    };

    serverPools = createPools(config);
    write = new TwoPhaseWrite({
      pool: serverPools.writerPool,
      planTtlMs: config.write.planTtlMs,
      statementTimeoutMs: config.write.statementTimeoutMs,
      approvalRequiredAboveRows: config.write.approvalRequiredAboveRows,
      hardMaxRows: config.write.hardMaxRows,
      callerId: config.callerId,
    });
    const server = createServer(serverPools, config, write);

    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    approval = await startApprovalServer(write, config.approvalServer);
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await client?.close();
    await approval?.close().catch(() => {});
    await serverPools?.readonlyPool.end().catch(() => {});
    await serverPools?.writerPool.end().catch(() => {});
    await dropAllMigTables();
  });

  it("AC2: approval is required even though approvalRequiredAboveRows/hardMaxRows are configured huge — the threshold is never consulted", async () => {
    const table = migTableName();
    const reason = `mig-threshold-${randomUUID()}`;
    const preview = await client.callTool({
      name: "run_migration",
      arguments: {
        statement: `CREATE TABLE public.${table} (id serial primary key)`,
        reason,
      },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    // affected_rows is 0 — nowhere near either threshold — yet status is
    // still awaiting_approval: proof the thresholds were never checked.
    expect(body.affected_rows).toBe(0);
    expect(body.status).toBe("awaiting_approval");
  });

  it("AC1+AC5: run_migration executes DDL only after explicit approval via the approval server's HTTP endpoints, and is audited on every path", async () => {
    const table = migTableName();
    const reason = `mig-approve-${randomUUID()}`;
    const statement = `CREATE TABLE public.${table} (id serial primary key, email text not null)`;

    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");
    expect(body.target).toBe(`public.${table}`);
    // Rolled back — the preview must not have left the table behind.
    expect(await tableExists(table)).toBe(false);

    // Approve through the real HTTP endpoint — not TwoPhaseWrite called directly.
    const approveResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvedBy: "reviewer@example.com" }),
      },
    );
    expect(approveResp.status).toBe(200);
    expect(((await approveResp.json()) as { ok: boolean }).ok).toBe(true);

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(await tableExists(table)).toBe(true);
    expect(await columnExists(table, "email")).toBe(true);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual([
      "awaiting_approval",
      "approved",
      "executed",
    ]);
    for (const row of rows) {
      expect(row.reason).toBe(reason);
    }
    expect(rows[0].tool).toBe("run_migration");
    expect(rows[1].approved_by).toBe("reviewer@example.com");
  });

  it("AC3: the pending plan on GET /api/plans and the HTML page show the statement, target, and reason", async () => {
    const table = migTableName();
    const reason = `mig-pending-${randomUUID()}`;
    const statement = `CREATE TABLE public.${table} (id serial primary key)`;

    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    const resp = await fetch(`${baseUrl}/api/plans`);
    const { plans } = (await resp.json()) as { plans: Array<Record<string, unknown>> };
    const mine = plans.find((p) => p.plan_token === body.plan_token);
    expect(mine).toBeDefined();
    // The core's generalized /api/plans shape nests the SQL payload and the
    // host-rendered card (renderPlan details) instead of flattening them.
    const payload = mine!.payload as { statement: string; params: unknown[] };
    expect(payload.statement).toBe(statement);
    const render = mine!.render as { title: string; details: Array<{ label: string; value: string }> };
    const targetDetail = render.details.find((d) => d.label === "Target");
    expect(targetDetail?.value).toBe(`public.${table}`);
    expect(mine!.reason).toBe(reason);
    expect(mine!.tool).toBe("run_migration");

    const pageResp = await fetch(`${baseUrl}/`);
    const html = await pageResp.text();
    expect(html).toContain(reason);
    expect(html).toContain(`public.${table}`);
    expect(html).toContain("run_migration");
  });

  it("AC4+AC5: rejecting via the HTTP endpoint permanently kills the token, execute_plan reports PLAN_REJECTED, and the rejection is audited", async () => {
    const table = migTableName();
    const reason = `mig-reject-${randomUUID()}`;
    const statement = `CREATE TABLE public.${table} (id serial primary key)`;

    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    const rejectResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejectedBy: "reviewer@example.com", reason: "too risky, split it up" }),
      },
    );
    expect(rejectResp.status).toBe(200);

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(true);
    expect(execParsed.body.code).toBe("PLAN_REJECTED");
    expect(execParsed.body.message as string).toMatch(/too risky, split it up/);
    expect(await tableExists(table)).toBe(false);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["awaiting_approval", "rejected", "failed"]);
    expect(rows[1].approved_by).toBe("reviewer@example.com");
  });

  it("AC6: multi-statement input is rejected before ever reaching the database", async () => {
    const tableA = migTableName();
    const tableB = migTableName();
    const reason = `mig-multi-${randomUUID()}`;
    const statement = `CREATE TABLE public.${tableA} (id int); CREATE TABLE public.${tableB} (id int)`;

    const result = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("MULTI_STATEMENT");
    expect(await tableExists(tableA)).toBe(false);
    expect(await tableExists(tableB)).toBe(false);

    // Never reached TwoPhaseWrite.preview() at all — no audit row exists.
    expect(await auditRowsForReason(reason)).toHaveLength(0);
  });

  it("a statement that is neither CREATE, ALTER, nor DROP is refused before reaching the database", async () => {
    const reason = `mig-not-ddl-${randomUUID()}`;
    const result = await client.callTool({
      name: "run_migration",
      arguments: { statement: `SELECT 1`, reason },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("INVALID_INPUT");
    expect(await auditRowsForReason(reason)).toHaveLength(0);
  });

  it("AC7: a target outside the write allowlist is refused with TABLE_NOT_WRITABLE, before reaching the database", async () => {
    const reason = `mig-allowlist-${randomUUID()}`;
    // "restricted" is not in allowlist.write.schemas (only "public" is).
    const result = await client.callTool({
      name: "run_migration",
      arguments: {
        statement: `CREATE TABLE restricted.forbidden (id serial primary key)`,
        reason,
      },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("TABLE_NOT_WRITABLE");
    expect(await auditRowsForReason(reason)).toHaveLength(0);
  });

  it("CWE-863 regression: a quoted index name containing 'ON public.customers' cannot smuggle that false target past the allowlist check for the real (non-allowlisted) target", async () => {
    const reason = `mig-idx-on-bypass-${randomUUID()}`;
    // "public" is allowlisted (schema-wide), "restricted" is not. If the
    // index-name-vs-ON parsing regressed to a text search, this statement's
    // reported target would be misparsed as public.customers — which IS
    // allowlisted — and the statement would incorrectly proceed to preview
    // against the database, even though it actually targets
    // restricted.secrets. It must instead be refused as TABLE_NOT_WRITABLE
    // against the real target, before ever reaching the database.
    const result = await client.callTool({
      name: "run_migration",
      arguments: {
        statement: 'CREATE INDEX "i ON public.customers " ON restricted.secrets (col)',
        reason,
      },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("TABLE_NOT_WRITABLE");
    expect(body.message).toContain("restricted.secrets");
    expect(await auditRowsForReason(reason)).toHaveLength(0);
  });

  it("CREATE INDEX CONCURRENTLY is refused before the preview transaction begins, rather than failing with a raw Postgres 25001 error", async () => {
    const table = migTableName();
    const reason = `mig-concurrently-${randomUUID()}`;
    await serverPools.writerPool.query(
      `CREATE TABLE public.${table} (id serial primary key, email text not null)`,
    );

    const result = await client.callTool({
      name: "run_migration",
      arguments: {
        statement: `CREATE INDEX CONCURRENTLY idx_x ON public.${table} (email)`,
        reason,
      },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("INVALID_INPUT");
    // Never reached TwoPhaseWrite.preview() / BEGIN at all — no audit row exists.
    expect(await auditRowsForReason(reason)).toHaveLength(0);
  });

  it("an unsupported DDL form (DROP INDEX) is refused rather than silently skipping the allowlist check", async () => {
    const reason = `mig-unsupported-${randomUUID()}`;
    const result = await client.callTool({
      name: "run_migration",
      arguments: { statement: `DROP INDEX some_index_name`, reason },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("INVALID_INPUT");
  });

  it("ALTER TABLE previews roll back cleanly and execute_plan commits the same column, once approved", async () => {
    const table = migTableName();
    const reason = `mig-alter-${randomUUID()}`;
    // Created through the `writer` role (not the superuser) so `writer` owns
    // it — ALTER TABLE/DROP TABLE/CREATE INDEX require ownership in
    // Postgres, not just the DML grants 01-roles.sql gives `writer`, and
    // run_migration always executes as `writer` (see src/db.ts).
    await serverPools.writerPool.query(`CREATE TABLE public.${table} (id serial primary key)`);

    const statement = `ALTER TABLE public.${table} ADD COLUMN active boolean NOT NULL DEFAULT true`;
    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");
    expect(body.target).toBe(`public.${table}`);
    // Preview ran inside a transaction that rolled back — Postgres DDL is
    // transactional, so the column must not exist yet.
    expect(await columnExists(table, "active")).toBe(false);

    await fetch(`${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(exec as never).isError).toBe(false);
    expect(await columnExists(table, "active")).toBe(true);
  });

  it("DROP TABLE previews roll back cleanly and execute_plan commits the drop, once approved", async () => {
    const table = migTableName();
    const reason = `mig-drop-${randomUUID()}`;
    await serverPools.writerPool.query(`CREATE TABLE public.${table} (id serial primary key)`);
    expect(await tableExists(table)).toBe(true);

    const statement = `DROP TABLE public.${table}`;
    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");
    // Rolled back — the table must still be there after the preview.
    expect(await tableExists(table)).toBe(true);

    await fetch(`${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(exec as never).isError).toBe(false);
    expect(await tableExists(table)).toBe(false);
  });

  it("CREATE INDEX previews roll back cleanly and execute_plan commits the index, once approved", async () => {
    const table = migTableName();
    const indexName = `${table}_email_idx`;
    const reason = `mig-index-${randomUUID()}`;
    await serverPools.writerPool.query(
      `CREATE TABLE public.${table} (id serial primary key, email text not null)`,
    );

    const statement = `CREATE INDEX ${indexName} ON public.${table} (email)`;
    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");
    expect(body.target).toBe(`public.${table}`);
    expect(await indexExists(indexName)).toBe(false);

    await fetch(`${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(exec as never).isError).toBe(false);
    expect(await indexExists(indexName)).toBe(true);
  });

  it("a token replayed a second time after approval and execution is refused (single-use, same as the data write tools)", async () => {
    const table = migTableName();
    const reason = `mig-single-use-${randomUUID()}`;
    const statement = `CREATE TABLE public.${table} (id serial primary key)`;

    const preview = await client.callTool({
      name: "run_migration",
      arguments: { statement, reason },
    });
    const { body } = parseToolResult(preview as never);

    await fetch(`${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const first = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(first as never).isError).toBe(false);

    const second = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const secondParsed = parseToolResult(second as never);
    expect(secondParsed.isError).toBe(true);
    expect(secondParsed.body.code).toBe("USED_TOKEN");
  });
});
