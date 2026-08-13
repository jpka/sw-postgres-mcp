import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

const TABLE = "_ins_customers";

async function resetTable(): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await c.query(`
      CREATE TABLE ${TABLE} (
        id serial primary key,
        email text not null,
        active boolean not null default true
      )
    `);
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
}): { isError: boolean; body: Record<string, unknown> } {
  const text = result.content[0].text;
  return { isError: result.isError ?? false, body: JSON.parse(text) };
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

describe("insert_rows (#8)", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;

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
      write: DEFAULT_WRITE_CONFIG,
    };

    serverPools = createPools(config);
    const server = createServer(serverPools, config);

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

  it("AC1: preview returns the exact would-be-inserted row count and a sample via RETURNING, and writes nothing", async () => {
    const reason = `insert-preview-${randomUUID()}`;
    const preview = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: ["email", "active"],
        rows: [
          ["a@example.com", true],
          ["b@example.com", false],
        ],
        reason,
      },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    expect(body.status).toBe("previewed");
    expect(body.affected_rows).toBe(2);
    expect(body.sample_rows).toHaveLength(2);
    const emails = (body.sample_rows as Array<Record<string, unknown>>).map((r) => r.email);
    expect(emails.sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(body.plan_token).toBeTruthy();

    // Nothing written yet.
    expect(await countRows()).toBe(0);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed"]);
  });

  it("AC1: execute_plan actually inserts the previewed rows, and only once", async () => {
    const reason = `insert-exec-${randomUUID()}`;
    const preview = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: ["email", "active"],
        rows: [["c@example.com", true]],
        reason,
      },
    });
    const { body } = parseToolResult(preview as never);
    expect(await countRows()).toBe(0);

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(execParsed.body.affected_rows).toBe(1);
    expect(await countRows()).toBe(1);

    const inserted = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT email, active FROM ${TABLE}`);
      return r.rows[0];
    });
    expect(inserted).toEqual({ email: "c@example.com", active: true });

    // Single-use: replaying the same token is refused and does not double-insert.
    const replay = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(replay as never).body.code).toBe("USED_TOKEN");
    expect(await countRows()).toBe(1);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "executed", "failed"]);
  });

  it("AC6: a table outside the write allowlist is refused", async () => {
    const result = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: "public.some_other_table",
        columns: ["email"],
        rows: [["x@example.com"]],
        reason: "test",
      },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("TABLE_NOT_WRITABLE");
    expect(await countRows()).toBe(0);
  });

  it("AC8: a crafted column name cannot break out of identifier context", async () => {
    // A column name shaped like an injection attempt. quoteIdentifier wraps
    // it in double quotes, so this can only ever resolve to an (nonexistent)
    // column literally named that string -- never break out into new SQL.
    const injected = 'email"; DROP TABLE ' + TABLE + '; --';
    const result = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: [injected],
        rows: [["whatever"]],
        reason: "injection-attempt",
      },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    // Refused by Postgres as an unknown column, not executed as injected SQL.
    expect(typeof body.code).toBe("string");
    // The table must still exist and be empty.
    expect(await countRows()).toBe(0);
  });

  it("AC8: a value shaped like SQL is inserted as a literal string, never executed", async () => {
    const reason = `insert-value-injection-${randomUUID()}`;
    const maliciousValue = "x'); DROP TABLE " + TABLE + "; --";
    const preview = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: ["email", "active"],
        rows: [[maliciousValue, true]],
        reason,
      },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.affected_rows).toBe(1);

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(exec as never).body.status).toBe("executed");

    // Table survived (wasn't dropped) and the value landed verbatim.
    expect(await countRows()).toBe(1);
    const stored = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT email FROM ${TABLE}`);
      return r.rows[0].email as string;
    });
    expect(stored).toBe(maliciousValue);
  });

  it("sequence gap: a rolled-back preview still consumes the serial column's sequence value", async () => {
    // Insert a real row first to get a baseline id, then preview (and never
    // execute) a second insert -- the preview's rolled-back INSERT still
    // calls nextval() on the id sequence, leaving a permanent gap.
    const first = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: ["email"],
        rows: [["first@example.com"]],
        reason: `seq-gap-baseline-${randomUUID()}`,
      },
    });
    const firstBody = parseToolResult(first as never).body;
    await client.callTool({
      name: "execute_plan",
      arguments: {
        plan_token: firstBody.plan_token,
        statement: firstBody.statement,
        params: firstBody.params,
      },
    });
    const firstId = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT id FROM ${TABLE} WHERE email = 'first@example.com'`);
      return r.rows[0].id as number;
    });

    // Preview a second insert, but never execute it -- the preview itself
    // rolls back, yet the sequence has already advanced.
    await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: ["email"],
        rows: [["never-inserted@example.com"]],
        reason: `seq-gap-preview-only-${randomUUID()}`,
      },
    });

    // A third, actually-executed insert lands on an id that skipped over
    // whatever the rolled-back preview consumed -- proving the gap.
    const third = await client.callTool({
      name: "insert_rows",
      arguments: {
        table: TABLE,
        columns: ["email"],
        rows: [["third@example.com"]],
        reason: `seq-gap-third-${randomUUID()}`,
      },
    });
    const thirdBody = parseToolResult(third as never).body;
    await client.callTool({
      name: "execute_plan",
      arguments: {
        plan_token: thirdBody.plan_token,
        statement: thirdBody.statement,
        params: thirdBody.params,
      },
    });
    const thirdId = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT id FROM ${TABLE} WHERE email = 'third@example.com'`);
      return r.rows[0].id as number;
    });

    // If the preview's rollback did NOT consume a sequence value, thirdId
    // would be firstId + 1 (no committed row in between). Because the
    // preview's INSERT still called nextval() before rolling back, thirdId
    // is at least firstId + 2 -- a gap exists.
    expect(thirdId).toBeGreaterThanOrEqual(firstId + 2);
    expect(await countRows()).toBe(2);
  });
});

