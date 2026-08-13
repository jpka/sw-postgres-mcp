import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { createPools } from "../src/db.js";
import { DEFAULT_WRITE_CONFIG, type AppConfig } from "../src/config.js";
import { TwoPhaseWrite } from "../src/writeCore.js";
import { previewDeleteRows, type DeleteRowsInput } from "../src/tools/deleteRows.js";
import { previewInsertRows, type InsertRowsInput } from "../src/tools/insertRows.js";
import { previewUpdateRows, type UpdateRowsInput } from "../src/tools/updateRows.js";
import { previewRunMigration } from "../src/tools/runMigration.js";
import { describeSchema } from "../src/tools/describeSchema.js";
import {
  generateDemoDataset,
  TEST_TENANT_CUSTOMER_COUNT,
  TEST_TENANT_ORDER_COUNT,
  ORDER_STATUS_COUNTS,
} from "../scripts/seed-demo/generate.js";
import {
  READONLY_URL,
  WRITER_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

/**
 * Issue #11: a cross-cutting safety-case matrix. Unlike every other
 * *.test.ts file here (one file per ticket, testing one tool/mechanism in
 * depth), this file runs the SAME safety-property assertion against every
 * write tool it applies to (delete_rows, insert_rows, update_rows,
 * run_migration), via shared `it.each`-driven helpers, specifically to catch
 * the case where a guard was wired into one tool but silently missed on
 * another. It is deliberately NOT a duplicate of
 * tests/twoPhaseWrite.test.ts / approvalThreshold.test.ts / runMigration.test.ts
 * / insertRows.test.ts / updateRows.test.ts / auditLog.test.ts / roles.test.ts
 * (each of those already covers its own ticket's acceptance criteria in much
 * more depth for one tool at a time) — this file's job is breadth across
 * tools for one shared set of safety properties, not additional depth.
 *
 * Scratch tables, not the bare demo tables: `tests/seedDemo.test.ts`'s own
 * comment notes it is "the only test file that touches the bare customers /
 * orders / order_items / products tables" — it TRUNCATEs and reseeds them as
 * part of its own test, and Vitest can run test files concurrently against
 * the same live Postgres. Mutating those same tables here (delete_rows /
 * update_rows / insert_rows all commit real changes via execute_plan) would
 * race with that reseed. Instead, this file seeds ITS OWN tables from the
 * exact same deterministic generator (`generateDemoDataset`, issue #10) so
 * the "run against the seeded demo database" acceptance criterion is met
 * with real, realistic, deterministic data volumes and shapes (the
 * low-hundreds test-tenant group, the >10k cancelled-orders group) without
 * a second file racing to mutate the shared fixture. See the
 * "against the seeded demo dataset" describe block below.
 */

const DML_TABLE = "_safety_dml";
const NOWHERE_TABLE = "_safety_nowhere";
const APPROVAL_REQUIRED_ABOVE_ROWS = 5;
const HARD_MAX_ROWS = 15;

async function resetDmlTable(rowCount = 30): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${DML_TABLE} CASCADE`);
    await c.query(`
      CREATE TABLE ${DML_TABLE} (
        id serial primary key,
        val int not null,
        touched boolean not null default false
      )
    `);
    await c.query(
      `INSERT INTO ${DML_TABLE} (val) SELECT g FROM generate_series(1, $1) AS g`,
      [rowCount],
    );
  });
}

async function countDmlRows(): Promise<number> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${DML_TABLE}`);
    return r.rows[0].n as number;
  });
}

