import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { createPools } from "../src/db.js";
import { DEFAULT_WRITE_CONFIG, type AppConfig } from "../src/config.js";
import { TwoPhaseWrite } from "../src/writeCore.js";
import {
  READONLY_URL,
  WRITER_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

const TABLE = "_appr_rows";

// Small, easy-to-reason-about thresholds for this suite: 3 (approval) / 6
// (hard cap). Ticket #6's acceptance criteria for the *default* values
// (100 / 10_000) and for config-overridability in general are covered in
// tests/config.test.ts; this file proves the thresholds actually gate
// preview/execute/approve behavior once wired through the server, using
// deliberately non-default numbers so a hardcoded 100/10_000 in the
// implementation could never make these tests pass by accident.
const APPROVAL_REQUIRED_ABOVE_ROWS = 3;
const HARD_MAX_ROWS = 6;

async function resetTable(rowCount = 20): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await c.query(`CREATE TABLE ${TABLE} (id serial primary key, val int not null)`);
    await c.query(
      `INSERT INTO ${TABLE} (val) SELECT g FROM generate_series(1, $1) AS g`,
      [rowCount],
    );
  });
}

async function countRows(): Promise<number> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return r.rows[0].n;
  });
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): { text: string; isError: boolean; body: Record<string, unknown> } {
  const text = result.content[0].text;
  return { text, isError: result.isError ?? false, body: JSON.parse(text) };
}

/** Rows written for one test's unique `reason`, oldest first. */
async function auditRowsForReason(reason: string): Promise<Record<string, unknown>[]> {
  return withSuperuser(async (c) => {
    const r = await c.query(
      `SELECT * FROM mcp_audit.log WHERE reason = $1 ORDER BY id ASC`,
      [reason],
    );
    return r.rows;
  });
}

