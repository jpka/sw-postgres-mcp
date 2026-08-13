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

const TABLE = "_upd_customers";

async function resetTable(): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await c.query(`
      CREATE TABLE ${TABLE} (
        id serial primary key,
        email text not null,
        active boolean not null
      )
    `);
    await c.query(`
      INSERT INTO ${TABLE} (email, active) VALUES
        ('a@example.com', true),
        ('b@example.com', true),
        ('c@example.com', false),
        ('d@example.com', false),
        ('e@example.com', true)
    `);
  });
}

async function countRows(): Promise<number> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return r.rows[0].n;
  });
}

async function activeCount(): Promise<number> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE active`);
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

describe("update_rows (#8)", () => {
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

  it("AC3: preview returns the exact affected count and a post-update sample, and leaves the database unchanged", async () => {
    const reason = `update-preview-${randomUUID()}`;
    const preview = await client.callTool({
      name: "update_rows",
      arguments: {
        table: TABLE,
        set: { active: true },
        where: "active = false",
        reason,
      },
    });
    const { isError, body } = parseToolResult(preview as never);
    expect(isError).toBe(false);
    expect(body.status).toBe("previewed");
    expect(body.affected_rows).toBe(2);
    expect(body.sample_rows).toHaveLength(2);
    for (const row of body.sample_rows as Array<Record<string, unknown>>) {
      expect(row.active).toBe(true); // post-update sample
    }
    expect(body.plan_token).toBeTruthy();

    // Nothing changed yet.
    expect(await activeCount()).toBe(3);
    expect(await countRows()).toBe(5);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed"]);
  });

  it("AC3: execute_plan applies the previewed update, and only once", async () => {
    const reason = `update-exec-${randomUUID()}`;
    const preview = await client.callTool({
      name: "update_rows",
      arguments: {
        table: TABLE,
        set: { active: true },
        where: "active = false",
        reason,
      },
    });
    const { body } = parseToolResult(preview as never);
    expect(await activeCount()).toBe(3);

    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(execParsed.body.affected_rows).toBe(2);
    expect(await activeCount()).toBe(5);
    expect(await countRows()).toBe(5);

    const replay = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(replay as never).body.code).toBe("USED_TOKEN");

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "executed", "failed"]);
  });

  it("AC3: multiple SET columns and WHERE params are applied together correctly", async () => {
    const reason = `update-multi-col-${randomUUID()}`;
    const preview = await client.callTool({
      name: "update_rows",
      arguments: {
        table: TABLE,
        set: { active: false, email: "updated@example.com" },
        where: "email = $1",
        params: ["a@example.com"],
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

    const updated = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT email, active FROM ${TABLE} WHERE email = 'updated@example.com'`);
      return r.rows[0];
    });
    expect(updated).toEqual({ email: "updated@example.com", active: false });
  });

  it("AC4: UPDATE without a WHERE clause is refused unless confirm_full_table is passed (shared guard with delete_rows)", async () => {
    const refused = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE, set: { active: true }, reason: "test" },
    });
    const refusedParsed = parseToolResult(refused as never);
    expect(refusedParsed.isError).toBe(true);
    expect(refusedParsed.body.code).toBe("NO_WHERE_CLAUSE");
    expect(await activeCount()).toBe(3);

    const confirmed = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE, set: { active: true }, confirm_full_table: true, reason: "test" },
    });
    const confirmedParsed = parseToolResult(confirmed as never);
    expect(confirmedParsed.isError).toBe(false);
    expect(confirmedParsed.body.affected_rows).toBe(5);
    // Still just a preview -- nothing committed.
    expect(await activeCount()).toBe(3);
  });

  it("AC4: an always-true WHERE clause (e.g. 1=1) still counts as having a WHERE clause -- no tautology detection", async () => {
    const result = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE, set: { active: true }, where: "1=1", reason: "test" },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(false);
    expect(body.status).toBe("previewed");
    expect(body.affected_rows).toBe(5);
  });

  it("AC6: a table outside the write allowlist is refused", async () => {
    const result = await client.callTool({
      name: "update_rows",
      arguments: {
        table: "public.some_other_table",
        set: { active: true },
        where: "1 = 1",
        reason: "test",
      },
    });
    const { isError, body } = parseToolResult(result as never);
    expect(isError).toBe(true);
    expect(body.code).toBe("TABLE_NOT_WRITABLE");
  });

  it("AC8: a crafted column name in `set` cannot break out of identifier context", async () => {
    const injected = 'active"; DROP TABLE ' + TABLE + '; --';
    const result = await client.callTool({
      name: "update_rows",
      arguments: {
        table: TABLE,
        set: { [injected]: true },
        where: "id = 1",
        reason: "injection-attempt",
      },
    });
    const { isError } = parseToolResult(result as never);
    expect(isError).toBe(true);
    // Table survives -- the crafted key never escaped identifier position.
    expect(await countRows()).toBe(5);
  });

  it("AC8: a crafted value in `set` or `where` params is treated as a literal, not executed", async () => {
    const reason = `update-value-injection-${randomUUID()}`;
    const maliciousValue = "x'); DROP TABLE " + TABLE + "; --";
    const preview = await client.callTool({
      name: "update_rows",
      arguments: {
        table: TABLE,
        set: { email: maliciousValue },
        where: "email = $1",
        params: ["a@example.com"],
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

    // Table survived and the literal value landed verbatim.
    expect(await countRows()).toBe(5);
    const stored = await withSuperuser(async (c) => {
      const r = await c.query(`SELECT email FROM ${TABLE} WHERE email = $1`, [maliciousValue]);
      return r.rows[0]?.email as string | undefined;
    });
    expect(stored).toBe(maliciousValue);
  });

  it("AC7: preview and execute are audited with the reason; a refused no-WHERE attempt never reaches the audit log", async () => {
    const reason = `update-audit-${randomUUID()}`;

    const refused = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE, set: { active: true }, reason },
    });
    expect(parseToolResult(refused as never).isError).toBe(true);

    const preview = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE, set: { active: true }, where: "active = false", reason },
    });
    const { body } = parseToolResult(preview as never);

    await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });

    // The NO_WHERE_CLAUSE refusal happens entirely inside the tool function
    // before write.preview() is ever called, so it is not itself an audited
    // TwoPhaseWrite event -- only the actual preview/execute pair is.
    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "executed"]);
    expect(rows[0].tool).toBe("update_rows");
    expect(rows[1].tool).toBe("update_rows");
  });
});

