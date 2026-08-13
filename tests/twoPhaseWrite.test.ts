import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { createPools } from "../src/db.js";
import { DEFAULT_WRITE_CONFIG, type AppConfig } from "../src/config.js";
import { TwoPhaseWrite, WriteError, statementFingerprint } from "../src/writeCore.js";
import {
  READONLY_URL,
  WRITER_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

const TABLE = "_tw_customers";

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

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): { text: string; isError: boolean } {
  const text = result.content[0].text;
  return { text, isError: result.isError ?? false };
}

describe("two-phase write core", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  let writerPool: pg.Pool;
  let config: AppConfig;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetTable();

    writerPool = new pg.Pool({ connectionString: WRITER_URL, max: 2 });

    config = {
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
    await writerPool?.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    });
  });

  beforeEach(async () => {
    await resetTable();
  });

  it("delete_rows preview returns an exact count and sample and leaves the database unchanged", async () => {
    const result = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "active = false", reason: "test" },
    });
    const { text, isError } = parseToolResult(result as never);
    expect(isError).toBe(false);

    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("previewed");
    expect(parsed.affected_rows).toBe(2);
    expect(parsed.sample_rows).toHaveLength(2);
    expect(parsed.statement).toBe(`DELETE FROM "public"."${TABLE}" WHERE active = false`);
    expect(parsed.params).toEqual([]);
    for (const row of parsed.sample_rows) {
      expect(row.active).toBe(false);
    }

    expect(await countRows()).toBe(5);
  });

  it("execute_plan with a valid token performs the delete and commits the same rows previewed", async () => {
    const previewResult = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "active = false", reason: "test" },
    });
    const preview = JSON.parse(parseToolResult(previewResult as never).text);

    const execResult = await client.callTool({
      name: "execute_plan",
      arguments: {
        plan_token: preview.plan_token,
        statement: preview.statement,
        params: preview.params,
      },
    });
    const exec = JSON.parse(parseToolResult(execResult as never).text);
    expect(exec.status).toBe("executed");
    expect(exec.affected_rows).toBe(2);

    expect(await countRows()).toBe(3);
    const remaining = await withSuperuser(async (c) => {
      const r = await c.query(
        `SELECT bool_and(active) AS all_active FROM ${TABLE}`,
      );
      return r.rows[0].all_active;
    });
    expect(remaining).toBe(true);
  });

  it("preview leaves no connection inside an open transaction", async () => {
    await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "active = false", reason: "test" },
    });

    const r = await withSuperuser(async (c) => {
      const res = await c.query(
        `SELECT count(*)::int AS n
         FROM pg_stat_activity
         WHERE state = 'idle in transaction'
           AND usename = 'writer'
           AND datname = current_database()`,
      );
      return res.rows[0].n;
    });
    expect(r).toBe(0);
  });

  it("an expired token is refused", async () => {
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 30,
      statementTimeoutMs: 10_000,
    });
    const preview = await tw.preview(
      `DELETE FROM "public"."${TABLE}" WHERE id = $1`,
      [1],
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(
      tw.execute(preview.planToken, preview.statement, preview.params),
    ).rejects.toMatchObject({ code: "EXPIRED_TOKEN" });
    expect(await countRows()).toBe(5);
  });

  it("a token replayed a second time is refused", async () => {
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
    });
    const preview = await tw.preview(
      `DELETE FROM "public"."${TABLE}" WHERE active = false`,
      [],
    );

    const first = await tw.execute(preview.planToken, preview.statement, preview.params);
    expect(first.affectedRows).toBe(2);
    expect(await countRows()).toBe(3);

    await expect(
      tw.execute(preview.planToken, preview.statement, preview.params),
    ).rejects.toMatchObject({ code: "USED_TOKEN" });
    expect(await countRows()).toBe(3);
  });

  it("a token presented with a modified statement is refused", async () => {
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
    });
    const preview = await tw.preview(
      `DELETE FROM "public"."${TABLE}" WHERE active = false`,
      [],
    );

    await expect(
      tw.execute(
        preview.planToken,
        `DELETE FROM "public"."${TABLE}" WHERE active = true`,
        [],
      ),
    ).rejects.toMatchObject({ code: "STATEMENT_MISMATCH" });
    expect(await countRows()).toBe(5);
  });

  it("a token presented with different params is refused", async () => {
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
    });
    const preview = await tw.preview(
      `DELETE FROM "public"."${TABLE}" WHERE id = $1`,
      [1],
    );

    await expect(
      tw.execute(preview.planToken, preview.statement, [2]),
    ).rejects.toMatchObject({ code: "STATEMENT_MISMATCH" });
    expect(await countRows()).toBe(5);
  });

  it("DELETE without a WHERE clause is refused unless confirm_full_table is passed", async () => {
    const refused = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, reason: "test" },
    });
    const refusedParsed = parseToolResult(refused as never);
    expect(refusedParsed.isError).toBe(true);
    const refusedBody = JSON.parse(refusedParsed.text);
    expect(refusedBody.code).toBe("NO_WHERE_CLAUSE");
    expect(await countRows()).toBe(5);

    const confirmed = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, confirm_full_table: true, reason: "test" },
    });
    const confirmedParsed = parseToolResult(confirmed as never);
    expect(confirmedParsed.isError).toBe(false);
    const confirmedBody = JSON.parse(confirmedParsed.text);
    expect(confirmedBody.affected_rows).toBe(5);
    expect(await countRows()).toBe(5);
  });

  it("a deliberately slow statement is cut off by statement_timeout rather than hanging", async () => {
    const tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 150,
    });
    const started = Date.now();
    await expect(
      tw.preview(`DELETE FROM "public"."${TABLE}" WHERE pg_sleep(2) IS NOT NULL`, []),
    ).rejects.toMatchObject({ code: "STATEMENT_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await countRows()).toBe(5);
  });

  it("writes never run through the readonly pool", async () => {
    const roPool = new pg.Pool({ connectionString: READONLY_URL, max: 1 });
    try {
      await expect(
        roPool.query(`DELETE FROM ${TABLE} WHERE active = false`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await roPool.end();
    }

    const result = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "active = false", reason: "test" },
    });
    const parsed = parseToolResult(result as never);
    expect(parsed.isError).toBe(false);
    expect(JSON.parse(parsed.text).status).toBe("previewed");
  });

  it("a table outside the write allowlist is refused", async () => {
    const result = await client.callTool({
      name: "delete_rows",
      arguments: { table: "public.some_other_table", where: "1 = 1", reason: "test" },
    });
    const parsed = parseToolResult(result as never);
    expect(parsed.isError).toBe(true);
    expect(JSON.parse(parsed.text).code).toBe("TABLE_NOT_WRITABLE");
  });
});

describe("WriteError and fingerprinting", () => {
  it("WriteError carries a code and optional hint", () => {
    const err = new WriteError("NO_WHERE_CLAUSE", "boom", "hint text");
    expect(err.code).toBe("NO_WHERE_CLAUSE");
    expect(err.message).toBe("boom");
    expect(err.hint).toBe("hint text");
  });

  it("statementFingerprint differs when the statement or params change", () => {
    const a = statementFingerprint("DELETE FROM t WHERE id = $1", [1]);
    const b = statementFingerprint("DELETE FROM t WHERE id = $2", [1]);
    const c = statementFingerprint("DELETE FROM t WHERE id = $1", [2]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(statementFingerprint(" DELETE FROM t  ", [])).toBe(
      statementFingerprint("DELETE FROM t", []),
    );
  });
});
