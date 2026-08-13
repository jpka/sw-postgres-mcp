import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { TwoPhaseWrite } from "../src/writeCore.js";
import { WRITER_URL, SUPERUSER_URL, waitForDb, withSuperuser } from "./helpers.js";

const TABLE = "_audit_rows";
const CALLER_ID = "test-caller";

async function resetTable(): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await c.query(`
      CREATE TABLE ${TABLE} (
        id serial primary key,
        label text not null
      )
    `);
    await c.query(`INSERT INTO ${TABLE} (label) VALUES ('a'), ('b'), ('c')`);
  });
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

describe("mcp_audit.log migration (docker/init/02-audit-log.sql)", () => {
  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
  });

  it("creates the mcp_audit schema and log table with the documented columns", async () => {
    const cols = await withSuperuser(async (c) => {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'mcp_audit' AND table_name = 'log'
         ORDER BY ordinal_position`,
      );
      return r.rows.map((row) => row.column_name as string);
    });
    expect(cols).toEqual([
      "id",
      "ts",
      "tool",
      "reason",
      "statement",
      "params_redacted",
      "preview_rows",
      "actual_rows",
      "plan_token",
      "approved_by",
      "status",
      "duration_ms",
      "caller_id",
    ]);
  });
});

describe("mcp_audit.log is append-only at the database level", () => {
  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
  });

  it("writer can INSERT into the log, but a direct UPDATE or DELETE is refused by Postgres", async () => {
    const wr = new pg.Pool({ connectionString: WRITER_URL, max: 1 });
    const marker = `grant-test-${randomUUID()}`;
    try {
      // No RETURNING here: writer has INSERT only (no SELECT) on this table,
      // and RETURNING requires SELECT privilege on the returned columns —
      // exercising that is part of the point of this test.
      await expect(
        wr.query(
          `INSERT INTO mcp_audit.log (tool, statement, status, caller_id)
           VALUES ('test_tool', 'SELECT 1', 'previewed', $1)`,
          [marker],
        ),
      ).resolves.toBeDefined();

      const insertedId = await withSuperuser(async (c) => {
        const r = await c.query(`SELECT id FROM mcp_audit.log WHERE caller_id = $1`, [marker]);
        return r.rows[0].id as number;
      });

      await expect(
        wr.query(`UPDATE mcp_audit.log SET status = 'executed' WHERE id = $1`, [insertedId]),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        wr.query(`DELETE FROM mcp_audit.log WHERE id = $1`, [insertedId]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await wr.end();
      // Superuser cleans up the probe row so re-running this test never leaks state.
      await withSuperuser(async (c) => {
        await c.query(`DELETE FROM mcp_audit.log WHERE caller_id = $1`, [marker]);
      });
    }
  });
});

describe("audit trail wired into the two-phase write core", () => {
  let writerPool: pg.Pool;
  let tw: TwoPhaseWrite;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    writerPool = new pg.Pool({ connectionString: WRITER_URL, max: 2 });
    tw = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
      callerId: CALLER_ID,
    });
  });

  afterAll(async () => {
    await writerPool?.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    });
  });

  beforeEach(async () => {
    await resetTable();
  });

  it("a preview writes a previewed row carrying reason, statement, redacted params, duration and caller id", async () => {
    const reason = `preview-${randomUUID()}`;
    const preview = await tw.preview(`DELETE FROM ${TABLE} WHERE label = $1`, ["a"], {
      tool: "delete_rows",
      reason,
    });

    const rows = await auditRowsForReason(reason);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe("previewed");
    expect(row.tool).toBe("delete_rows");
    expect(row.reason).toBe(reason);
    expect(row.statement).toBe(`DELETE FROM ${TABLE} WHERE label = $1`);
    expect(row.plan_token).toBe(preview.planToken);
    expect(row.preview_rows).toBe(1);
    expect(row.actual_rows).toBeNull();
    expect(row.caller_id).toBe(CALLER_ID);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);

    // Redacted, not omitted: shape only, never the literal parameter value.
    expect(JSON.stringify(row.params_redacted)).not.toContain('"a"');
    expect(row.params_redacted).toEqual([{ type: "string", length: 1 }]);
  });

  it("a successful execute_plan writes an executed row with the actual affected count", async () => {
    const reason = `exec-${randomUUID()}`;
    const preview = await tw.preview(`DELETE FROM ${TABLE} WHERE label IN ('a', 'b')`, [], {
      tool: "delete_rows",
      reason,
    });
    expect(preview.affectedRows).toBe(2);

    const result = await tw.execute(preview.planToken, preview.statement, preview.params);
    expect(result.affectedRows).toBe(2);

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "executed"]);
    const executedRow = rows[1];
    expect(executedRow.plan_token).toBe(preview.planToken);
    expect(executedRow.preview_rows).toBe(2);
    expect(executedRow.actual_rows).toBe(2);
    expect(executedRow.reason).toBe(reason);
    expect(executedRow.caller_id).toBe(CALLER_ID);
    expect(executedRow.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("a failed execution (rowset changed since preview) writes a failed row", async () => {
    const reason = `fail-exec-${randomUUID()}`;
    const preview = await tw.preview(`DELETE FROM ${TABLE} WHERE label = 'a'`, [], {
      tool: "delete_rows",
      reason,
    });

    // Change the world under the preview so execute must refuse to commit.
    await withSuperuser(async (c) => {
      await c.query(`UPDATE ${TABLE} SET label = 'a' WHERE label = 'b'`);
    });

    await expect(
      tw.execute(preview.planToken, preview.statement, preview.params),
    ).rejects.toMatchObject({ code: "ROWSET_CHANGED" });

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "failed"]);
    const failedRow = rows[1];
    expect(failedRow.plan_token).toBe(preview.planToken);
    expect(failedRow.preview_rows).toBe(1);
    expect(failedRow.actual_rows).toBeNull();
    expect(failedRow.reason).toBe(reason);
    expect(failedRow.caller_id).toBe(CALLER_ID);
  });

  it("an approval writes an approved row attributed to approve_plan, not the original write tool", async () => {
    const reason = `approve-attribution-${randomUUID()}`;
    const preview = await tw.preview(`DELETE FROM ${TABLE} WHERE label = 'a'`, [], {
      tool: "delete_rows",
      reason,
    });

    await tw.approvePlan(preview.planToken, "reviewer@example.com");

    const rows = await auditRowsForReason(reason);
    expect(rows.map((r) => r.status)).toEqual(["previewed", "approved"]);
    const approvedRow = rows[1];
    // The approval event itself must be attributed to approve_plan, not
    // carried over from meta.tool (the original delete_rows preview) —
    // otherwise the audit trail misattributes the approval as a delete.
    expect(approvedRow.tool).toBe("approve_plan");
    expect(approvedRow.plan_token).toBe(preview.planToken);
    expect(approvedRow.approved_by).toBe("reviewer@example.com");
  });

  it("a failed preview (invalid statement) still writes a failed row", async () => {
    const reason = `fail-preview-${randomUUID()}`;
    await expect(
      tw.preview(`DELETE FROM ${TABLE} WHERE nonexistent_column = 1`, [], {
        tool: "delete_rows",
        reason,
      }),
    ).rejects.toThrow();

    const rows = await auditRowsForReason(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].tool).toBe("delete_rows");
    expect(rows[0].preview_rows).toBeNull();
    expect(rows[0].actual_rows).toBeNull();
    expect(rows[0].caller_id).toBe(CALLER_ID);
  });
});