describe("approval threshold, hard row cap, and awaiting_approval (#6)", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  // approve_plan is deliberately NOT an MCP tool (the requesting agent must
  // not be able to approve its own gated plan — see src/server.ts and
  // DECISIONS.md). Tests that need to approve a plan call this same
  // TwoPhaseWrite instance's approvePlan() directly, the way ticket #7's
  // human approval surface will, instead of going through the MCP client.
  let write: TwoPhaseWrite;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetTable();

    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { schemas: ["public"] },
        write: { tables: [`public.${TABLE}`] },
      },
      write: {
        ...DEFAULT_WRITE_CONFIG,
        approvalRequiredAboveRows: APPROVAL_REQUIRED_ABOVE_ROWS,
        hardMaxRows: HARD_MAX_ROWS,
      },
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
  });

  afterAll(async () => {
    await client?.close();
    await serverPools?.readonlyPool.end().catch(() => {});
    await serverPools?.writerPool.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    });
  });

  beforeEach(async () => {
    await resetTable();
  });

  it("AC1: a preview at or below the approval threshold returns an immediately-executable token", async () => {
    const reason = `at-threshold-${randomUUID()}`;
    // Exactly APPROVAL_REQUIRED_ABOVE_ROWS (3) rows — "at" the threshold,
    // must behave like today (unchanged), not like the awaiting_approval path.
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: `id <= ${APPROVAL_REQUIRED_ABOVE_ROWS}`, reason },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    expect(body.status).toBe("previewed");
    expect(body.affected_rows).toBe(3);
    expect(body.plan_token).toBeTruthy();

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(execParsed.body.affected_rows).toBe(3);
    expect(await countRows()).toBe(17);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "executed"]);
  });

  it("AC2: a preview above the approval threshold returns awaiting_approval, and execute_plan refuses it while unapproved", async () => {
    const reason = `awaiting-${randomUUID()}`;
    // 5 rows: above the 3-row approval threshold, at or below the 6-row hard cap.
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 5", reason },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    expect(body.status).toBe("awaiting_approval");
    expect(body.plan_token).toBeTruthy();
    expect(body.affected_rows).toBe(5);
    expect(body.sample_rows).toHaveLength(5);
    expect(typeof body.message).toBe("string");
    expect(body.message as string).toMatch(/approv/i);

    const refused = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const refusedParsed = parseToolResult(refused as never);
    expect(refusedParsed.isError).toBe(true);
    expect(refusedParsed.body.code).toBe("AWAITING_APPROVAL");
    expect(await countRows()).toBe(20);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["awaiting_approval", "failed"]);
    expect(rows[0].preview_rows).toBe(5);
    expect(rows[1].plan_token).toBe(body.plan_token);
  });

  it("AC3: once approved via TwoPhaseWrite.approvePlan(), execute_plan succeeds", async () => {
    const reason = `approved-then-exec-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 5", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    // approve_plan is not an MCP tool (see beforeAll comment above) — approve
    // through the shared TwoPhaseWrite instance directly, as the future
    // human approval surface (#7) will.
    await expect(
      write.approvePlan(body.plan_token as string, "reviewer@example.com"),
    ).resolves.toBeUndefined();

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(execParsed.body.affected_rows).toBe(5);
    expect(await countRows()).toBe(15);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual([
      "awaiting_approval",
      "approved",
      "executed",
    ]);
    expect(rows[1].approved_by).toBe("reviewer@example.com");
    expect(rows[1].plan_token).toBe(body.plan_token);
    expect(rows[2].plan_token).toBe(body.plan_token);
  });

  it("AC3b: approving a plan that never required approval is harmless, and it still executes once", async () => {
    const reason = `approve-noop-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 2", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("previewed");

    await expect(
      write.approvePlan(body.plan_token as string),
    ).resolves.toBeUndefined();

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(exec as never).body.status).toBe("executed");
  });

  it("AC4: a preview above hard_max_rows is refused outright with no token, distinct from the approval case", async () => {
    const reason = `hard-cap-${randomUUID()}`;
    // 7 rows: above the 6-row hard cap.
    const refused = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 7", reason },
    });
    const { isError, body } = parseToolResult(refused as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("HARD_MAX_ROWS_EXCEEDED");
    expect(body.code).not.toBe("AWAITING_APPROVAL");
    expect(body.plan_token).toBeUndefined();
    expect(body.hint).toBeTruthy();
    expect(await countRows()).toBe(20);

    const rows = await auditRowsForReason(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("hard_cap_refused");
    expect(rows[0].preview_rows).toBe(7);
    expect(rows[0].plan_token).toBeNull();
    expect(rows[0].actual_rows).toBeNull();
  });

  it("AC4b: a hard-cap refusal issues no usable token — there is nothing later approval could unlock", async () => {
    const reason = `hard-cap-no-token-${randomUUID()}`;
    const refused = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 10", reason },
    });
    const { body } = parseToolResult(refused as never);
    expect(body.plan_token).toBeUndefined();

    // Even attempting to approve a plausible-looking token is refused as unknown;
    // there is no plan floating around that a human could mistakenly approve.
    // approve_plan is not an MCP tool, so this goes through TwoPhaseWrite directly.
    await expect(write.approvePlan("not-a-real-token")).rejects.toMatchObject({
      code: "UNKNOWN_TOKEN",
    });
  });

  it("AC7: both thresholds are independently configurable, not hardcoded", async () => {
    // A second server instance wired with different (still non-default)
    // thresholds behaves differently for the same row counts, proving the
    // values flow through config rather than being fixed constants.
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS _appr_rows_b CASCADE`);
      await c.query(`CREATE TABLE _appr_rows_b (id serial primary key, val int not null)`);
      await c.query(
        `INSERT INTO _appr_rows_b (val) SELECT g FROM generate_series(1, 20) AS g`,
      );
    });

    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { schemas: ["public"] },
        write: { tables: ["public._appr_rows_b"] },
      },
      write: {
        ...DEFAULT_WRITE_CONFIG,
        approvalRequiredAboveRows: 12,
        hardMaxRows: 15,
      },
    };
    const pools2 = createPools(config);
    const server2 = createServer(pools2, config);
    const client2 = new Client({ name: "test-client-2", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct), server2.connect(st)]);

    try {
      // 5 rows is above THIS suite's 3-row threshold but not this second
      // server's 12-row threshold: same statement shape, different outcome.
      const preview = await client2.callTool({
        name: "delete_rows",
        arguments: { table: "_appr_rows_b", where: "id <= 5", reason: "cross-config" },
      });
      const { body } = parseToolResult(preview as never);
      expect(body.status).toBe("previewed");

      const refused = await client2.callTool({
        name: "delete_rows",
        arguments: { table: "_appr_rows_b", where: "id <= 16", reason: "cross-config-hard" },
      });
      const refusedParsed = parseToolResult(refused as never);
      expect(refusedParsed.isError).toBe(true);
      expect(refusedParsed.body.code).toBe("HARD_MAX_ROWS_EXCEEDED");
    } finally {
      await client2.close();
      await pools2.readonlyPool.end().catch(() => {});
      await pools2.writerPool.end().catch(() => {});
      await withSuperuser(async (c) => {
        await c.query(`DROP TABLE IF EXISTS _appr_rows_b CASCADE`);
      });
    }
  });
});

describe("threshold comparisons use the exact rollback-preview count, not EXPLAIN's estimate (#6 AC5)", () => {
  const SKEW_TABLE = "_appr_estimate_skew";
  let writerPool: pg.Pool;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    writerPool = new pg.Pool({ connectionString: WRITER_URL, max: 2 });

    // Two perfectly-correlated columns (b always equals a) with 200 distinct
    // values each, 100 rows per value, ANALYZEd so the planner has real
    // single-column stats but — with no extended statistics created — no
    // idea the columns are correlated. Standard Postgres cardinality
    // misestimation case: for `WHERE a = 1 AND b = 1` the planner multiplies
    // the two columns' independent selectivities (1/200 * 1/200), grossly
    // *underestimating* what is actually every one of the 100 rows for that
    // value. That gap is the whole point of this test: if the threshold
    // check used EXPLAIN's estimate instead of the exact rollback count, a
    // 100-row delete would sail under a threshold well above 1 but below
    // 100 — it would not.
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${SKEW_TABLE} CASCADE`);
      await c.query(`CREATE TABLE ${SKEW_TABLE} (id serial primary key, a int not null, b int not null)`);
      await c.query(`
        INSERT INTO ${SKEW_TABLE} (a, b)
        SELECT (g % 200) + 1, (g % 200) + 1
        FROM generate_series(1, 20000) AS g
      `);
      await c.query(`ANALYZE ${SKEW_TABLE}`);
    });
  });

  afterAll(async () => {
    await writerPool?.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${SKEW_TABLE} CASCADE`);
    });
  });

  it("EXPLAIN's row estimate for the skewed predicate is far below the exact affected count", async () => {
    const explainResult = await withSuperuser(async (c) => {
      const r = await c.query(
        `EXPLAIN (FORMAT JSON) DELETE FROM ${SKEW_TABLE} WHERE a = 1 AND b = 1`,
      );
      const plan = r.rows[0]["QUERY PLAN"] as Array<{ Plan?: { "Plan Rows"?: number } }>;
      return plan[0]?.Plan?.["Plan Rows"] ?? 0;
    });
    const actual = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM ${SKEW_TABLE} WHERE a = 1 AND b = 1`);
      return r.rows[0].n as number;
    });

    expect(actual).toBe(100);
    // The whole scenario only proves anything if the estimate is genuinely,
    // grossly wrong relative to the actual count.
    expect(explainResult).toBeLessThan(10);
    expect(explainResult).toBeLessThan(actual);
  });

  it("a threshold between the EXPLAIN estimate and the exact count trips awaiting_approval — proving the exact count is what's compared", async () => {
    // approvalRequiredAboveRows = 50: below the true 100-row match, but far
    // above EXPLAIN's (<10) estimate. Using the estimate would return
    // status "previewed"; using the exact rollback count must return
    // "awaiting_approval".
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
      approvalRequiredAboveRows: 50,
      hardMaxRows: 1000,
    });

    const preview = await tw.preview(
      `DELETE FROM ${SKEW_TABLE} WHERE a = 1 AND b = 1`,
      [],
      { tool: "delete_rows", reason: "skew-check" },
    );

    expect(preview.affectedRows).toBe(100);
    expect(preview.status).toBe("awaiting_approval");
  });

  it("the same exact-count logic also refuses outright once past hard_max_rows, using the true count", async () => {
    // hardMaxRows = 50, same skewed predicate as above (exact count 100).
    // EXPLAIN's estimate (<10) would sail under 50; the exact count (100)
    // must not.
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
      approvalRequiredAboveRows: 10,
      hardMaxRows: 50,
    });

    await expect(
      tw.preview(`DELETE FROM ${SKEW_TABLE} WHERE a = 1 AND b = 1`, [], {
        tool: "delete_rows",
        reason: "skew-hard-cap-check",
      }),
    ).rejects.toMatchObject({ code: "HARD_MAX_ROWS_EXCEEDED" });
  });
});