describe("insert_rows: approval threshold and hard cap (#8, reusing #6)", () => {
  const TABLE2 = "_ins_appr_rows";
  const APPROVAL_REQUIRED_ABOVE_ROWS = 3;
  const HARD_MAX_ROWS = 6;

  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  let write: TwoPhaseWrite;

  function batchInsertArgs(n: number, prefix: string) {
    return {
      table: TABLE2,
      columns: ["val"],
      rows: Array.from({ length: n }, (_, i) => [`${prefix}-${i}`]),
    };
  }

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
      await c.query(`CREATE TABLE ${TABLE2} (id serial primary key, val text not null)`);
    });

    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { schemas: ["public"] },
        write: { tables: [`public.${TABLE2}`] },
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
      await c.query(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
    });
  });

  beforeEach(async () => {
    await withSuperuser(async (c) => {
      await c.query(`TRUNCATE ${TABLE2} RESTART IDENTITY`);
    });
  });

  it("a batch at or below the approval threshold is immediately executable", async () => {
    const reason = `insert-at-threshold-${randomUUID()}`;
    const preview = await client.callTool({
      name: "insert_rows",
      arguments: { ...batchInsertArgs(APPROVAL_REQUIRED_ABOVE_ROWS, "row"), reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("previewed");
    expect(body.affected_rows).toBe(3);

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(exec as never).body.status).toBe("executed");

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "executed"]);
  });

  it("a batch above the threshold (but at/below the hard cap) requires approval before execute_plan succeeds", async () => {
    const reason = `insert-awaiting-${randomUUID()}`;
    const preview = await client.callTool({
      name: "insert_rows",
      arguments: { ...batchInsertArgs(5, "row"), reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");
    expect(body.affected_rows).toBe(5);

    const refused = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(refused as never).body.code).toBe("AWAITING_APPROVAL");

    await write.approvePlan(body.plan_token as string, "reviewer@example.com");

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(execParsed.body.affected_rows).toBe(5);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual([
      "awaiting_approval",
      "failed",
      "approved",
      "executed",
    ]);
  });

  it("a batch above the hard cap is refused outright, with no token issued", async () => {
    const reason = `insert-hard-cap-${randomUUID()}`;
    const refused = await client.callTool({
      name: "insert_rows",
      arguments: { ...batchInsertArgs(7, "row"), reason },
    });
    const { isError, body } = parseToolResult(refused as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("HARD_MAX_ROWS_EXCEEDED");
    expect(body.plan_token).toBeUndefined();

    const rows = await auditRowsForReason(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("hard_cap_refused");
    expect(rows[0].preview_rows).toBe(7);
  });
});
