import type pg from "pg";

export type AuditStatus =
  | "previewed"
  | "awaiting_approval"
  | "approved"
  | "executed"
  | "rejected"
  | "hard_cap_refused"
  | "failed";

export interface AuditEntry {
  tool: string;
  reason: string | null;
  statement: string;
  params: readonly unknown[];
  previewRows: number | null;
  actualRows: number | null;
  planToken: string | null;
  approvedBy: string | null;
  status: AuditStatus;
  durationMs: number;
  callerId: string;
}

/**
 * A shape descriptor for one parameter value — never the literal value.
 * Records the JS type (and, for strings, a length) so the log preserves the
 * *shape* of what a statement was called with, without ever writing a
 * literal value (a customer's email, a token, a name) into a table an
 * operator can freely query later. This is what "params_redacted" means:
 * redacted, not omitted — an operator can still tell how many parameters
 * were passed and roughly what kind they were.
 */
export function redactParams(params: readonly unknown[]): unknown[] {
  return params.map(describeShape);
}

function describeShape(value: unknown): unknown {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") return { type: "object" };
  return { type: typeof value };
}

/** Anything with pg's `.query(text, values)` shape — a Pool or a checked-out PoolClient. */
type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/**
 * Append-only audit sink for `mcp_audit.log`.
 *
 * The append-only guarantee is not this class's job to enforce — it is
 * enforced by the database grant applied in
 * docker/init/02-audit-log.sql (`writer` has INSERT on the table but
 * UPDATE and DELETE are explicitly revoked). This class only ever issues
 * INSERTs, which is all the `writer` role can do here regardless of what
 * this code asks for.
 *
 * A logging failure never masks the outcome of the write it is describing:
 * `record` catches its own errors, reports them to stderr, and returns
 * normally rather than throwing, so a lost audit row (e.g. a transient
 * connection blip) cannot be confused with — or cause — a failed database
 * write that actually succeeded.
 */
export class AuditLog {
  constructor(private pool: pg.Pool) {}

  async record(entry: AuditEntry, queryable: Queryable = this.pool): Promise<void> {
    try {
      await queryable.query(
        `INSERT INTO mcp_audit.log
           (tool, reason, statement, params_redacted, preview_rows, actual_rows,
            plan_token, approved_by, status, duration_ms, caller_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.tool,
          entry.reason,
          entry.statement,
          JSON.stringify(redactParams(entry.params)),
          entry.previewRows,
          entry.actualRows,
          entry.planToken,
          entry.approvedBy,
          entry.status,
          Math.round(entry.durationMs),
          entry.callerId,
        ] as unknown[],
      );
    } catch (err) {
      console.error("[sw-postgres-mcp] failed to write audit log entry:", err);
    }
  }
}