async function resetNowhereTable(rowCount = 4): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${NOWHERE_TABLE} CASCADE`);
    await c.query(`
      CREATE TABLE ${NOWHERE_TABLE} (
        id serial primary key,
        val int not null,
        touched boolean not null default false
      )
    `);
    await c.query(
      `INSERT INTO ${NOWHERE_TABLE} (val) SELECT g FROM generate_series(1, $1) AS g`,
      [rowCount],
    );
  });
}

async function ensureRestrictedSchema(): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`CREATE SCHEMA IF NOT EXISTS restricted`);
    await c.query(`DROP TABLE IF EXISTS restricted.secrets CASCADE`);
    await c.query(`CREATE TABLE restricted.secrets (id serial primary key, data text not null)`);
    await c.query(`INSERT INTO restricted.secrets (data) VALUES ('shh')`);
  });
}

/** A fresh, valid, unquoted Postgres identifier for run_migration's CREATE TABLE targets. */
function migTableName(): string {
  return `_safety_mig_${randomUUID().replace(/-/g, "_")}`;
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

function baseConfig(): AppConfig {
  return {
    database: {
      readonlyConnectionString: READONLY_URL,
      writerConnectionString: WRITER_URL,
    },
    allowlist: {
      read: { tables: [`public.${DML_TABLE}`] },
      // Schema-wide, not a per-table list: run_migration's CREATE TABLE
      // targets a table that doesn't exist yet at preview time (same
      // reasoning as tests/runMigration.test.ts), so this needs to cover
      // arbitrarily-named scratch tables in `public`. The `restricted`
      // schema is deliberately excluded — it stays refused for every tool
      // (scenario 8) and hidden from describe_schema regardless of this.
      write: { schemas: ["public"] },
    },
    write: {
      ...DEFAULT_WRITE_CONFIG,
      approvalRequiredAboveRows: APPROVAL_REQUIRED_ABOVE_ROWS,
      hardMaxRows: HARD_MAX_ROWS,
    },
  };
}

type DmlToolName = "delete_rows" | "insert_rows" | "update_rows";

/**
 * One entry per DML write tool, each able to build MCP call arguments that
 * affect exactly `n` rows against a freshly-reset DML_TABLE (n <= the
 * table's row count for delete/update, which matches EXISTING rows;
 * insert_rows inserts `n` brand-new rows instead, matching nothing). This is
 * the shared structure `it.each` drives every row of the matrix through —
 * the whole point being that the SAME assertion body runs against all three
 * without being copy-pasted per tool.
 */
const DML_TOOLS: Array<{
  tool: DmlToolName;
  argsForN: (n: number, reason: string) => Record<string, unknown>;
}> = [
  {
    tool: "delete_rows",
    argsForN: (n, reason) => ({ table: DML_TABLE, where: "id <= $1", params: [n], reason }),
  },
  {
    tool: "update_rows",
    argsForN: (n, reason) => ({
      table: DML_TABLE,
      set: { touched: true },
      where: "id <= $1",
      params: [n],
      reason,
    }),
  },
  {
    tool: "insert_rows",
    argsForN: (n, reason) => ({
      table: DML_TABLE,
      columns: ["val"],
      rows: Array.from({ length: n }, (_, i) => [9000 + i]),
      reason,
    }),
  },
];

describe("Safety-case integration matrix (#11)", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  let write: TwoPhaseWrite;
  let config: AppConfig;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetDmlTable();
    await ensureRestrictedSchema();

    config = baseConfig();
    serverPools = createPools(config);
    // Built explicitly (not the default TwoPhaseWrite createServer would
    // construct on its own) so this suite can call approvePlan()/rejectPlan()
    // directly, the same out-of-band way ticket #7's localhost approval UI
    // does — see tests/approvalThreshold.test.ts for the same pattern.
    write = new TwoPhaseWrite({
      pool: serverPools.writerPool,
      planTtlMs: config.write.planTtlMs,
      statementTimeoutMs: config.write.statementTimeoutMs,
      approvalRequiredAboveRows: config.write.approvalRequiredAboveRows,
      hardMaxRows: config.write.hardMaxRows,
      callerId: config.callerId,
    });
    const server = createServer(serverPools, config, write);

    client = new Client({ name: "safety-case-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    await serverPools?.readonlyPool.end().catch(() => {});
    await serverPools?.writerPool.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${DML_TABLE} CASCADE`);
      await c.query(`DROP SCHEMA IF EXISTS restricted CASCADE`);
    });
  });

  beforeEach(async () => {
    await resetDmlTable();
  });

  // ---------------------------------------------------------------------
  // 1. Threshold trip
  // ---------------------------------------------------------------------
  describe("1. threshold trip: above approval_required_above_rows -> awaiting_approval, and the token will not execute unapproved", () => {
    it.each(DML_TOOLS)("$tool", async ({ tool, argsForN }) => {
      const reason = `matrix-threshold-${tool}-${randomUUID()}`;
      // 10 rows: above APPROVAL_REQUIRED_ABOVE_ROWS (5), at/below HARD_MAX_ROWS (15).
      const preview = await client.callTool({ name: tool, arguments: argsForN(10, reason) });
      const { isError, body } = parseToolResult(preview as never);
      expect(isError).toBe(false);
      expect(body.status).toBe("awaiting_approval");
      expect(body.plan_token).toBeTruthy();

      const refused = await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });
      const refusedParsed = parseToolResult(refused as never);
      expect(refusedParsed.isError).toBe(true);
      expect(refusedParsed.body.code).toBe("AWAITING_APPROVAL");
    });

    it("run_migration: always requires approval, regardless of affected rows (always 0 for DDL) or the configured threshold", async () => {
      const table = migTableName();
      const reason = `matrix-threshold-run_migration-${randomUUID()}`;
      const preview = await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      const { isError, body } = parseToolResult(preview as never);
      expect(isError).toBe(false);
      expect(body.affected_rows).toBe(0);
      expect(body.status).toBe("awaiting_approval");

      const refused = await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });
      expect(parseToolResult(refused as never).body.code).toBe("AWAITING_APPROVAL");
    });
  });

  // ---------------------------------------------------------------------
  // 2. Hard-max refusal
  // ---------------------------------------------------------------------
  describe("2. hard-max refusal: above hard_max_rows -> refused outright, no token issued, no approval path offered", () => {
    it.each(DML_TOOLS)("$tool", async ({ tool, argsForN }) => {
      const reason = `matrix-hardcap-${tool}-${randomUUID()}`;
      // 20 rows: above HARD_MAX_ROWS (15).
      const refused = await client.callTool({ name: tool, arguments: argsForN(20, reason) });
      const { isError, body } = parseToolResult(refused as never);
      expect(isError).toBe(true);
      expect(body.code).toBe("HARD_MAX_ROWS_EXCEEDED");
      expect(body.code).not.toBe("AWAITING_APPROVAL");
      expect(body.plan_token).toBeUndefined();

      const rows = await auditRowsForReason(reason);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("hard_cap_refused");
      expect(rows[0].plan_token).toBeNull();
    });

    it("no token exists to approve after a hard-cap refusal — there is nothing lingering for an out-of-band approval to unlock", async () => {
      await expect(write.approvePlan("no-such-token-would-ever-exist")).rejects.toMatchObject({
        code: "UNKNOWN_TOKEN",
      });
    });

    // run_migration is deliberately excluded from this row of the matrix:
    // its preview's affected_rows is always 0 for DDL (writeCore.ts's
    // isDdlStatement branch), and alwaysRequireApproval (set unconditionally
    // by src/tools/runMigration.ts) means neither approvalRequiredAboveRows
    // nor hardMaxRows is ever consulted for it — there is no row count for a
    // hard cap to compare against. tests/runMigration.test.ts's AC2 already
    // proves this directly (a huge configured threshold never changes
    // run_migration's behavior).
  });

  // ---------------------------------------------------------------------
  // 3. Expired token
  // ---------------------------------------------------------------------
  describe("3. expired token: refused after TTL, for every write tool", () => {
    let shortTtlWriterPool: pg.Pool;
    let shortTtlWrite: TwoPhaseWrite;

    beforeAll(() => {
      shortTtlWriterPool = new pg.Pool({ connectionString: WRITER_URL, max: 2 });
      shortTtlWrite = new TwoPhaseWrite({
        pool: shortTtlWriterPool,
        planTtlMs: 50,
        statementTimeoutMs: 10_000,
        approvalRequiredAboveRows: APPROVAL_REQUIRED_ABOVE_ROWS,
        hardMaxRows: HARD_MAX_ROWS,
      });
    });

    afterAll(async () => {
      await shortTtlWriterPool?.end().catch(() => {});
    });

    it.each([
      {
        tool: "delete_rows" as const,
        preview: previewDeleteRows,
        input: (reason: string): DeleteRowsInput => ({ table: DML_TABLE, where: "id <= 3", reason }),
      },
      {
        tool: "update_rows" as const,
        preview: previewUpdateRows,
        input: (reason: string): UpdateRowsInput => ({
          table: DML_TABLE,
          set: { touched: true },
          where: "id <= 3",
          reason,
        }),
      },
      {
        tool: "insert_rows" as const,
        preview: previewInsertRows,
        input: (reason: string): InsertRowsInput => ({
          table: DML_TABLE,
          columns: ["val"],
          rows: [[42]],
          reason,
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[])("$tool", async ({ tool, preview: previewFn, input }) => {
      const reason = `matrix-expiry-${tool}-${randomUUID()}`;
      const preview = await previewFn(shortTtlWrite, config, input(reason));
      await new Promise((r) => setTimeout(r, 150));
      await expect(
        shortTtlWrite.execute(preview.planToken, preview.statement, preview.params),
      ).rejects.toMatchObject({ code: "EXPIRED_TOKEN" });
    });

    it("run_migration", async () => {
      const table = migTableName();
      const reason = `matrix-expiry-run_migration-${randomUUID()}`;
      const preview = await previewRunMigration(shortTtlWrite, config, {
        statement: `CREATE TABLE public.${table} (id serial primary key)`,
        reason,
      });
      await new Promise((r) => setTimeout(r, 150));
      await expect(
        shortTtlWrite.execute(preview.planToken, preview.statement, preview.params),
      ).rejects.toMatchObject({ code: "EXPIRED_TOKEN" });
      expect(await tableExists(table)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // 4. Token reuse
  // ---------------------------------------------------------------------
  describe("4. token reuse: a spent (already-executed) token is dead, refused on replay", () => {
    it.each(DML_TOOLS)("$tool", async ({ tool, argsForN }) => {
      const reason = `matrix-reuse-${tool}-${randomUUID()}`;
      // 3 rows: at/below the approval threshold — immediately executable.
      const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
      const { body } = parseToolResult(preview as never);
      expect(body.status).toBe("previewed");

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

    it("run_migration", async () => {
      const table = migTableName();
      const reason = `matrix-reuse-run_migration-${randomUUID()}`;
      const preview = await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      const { body } = parseToolResult(preview as never);
      expect(body.status).toBe("awaiting_approval");
      // Approving a plan is the same out-of-band call the localhost approval
      // UI (#7) makes — necessary here because run_migration always gates on
      // approval regardless of row count (see scenario 1 above).
      await write.approvePlan(body.plan_token as string, "reviewer@example.com");

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

  // ---------------------------------------------------------------------
  // 5. Mutated statement / mutated params
  // ---------------------------------------------------------------------
  describe("5. mutated statement / mutated params: a token presented alongside a changed statement or changed params is refused (statement-fingerprint binding)", () => {
    it.each(DML_TOOLS)("$tool: mutated statement", async ({ tool, argsForN }) => {
      const reason = `matrix-mutate-stmt-${tool}-${randomUUID()}`;
      const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
      const { body } = parseToolResult(preview as never);

      const tampered = await client.callTool({
        name: "execute_plan",
        arguments: {
          plan_token: body.plan_token,
          statement: `${body.statement} /* tampered */`,
          params: body.params,
        },
      });
      const tamperedParsed = parseToolResult(tampered as never);
      expect(tamperedParsed.isError).toBe(true);
      expect(tamperedParsed.body.code).toBe("STATEMENT_MISMATCH");
    });

    it.each(DML_TOOLS)("$tool: mutated params", async ({ tool, argsForN }) => {
      const reason = `matrix-mutate-params-${tool}-${randomUUID()}`;
      const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
      const { body } = parseToolResult(preview as never);
      const originalParams = body.params as unknown[];
      expect(originalParams.length).toBeGreaterThan(0);
      // Same shape, different content: a token bound to the original params
      // must not accept a plausible-looking substitute.
      const mutatedParams = [...originalParams];
      const last = mutatedParams[mutatedParams.length - 1];
      mutatedParams[mutatedParams.length - 1] = typeof last === "number" ? last + 999 : "tampered";

      const tampered = await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: mutatedParams },
      });
      const tamperedParsed = parseToolResult(tampered as never);
      expect(tamperedParsed.isError).toBe(true);
      expect(tamperedParsed.body.code).toBe("STATEMENT_MISMATCH");
    });

    it("run_migration: mutated statement", async () => {
      const table = migTableName();
      const reason = `matrix-mutate-stmt-run_migration-${randomUUID()}`;
      const preview = await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      const { body } = parseToolResult(preview as never);
      await write.approvePlan(body.plan_token as string);

      const tampered = await client.callTool({
        name: "execute_plan",
        arguments: {
          plan_token: body.plan_token,
          statement: `${body.statement} /* tampered */`,
          params: body.params,
        },
      });
      const tamperedParsed = parseToolResult(tampered as never);
      expect(tamperedParsed.isError).toBe(true);
      expect(tamperedParsed.body.code).toBe("STATEMENT_MISMATCH");
      expect(await tableExists(table)).toBe(false);
      // run_migration always passes params: [] (DDL text has nothing for
      // $1, $2... to bind to — see src/tools/runMigration.ts), so there is
      // no meaningful "mutated params" sub-case for this tool.
    });
  });

  // ---------------------------------------------------------------------
  // 6. Rejected plan
  // ---------------------------------------------------------------------
  describe("6. rejected plan: refused permanently, and distinguishable (by error code) from an expired token", () => {
    it.each(DML_TOOLS)("$tool", async ({ tool, argsForN }) => {
      const reason = `matrix-reject-${tool}-${randomUUID()}`;
      const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
      const { body } = parseToolResult(preview as never);

      await write.rejectPlan(body.plan_token as string, "too broad, narrow it");

      const exec = await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });
      const execParsed = parseToolResult(exec as never);
      expect(execParsed.isError).toBe(true);
      expect(execParsed.body.code).toBe("PLAN_REJECTED");
      expect(execParsed.body.code).not.toBe("EXPIRED_TOKEN");
      expect(execParsed.body.code).not.toBe("AWAITING_APPROVAL");
    });

    it("run_migration", async () => {
      const table = migTableName();
      const reason = `matrix-reject-run_migration-${randomUUID()}`;
      const preview = await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      const { body } = parseToolResult(preview as never);

      await write.rejectPlan(body.plan_token as string, "too risky");

      const exec = await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });
      const execParsed = parseToolResult(exec as never);
      expect(execParsed.isError).toBe(true);
      expect(execParsed.body.code).toBe("PLAN_REJECTED");
      expect(execParsed.body.code).not.toBe("EXPIRED_TOKEN");
      expect(execParsed.body.code).not.toBe("AWAITING_APPROVAL");
      expect(await tableExists(table)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // 7. No-WHERE rejection (delete_rows / update_rows only)
  // ---------------------------------------------------------------------
  describe("7. no-WHERE rejection: delete_rows/update_rows refuse a missing WHERE clause unless confirm_full_table is true", () => {
    beforeEach(async () => {
      await resetNowhereTable();
    });

    it.each([
      { tool: "delete_rows" as const, extraArgs: {} },
      { tool: "update_rows" as const, extraArgs: { set: { touched: true } } },
    ])("$tool", async ({ tool, extraArgs }) => {
      const refused = await client.callTool({
        name: tool,
        arguments: { table: NOWHERE_TABLE, reason: "matrix-no-where", ...extraArgs },
      });
      const refusedParsed = parseToolResult(refused as never);
      expect(refusedParsed.isError).toBe(true);
      expect(refusedParsed.body.code).toBe("NO_WHERE_CLAUSE");

      // NOWHERE_TABLE has 4 rows — comfortably at/below the 5-row approval
      // threshold, so a confirmed full-table statement here isolates the
      // no-WHERE guard specifically, without also tripping the (separately
      // tested) approval/hard-cap guards.
      const confirmed = await client.callTool({
        name: tool,
        arguments: {
          table: NOWHERE_TABLE,
          confirm_full_table: true,
          reason: "matrix-no-where-confirmed",
          ...extraArgs,
        },
      });
      const confirmedParsed = parseToolResult(confirmed as never);
      expect(confirmedParsed.isError).toBe(false);
      expect(confirmedParsed.body.status).toBe("previewed");
      expect(confirmedParsed.body.affected_rows).toBe(4);
    });

    // insert_rows and run_migration are deliberately excluded from this row
    // of the matrix — neither has a WHERE clause in the same sense (INSERT
    // has no predicate to omit; a DDL statement's text is not a DML
    // predicate either), matching the ticket's own framing of this guard.
  });

  // ---------------------------------------------------------------------
  // 8. Allowlist enforcement
  // ---------------------------------------------------------------------
  describe("8. allowlist enforcement: writes to non-allowlisted tables refused; such tables are absent from describe_schema entirely", () => {
    it.each([
      {
        tool: "delete_rows" as const,
        args: (reason: string) => ({ table: "restricted.secrets", where: "id = 1", reason }),
      },
      {
        tool: "update_rows" as const,
        args: (reason: string) => ({
          table: "restricted.secrets",
          set: { data: "x" },
          where: "id = 1",
          reason,
        }),
      },
      {
        tool: "insert_rows" as const,
        args: (reason: string) => ({
          table: "restricted.secrets",
          columns: ["data"],
          rows: [["x"]],
          reason,
        }),
      },
      {
        tool: "run_migration" as const,
        args: (reason: string) => ({
          statement: "ALTER TABLE restricted.secrets ADD COLUMN extra text",
          reason,
        }),
      },
    ])("$tool", async ({ tool, args }) => {
      const reason = `matrix-allowlist-${tool}-${randomUUID()}`;
      const result = await client.callTool({ name: tool, arguments: args(reason) });
      const { isError, body } = parseToolResult(result as never);
      expect(isError).toBe(true);
      expect(body.code).toBe("TABLE_NOT_WRITABLE");
      // Refused before ever reaching TwoPhaseWrite.preview() — no audit row.
      expect(await auditRowsForReason(reason)).toHaveLength(0);
    });

    it("describe_schema never lists restricted.secrets, even though it physically exists in the database", async () => {
      const tables = await describeSchema(serverPools.readonlyPool, config);
      const names = tables.map((t) => `${t.schema}.${t.table}`);
      expect(names).not.toContain("restricted.secrets");

      // Sanity: the table genuinely exists — this isn't trivially "passing"
      // because of a typo or a table that was never created.
      const exists = await withSuperuser(async (c) => {
        const r = await c.query(`SELECT to_regclass('restricted.secrets') AS reg`);
        return r.rows[0].reg !== null;
      });
      expect(exists).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // 9. Readonly role refused by Postgres itself
  // ---------------------------------------------------------------------
  describe("9. readonly role: a mutation attempted through the readonly connection pool is refused by Postgres itself, not just application logic", () => {
    it.each([
      { verb: "DELETE", sql: `DELETE FROM ${DML_TABLE} WHERE id = 1` },
      { verb: "INSERT", sql: `INSERT INTO ${DML_TABLE} (val) VALUES (1)` },
      { verb: "UPDATE", sql: `UPDATE ${DML_TABLE} SET val = 1 WHERE id = 1` },
      { verb: "CREATE TABLE (DDL)", sql: `CREATE TABLE _safety_readonly_ddl_probe (id int)` },
    ])("$verb is refused for the readonly role", async ({ sql }) => {
      const roPool = new pg.Pool({ connectionString: READONLY_URL, max: 1 });
      try {
        await expect(roPool.query(sql)).rejects.toThrow(/permission denied/i);
      } finally {
        await roPool.end();
        await withSuperuser(async (c) => {
          await c.query(`DROP TABLE IF EXISTS _safety_readonly_ddl_probe`);
        });
      }
    });

    it("the same DELETE succeeds through the writer role — proves the refusal above is role-scoped, not a syntax/table problem", async () => {
      const before = await countDmlRows();
      const wrPool = new pg.Pool({ connectionString: WRITER_URL, max: 1 });
      try {
        await wrPool.query(`DELETE FROM ${DML_TABLE} WHERE id = 1`);
      } finally {
        await wrPool.end();
      }
      expect(await countDmlRows()).toBe(before - 1);
    });
  });

  // ---------------------------------------------------------------------
  // 10. Audit row on every path
  // ---------------------------------------------------------------------
  describe("10. audit row on every path: previewed, approved, executed, rejected, failed — every write tool's full lifecycle leaves the right trail", () => {
    it.each(DML_TOOLS)(
      "$tool: preview -> execute leaves previewed, executed; a replay leaves a failed row",
      async ({ tool, argsForN }) => {
        const reason = `matrix-audit-happy-${tool}-${randomUUID()}`;
        const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
        const { body } = parseToolResult(preview as never);
        await client.callTool({
          name: "execute_plan",
          arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
        });
        await client.callTool({
          name: "execute_plan",
          arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
        });

        const rows = await auditRowsForReason(reason);
        expect(rows.map((r) => r.status)).toEqual(["previewed", "executed", "failed"]);
        for (const row of rows) expect(row.tool).toBe(tool);
      },
    );

    it.each(DML_TOOLS)(
      "$tool: awaiting_approval -> approved -> executed leaves the full sequence, attributing the approval to approve_plan",
      async ({ tool, argsForN }) => {
        const reason = `matrix-audit-approval-${tool}-${randomUUID()}`;
        const preview = await client.callTool({ name: tool, arguments: argsForN(10, reason) });
        const { body } = parseToolResult(preview as never);
        expect(body.status).toBe("awaiting_approval");

        await client.callTool({
          name: "execute_plan",
          arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
        });
        await write.approvePlan(body.plan_token as string, "reviewer@example.com");
        await client.callTool({
          name: "execute_plan",
          arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
        });

        const rows = await auditRowsForReason(reason);
        expect(rows.map((r) => r.status)).toEqual([
          "awaiting_approval",
          "failed",
          "approved",
          "executed",
        ]);
        expect(rows[0].tool).toBe(tool);
        expect(rows[1].tool).toBe(tool);
        expect(rows[2].tool).toBe("approve_plan");
        expect(rows[2].approved_by).toBe("reviewer@example.com");
        expect(rows[3].tool).toBe(tool);
      },
    );

    it.each(DML_TOOLS)(
      "$tool: a rejected plan leaves a rejected row (attributed to reject_plan), and a follow-up execute leaves a failed row",
      async ({ tool, argsForN }) => {
        const reason = `matrix-audit-reject-${tool}-${randomUUID()}`;
        const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
        const { body } = parseToolResult(preview as never);

        await write.rejectPlan(body.plan_token as string, "reviewer decided against it");
        await client.callTool({
          name: "execute_plan",
          arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
        });

        const rows = await auditRowsForReason(reason);
        expect(rows.map((r) => r.status)).toEqual(["previewed", "rejected", "failed"]);
        expect(rows[1].tool).toBe("reject_plan");
      },
    );

    it.each(DML_TOOLS)(
      "$tool: a hard-cap refusal leaves exactly one hard_cap_refused row and nothing else",
      async ({ tool, argsForN }) => {
        const reason = `matrix-audit-hardcap-${tool}-${randomUUID()}`;
        await client.callTool({ name: tool, arguments: argsForN(20, reason) });
        const rows = await auditRowsForReason(reason);
        expect(rows.map((r) => r.status)).toEqual(["hard_cap_refused"]);
      },
    );

    it("run_migration: full lifecycle (awaiting_approval -> approved -> executed) is audited", async () => {
      const table = migTableName();
      const reason = `matrix-audit-run_migration-${randomUUID()}`;
      const preview = await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      const { body } = parseToolResult(preview as never);
      await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });
      await write.approvePlan(body.plan_token as string, "reviewer@example.com");
      await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });

      const rows = await auditRowsForReason(reason);
      expect(rows.map((r) => r.status)).toEqual([
        "awaiting_approval",
        "failed",
        "approved",
        "executed",
      ]);
      expect(rows[0].tool).toBe("run_migration");
      expect(rows[2].tool).toBe("approve_plan");
      expect(rows[3].tool).toBe("run_migration");
    });

    it("run_migration: a rejected plan is audited as rejected, and a follow-up execute attempt as failed", async () => {
      const table = migTableName();
      const reason = `matrix-audit-reject-run_migration-${randomUUID()}`;
      const preview = await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      const { body } = parseToolResult(preview as never);
      await write.rejectPlan(body.plan_token as string, "too risky");
      await client.callTool({
        name: "execute_plan",
        arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
      });
      const rows = await auditRowsForReason(reason);
      expect(rows.map((r) => r.status)).toEqual(["awaiting_approval", "rejected", "failed"]);
    });
  });

  // ---------------------------------------------------------------------
  // 12. Preview leaves no trace
  // ---------------------------------------------------------------------
  describe("12. preview leaves no trace: after any preview (no execute_plan), the underlying data is provably unchanged, for every write tool", () => {
    it.each(DML_TOOLS)("$tool", async ({ tool, argsForN }) => {
      const before = await countDmlRows();
      const reason = `matrix-notrace-${tool}-${randomUUID()}`;
      const preview = await client.callTool({ name: tool, arguments: argsForN(3, reason) });
      expect(parseToolResult(preview as never).isError).toBe(false);
      expect(await countDmlRows()).toBe(before);
    });

    it("run_migration: a CREATE TABLE preview never leaves the table behind", async () => {
      const table = migTableName();
      const reason = `matrix-notrace-run_migration-create-${randomUUID()}`;
      await client.callTool({
        name: "run_migration",
        arguments: { statement: `CREATE TABLE public.${table} (id serial primary key)`, reason },
      });
      expect(await tableExists(table)).toBe(false);
    });

    it("run_migration: an ALTER TABLE preview never leaves the column behind", async () => {
      const table = migTableName();
      const reason = `matrix-notrace-run_migration-alter-${randomUUID()}`;
      await serverPools.writerPool.query(`CREATE TABLE public.${table} (id serial primary key)`);
      await client.callTool({
        name: "run_migration",
        arguments: { statement: `ALTER TABLE public.${table} ADD COLUMN extra text`, reason },
      });
      expect(await columnExists(table, "extra")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------
// 11. Audit immutability
// ---------------------------------------------------------------------
//
// Unlike the rest of the matrix above, this guard is not per-tool:
// mcp_audit.log is a single shared table every write tool logs to through
// the same AuditLog class (src/auditLog.ts), and the grant that makes it
// append-only (docker/init/02-audit-log.sql) is defined once, at the
// database level, for the `writer` role as a whole — not per caller or
// tool. So there is exactly one assertion here rather than one per tool.
// tests/auditLog.test.ts already covers this property in more detail; it is
// repeated here, tersely, because the ticket names it as one of the three
// guards to spot-check by deliberately weakening it (see the PR description
// for that spot-check).
describe("11. audit immutability: a direct UPDATE/DELETE against mcp_audit.log is refused for the writer role by a Postgres grant, not application code (#11)", () => {
  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
  });

  it("writer can INSERT into the log, but a direct UPDATE or DELETE is refused by Postgres", async () => {
    const wr = new pg.Pool({ connectionString: WRITER_URL, max: 1 });
    const marker = `safety-case-audit-immutability-${randomUUID()}`;
    try {
      await expect(
        wr.query(
          `INSERT INTO mcp_audit.log (tool, statement, status, caller_id) VALUES ('test_tool', 'SELECT 1', 'previewed', $1)`,
          [marker],
        ),
      ).resolves.toBeDefined();

      // `WHERE false` deliberately, not `WHERE id = $1` / `WHERE caller_id = $1`:
      // per the SQL standard, an UPDATE/DELETE whose WHERE clause reads a
      // column requires SELECT on that column *in addition to* UPDATE/DELETE
      // on the table — writer has neither here, so a column-referencing
      // WHERE clause would report "permission denied" regardless of whether
      // the UPDATE/DELETE grant itself was ever revoked, which would make
      // this spot-checkable guard indistinguishable from a different one.
      // `WHERE false` is a constant, reads no column, and needs no rows to
      // actually match — it isolates exactly the property this scenario
      // names: the UPDATE/DELETE grant on mcp_audit.log itself.
      await expect(
        wr.query(`UPDATE mcp_audit.log SET status = 'executed' WHERE false`),
      ).rejects.toThrow(/permission denied/i);
      await expect(wr.query(`DELETE FROM mcp_audit.log WHERE false`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await wr.end();
      await withSuperuser(async (c) => {
        await c.query(`DELETE FROM mcp_audit.log WHERE caller_id = $1`, [marker]);
      });
    }
  });
});

// ---------------------------------------------------------------------
// Threshold / hard-cap trip against the seeded demo dataset
// ---------------------------------------------------------------------
//
// The rest of this file uses generic scratch tables for full, deterministic
// control over every scenario. This block grounds the threshold and
// hard-cap guards (scenarios 1 and 2 above) in the actual, deterministic
// demo dataset generator from issue #10 (`generateDemoDataset`) — the same
// function `npm run seed:demo` itself calls — so the suite demonstrably
// holds against realistic seeded data volumes and shapes, not just small
// synthetic row counts. It seeds its own tables (not the bare
// `customers`/`orders` tables `tests/seedDemo.test.ts` owns — see the
// file-level comment above) with the exact same generator output.
describe("Safety-case matrix against the seeded demo dataset (#11): threshold and hard-cap trip on realistic, deterministic data", () => {
  const CUSTOMERS_TABLE = "_safety_demo_customers";
  const ORDERS_TABLE = "_safety_demo_orders";
  const APPROVAL_REQUIRED = 50;
  const HARD_MAX = 5000;

  let client: Client;
  let serverPools: ReturnType<typeof createPools>;

  async function batchInsert(
    pgClient: pg.Client,
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
        const placeholders = row.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`);
        tuples.push(`(${placeholders.join(",")})`);
        values.push(...row);
      });
      await pgClient.query(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
        values,
      );
    }
  }

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    // Same default seed `npm run seed:demo` uses (scripts/seed-demo.ts) —
    // deterministic row counts (TEST_TENANT_CUSTOMER_COUNT = 8,
    // TEST_TENANT_ORDER_COUNT = 320, ORDER_STATUS_COUNTS.cancelled = 13,200)
    // follow directly from this seed.
    const dataset = generateDemoDataset(42);

    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${ORDERS_TABLE} CASCADE`);
      await c.query(`DROP TABLE IF EXISTS ${CUSTOMERS_TABLE} CASCADE`);
      await c.query(`
        CREATE TABLE ${CUSTOMERS_TABLE} (
          id bigint primary key,
          email text not null,
          full_name text not null,
          country text not null,
          segment text not null,
          created_at timestamptz not null,
          last_login timestamptz
        )
      `);
      // ON DELETE CASCADE mirrors the real demo schema (docker/init/03-demo-schema.sql)
      // — without it, previewing a DELETE against a referenced customer row
      // would hit a live FK violation even inside a rolled-back transaction
      // (Postgres enforces FK constraints immediately, not just at commit).
      await c.query(`
        CREATE TABLE ${ORDERS_TABLE} (
          id bigint primary key,
          customer_id bigint not null references ${CUSTOMERS_TABLE}(id) ON DELETE CASCADE,
          status text not null,
          created_at timestamptz not null,
          total_amount numeric(10,2) not null
        )
      `);
    });

    const wr = new pg.Client({ connectionString: WRITER_URL });
    await wr.connect();
    try {
      await batchInsert(
        wr,
        CUSTOMERS_TABLE,
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
      await batchInsert(
        wr,
        ORDERS_TABLE,
        ["id", "customer_id", "status", "created_at", "total_amount"],
        dataset.orders.map((o) => [o.id, o.customerId, o.status, o.createdAt, o.totalAmount]),
      );
    } finally {
      await wr.end();
    }

    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { tables: [`public.${CUSTOMERS_TABLE}`, `public.${ORDERS_TABLE}`] },
        write: { tables: [`public.${CUSTOMERS_TABLE}`, `public.${ORDERS_TABLE}`] },
      },
      write: {
        ...DEFAULT_WRITE_CONFIG,
        approvalRequiredAboveRows: APPROVAL_REQUIRED,
        hardMaxRows: HARD_MAX,
      },
    };
    serverPools = createPools(config);
    const server = createServer(serverPools, config);
    client = new Client({ name: "safety-case-demo-client", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await serverPools?.readonlyPool.end().catch(() => {});
    await serverPools?.writerPool.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${ORDERS_TABLE} CASCADE`);
      await c.query(`DROP TABLE IF EXISTS ${CUSTOMERS_TABLE} CASCADE`);
    });
  });

  // All three tests below are preview-only (never call execute_plan): a
  // preview always rolls back, so these are safe to run without any
  // beforeEach reset, and leave the seeded dataset untouched for every test
  // in this block.

  it(`the ${TEST_TENANT_CUSTOMER_COUNT}-row test-tenant customer group is at/below the threshold — immediately previewable`, async () => {
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: {
        table: CUSTOMERS_TABLE,
        where: "segment = 'test_tenant'",
        reason: "demo-data-threshold-check",
      },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    expect(body.affected_rows).toBe(TEST_TENANT_CUSTOMER_COUNT);
    expect(body.status).toBe("previewed");
  });

  it(`the ${TEST_TENANT_ORDER_COUNT}-row test-tenant order group is above the threshold but at/below the hard cap — requires approval`, async () => {
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: {
        table: ORDERS_TABLE,
        where: `id <= ${TEST_TENANT_ORDER_COUNT}`,
        reason: "demo-data-awaiting-check",
      },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    expect(body.affected_rows).toBe(TEST_TENANT_ORDER_COUNT);
    expect(body.status).toBe("awaiting_approval");
  });

  it(`the ${ORDER_STATUS_COUNTS.cancelled}-row cancelled-order group is above the hard cap — refused outright, on real seeded data volume`, async () => {
    const refused = await client.callTool({
      name: "delete_rows",
      arguments: {
        table: ORDERS_TABLE,
        where: "status = 'cancelled'",
        reason: "demo-data-hardcap-check",
      },
    });
    const { isError, body } = parseToolResult(refused as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("HARD_MAX_ROWS_EXCEEDED");
    expect(body.plan_token).toBeUndefined();
  });
});