describe("update_rows: approval threshold and hard cap (#8, reusing #6)", () => {
  const TABLE2 = "_upd_appr_rows";
  const APPROVAL_REQUIRED_ABOVE_ROWS = 3;
  const HARD_MAX_ROWS = 6;

  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  let write: TwoPhaseWrite;

  async function resetTable2(rowCount = 20): Promise<void> {
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE2} CASCADE`);
      await c.query(`CREATE TABLE ${TABLE2} (id serial primary key, val int not null, touched boolean not null default false)`);
      await c.query(
        `INSERT INTO ${TABLE2} (val) SELECT g FROM generate_series(1, $1) AS g`,
        [rowCount],
      );
    });
  }

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetTable2();

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
    await resetTable2();
  });

  it("AC5: an update at or below the approval threshold is immediately executable", async () => {
    const reason = `update-at-threshold-${randomUUID()}`;
    const preview = await client.callTool({
      name: "update_rows",
      arguments: {
        table: TABLE2,
        set: { touched: true },
        where: `id <= ${APPROVAL_REQUIRED_ABOVE_ROWS}`,
        reason,
      },
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

  it("AC5: an update above the threshold (but at/below the hard cap) requires approval before execute_plan succeeds", async () => {
    const reason = `update-awaiting-${randomUUID()}`;
    const preview = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE2, set: { touched: true }, where: "id <= 5", reason },
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

  it("AC5: an update above the hard cap is refused outright, with no token issued", async () => {
    const reason = `update-hard-cap-${randomUUID()}`;
    const refused = await client.callTool({
      name: "update_rows",
      arguments: { table: TABLE2, set: { touched: true }, where: "id <= 7", reason },
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
