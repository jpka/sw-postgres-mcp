import type pg from "pg";
import {
  PlanStore,
  PlanError,
  fingerprint,
  NoopSink,
  type ApprovalDecision,
  type ApproveResult,
  type PlanErrorCode,
  type PlanMeta,
  type RejectResult,
} from "safe-write-mcp-core";
import { AuditLog } from "./auditLog.js";

export type WriteErrorCode =
  | "UNKNOWN_TOKEN"
  | "EXPIRED_TOKEN"
  | "USED_TOKEN"
  | "STATEMENT_MISMATCH"
  | "ROWSET_CHANGED"
  | "STATEMENT_TIMEOUT"
  | "NO_WHERE_CLAUSE"
  | "TABLE_NOT_WRITABLE"
  | "INVALID_TABLE_NAME"
  | "INVALID_INPUT"
  | "AWAITING_APPROVAL"
  | "HARD_MAX_ROWS_EXCEEDED"
  | "PLAN_REJECTED";

export class WriteError extends Error {
  readonly code: WriteErrorCode;
  readonly hint?: string;

  constructor(code: WriteErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "WriteError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * The agent-facing MCP tool surface keeps this server's historical error
 * vocabulary; the core's generalized PlanError codes are translated at the
 * boundary. The two vocabularies describe the same lifecycle events. Keyed
 * by PlanErrorCode so adding a code to the core forces a mapping decision
 * here at compile time.
 */
const CODE_MAP: Record<PlanErrorCode, WriteErrorCode> = {
  UNKNOWN_TOKEN: "UNKNOWN_TOKEN",
  PLAN_EXPIRED: "EXPIRED_TOKEN",
  PLAN_USED: "USED_TOKEN",
  PLAN_MISMATCH: "STATEMENT_MISMATCH",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  PLAN_REJECTED: "PLAN_REJECTED",
};

function mapPlanError(err: PlanError): WriteError {
  const code = CODE_MAP[err.code];
  return new WriteError(code, err.message, err.hint);
}

export interface WritePreview {
  planToken: string;
  affectedRows: number;
  sampleRows: unknown[];
  /** The exact statement that execute_plan must replay. */
  statement: string;
  /** The exact params that execute_plan must replay. */
  params: readonly unknown[];
  /**
   * "previewed" — the token is usable via execute_plan right away.
   * "awaiting_approval" — either affectedRows exceeded
   * approvalRequiredAboveRows, or the caller forced approval via
   * `WriteMeta.alwaysRequireApproval` (run_migration, ticket #9) regardless
   * of row count; the token exists but execute_plan refuses it until
   * approvePlan is called.
   */
  status: "previewed" | "awaiting_approval";
  /**
   * Schema-qualified target this statement acts on (e.g. "public.customers"),
   * when known ahead of preview — set by run_migration (ticket #9) so a
   * human approval surface has something to judge a DDL statement by beyond
   * affectedRows/sampleRows, which for DDL are always 0/[] (see
   * `isDdlStatement` below). null for every other tool: their affected rows
   * and sample rows already identify what the statement touches.
   */
  target: string | null;
}

export interface ExecuteResult {
  affectedRows: number;
}

export interface TwoPhaseWriteOptions {
  pool: pg.Pool;
  planTtlMs: number;
  statementTimeoutMs: number;
  /**
   * A preview whose exact rollback-preview affectedRows is at or below this
   * returns an immediately-executable token. Above it, the preview returns
   * `status: "awaiting_approval"` and the token needs `approvePlan` first.
   * Default 100 (see config.ts DEFAULT_WRITE_CONFIG).
   */
  approvalRequiredAboveRows?: number;
  /**
   * A preview whose exact rollback-preview affectedRows exceeds this is
   * refused outright: no token is issued. Must be >= approvalRequiredAboveRows.
   * Default 10_000 (see config.ts DEFAULT_WRITE_CONFIG).
   */
  hardMaxRows?: number;
  /** Identity recorded as `caller_id` on every audit row this instance writes. Default "unknown". */
  callerId?: string;
  /** Audit sink. Defaults to an `AuditLog` writing through `pool` (the writer role). */
  auditLog?: AuditLog;
}

const DEFAULT_APPROVAL_REQUIRED_ABOVE_ROWS = 100;
const DEFAULT_HARD_MAX_ROWS = 10_000;

/** Per-call context recorded onto the audit trail. `tool` names the MCP tool driving this preview. */
export interface WriteMeta {
  tool: string;
  reason?: string | null;
  /**
   * Forces `status: "awaiting_approval"` regardless of affectedRows vs
   * `approvalRequiredAboveRows` — the mechanism ticket #9 (`run_migration`)
   * needs so DDL always requires human approval, since a migration
   * affecting zero rows can still be destructive and row count is
   * deliberately not the gate for it. Must only ever be set to `true` by a
   * tool module's own code (e.g. `src/tools/runMigration.ts` hardcodes it on
   * every call) — it is never read from `input`/agent-supplied arguments, so
   * there is no field in `run_migration`'s MCP tool schema that reaches this
   * and no way for the calling agent to set or unset it. See DECISIONS.md.
   * Default false/undefined.
   */
  alwaysRequireApproval?: boolean;
  /** See WritePreview.target. Default null. */
  target?: string | null;
}

const DEFAULT_WRITE_META: WriteMeta = { tool: "unknown_tool" };

/**
 * The preview payload a plan token is bound to: the exact statement + params
 * the preview ran. The core fingerprints this payload and refuses an
 * execute whose payload no longer matches (PLAN_MISMATCH, surfaced to the
 * agent as STATEMENT_MISMATCH).
 */
export interface SqlPayload {
  statement: string;
  params: readonly unknown[];
}

function payloadFor(statement: string, params: readonly unknown[]): SqlPayload {
  // Trimmed so an agent echoing the preview response back with stray
  // surrounding whitespace still matches — the same tolerance the pre-core
  // statementFingerprint provided.
  return { statement: statement.trim(), params };
}

/**
 * The core's PlanStore plus a capture of the last approve()/reject()
 * outcome. The core's approval HTTP server reports every decision through an
 * `onDecision` hook that carries the action, actor, and outcome — but not
 * the plan's metadata — and this server's audit rows need that metadata
 * (tool, reason, caller, preview row count) for full attribution. The
 * capture below is what bridges the two: `TwoPhaseWrite.recordApprovalDecision`
 * reads it when the hook fires. A single slot is safe because the core's
 * request handler calls approve()/reject() and the hook within one
 * uninterrupted synchronous segment, so two decisions cannot interleave
 * between a capture and its read.
 */
class PostgresPlanStore extends PlanStore<SqlPayload> {
  lastDecision: { planToken: string; meta: PlanMeta | null; startedAt: number } | null = null;

  override approve(planToken: string): ApproveResult {
    const startedAt = Date.now();
    const result = super.approve(planToken);
    this.lastDecision = { planToken, meta: result.meta, startedAt };
    return result;
  }

  override reject(planToken: string, reason: string | null): RejectResult {
    const startedAt = Date.now();
    const result = super.reject(planToken, reason);
    this.lastDecision = { planToken, meta: result.meta, startedAt };
    return result;
  }
}

/**
 * Two-phase write machinery. A preview runs the statement inside a transaction,
 * captures the exact affected row count, a sample of affected rows via
 * RETURNING, and a digest of the full affected row set, then rolls back. The
 * returned token lets `execute` replay the identical statement and commit, but
 * only once, before expiry, for the exact statement+params the token was bound
 * to, and only if the affected row set still matches the preview. `execute`
 * recomputes the digest inside its own transaction and refuses to commit if it
 * differs, so concurrent inserts/updates cannot cause rows outside the approved
 * preview to be deleted.
 *
 * The plan-token lifecycle itself (single-use, expiry, fingerprint binding,
 * approval gating, rejection tombstones) is owned by `safe-write-mcp-core`'s
 * PlanStore; this class supplies the Postgres-specific halves — the
 * preview/execute SQL, the ROWSET_CHANGED digest re-check, and the
 * `mcp_audit.log` rows (the core's AuditSink is deliberately left as
 * NoopSink: this server writes richer audit rows itself, and double-writing
 * would corrupt the per-plan status sequences operators query for).
 *
 * The preview and the execute never share an open transaction: each call
 * checks out its own connection from the pool, so no transaction is left open
 * while the agent is deciding whether to execute.
 */
export class TwoPhaseWrite {
  private store: PostgresPlanStore;
  private auditLog: AuditLog;
  private callerId: string;
  private approvalRequiredAboveRows: number;
  private hardMaxRows: number;

  constructor(private opts: TwoPhaseWriteOptions) {
    this.store = new PostgresPlanStore({
      planTtlMs: opts.planTtlMs,
      audit: NoopSink,
    });
    this.auditLog = opts.auditLog ?? new AuditLog(opts.pool);
    this.callerId = opts.callerId ?? "unknown";
    this.approvalRequiredAboveRows =
      opts.approvalRequiredAboveRows ?? DEFAULT_APPROVAL_REQUIRED_ABOVE_ROWS;
    this.hardMaxRows = opts.hardMaxRows ?? DEFAULT_HARD_MAX_ROWS;
  }

  /**
   * The core plan store backing this instance. Shared with the localhost
   * approval server (see src/approvalServer.ts) so an approve/reject there
   * is visible to `execute` here — plan tokens are in-memory and
   * process-scoped (see DECISIONS.md).
   */
  get planStore(): PlanStore<SqlPayload> {
    return this.store;
  }

  async preview(
    statement: string,
    params: readonly unknown[],
    meta: WriteMeta = DEFAULT_WRITE_META,
  ): Promise<WritePreview> {
    const startedAt = Date.now();
    const reason = meta.reason ?? null;
    const target = meta.target ?? null;
    const client = await this.opts.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.opts.statementTimeoutMs}`);
      await client.query("BEGIN");

      let affectedRows: number;
      let sampleRows: unknown[];
      let rowsDigest: string;
      if (isDdlStatement(statement)) {
        // DDL has no RETURNING clause to wrap, so there is no "affected
        // rows"/"sample rows" concept to capture the way DELETE/UPDATE/INSERT
        // have — 0/[] here is not a stand-in row count, it is the accurate
        // answer for a statement with no rows to return (see DECISIONS.md).
        // The statement still runs inside this same BEGIN/ROLLBACK, so a
        // CREATE TABLE/ALTER TABLE preview is a real, rolled-back DDL
        // execution — Postgres DDL is transactional, so this rolls back
        // cleanly like any other preview.
        await client.query(statement, params as unknown[]);
        affectedRows = 0;
        sampleRows = [];
        rowsDigest = "";
      } else {
        const res = await client.query(this.previewSql(statement), params as unknown[]);
        const row = res.rows[0] as {
          affected_rows: number;
          sample_rows: unknown;
          rows_digest: string;
        };
        // The exact count from the rolled-back preview — never an EXPLAIN
        // estimate. Both thresholds below compare against this number.
        affectedRows = Number(row.affected_rows);
        sampleRows = Array.isArray(row.sample_rows) ? row.sample_rows : [];
        rowsDigest = row.rows_digest;
      }
      await client.query("ROLLBACK");

      if (affectedRows > this.hardMaxRows) {
        // A wall, not a gate: no token is issued, there is nothing to
        // approve, and the response must read as final rather than as
        // something to escalate past.
        await this.auditLog.record(
          {
            tool: meta.tool,
            reason,
            statement,
            params,
            previewRows: affectedRows,
            actualRows: null,
            planToken: null,
            approvedBy: null,
            status: "hard_cap_refused",
            durationMs: Date.now() - startedAt,
            callerId: this.callerId,
          },
          client,
        );
        throw new WriteError(
          "HARD_MAX_ROWS_EXCEEDED",
          `This statement would affect ${affectedRows} rows, above the hard cap of ${this.hardMaxRows}. No plan token was issued and there is no approval path for this — it cannot be executed as written.`,
          "Rewrite the statement to affect fewer rows (e.g. a narrower WHERE clause or batching), then re-preview.",
        );
      }

      const created = this.store.create(payloadFor(statement, params), {
        tool: meta.tool,
        reason,
        callerId: this.callerId,
        previewCount: affectedRows,
        // Kept verbatim (including '' for an empty row set): execute()
        // re-compares it, and an empty preview digest must still trip
        // ROWSET_CHANGED if rows enter the predicate before execution.
        dataDigest: rowsDigest,
        approvalRequired: affectedRows > this.approvalRequiredAboveRows,
        alwaysRequireApproval: meta.alwaysRequireApproval,
        extra: { target, sampleRows },
      });

      // Recorded on the same connection, after ROLLBACK has ended the preview
      // transaction, so the audit row survives the rollback that undoes the
      // preview itself.
      await this.auditLog.record(
        {
          tool: meta.tool,
          reason,
          statement,
          params,
          previewRows: affectedRows,
          actualRows: null,
          planToken: created.planToken,
          approvedBy: null,
          status: created.status,
          durationMs: Date.now() - startedAt,
          callerId: this.callerId,
        },
        client,
      );

      return {
        planToken: created.planToken,
        affectedRows,
        sampleRows,
        statement,
        params,
        status: created.status,
        target,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // HARD_MAX_ROWS_EXCEEDED is thrown deliberately above, after already
      // writing its own "hard_cap_refused" audit row — logging a second
      // "failed" row here for the same preview would be a duplicate, not a
      // distinct outcome.
      if (err instanceof WriteError && err.code === "HARD_MAX_ROWS_EXCEEDED") {
        throw err;
      }
      const translated = translateDbError(err);
      await this.auditLog.record(
        {
          tool: meta.tool,
          reason,
          statement,
          params,
          previewRows: null,
          actualRows: null,
          planToken: null,
          approvedBy: null,
          status: "failed",
          durationMs: Date.now() - startedAt,
          callerId: this.callerId,
        },
        client,
      );
      throw translated;
    } finally {
      client.release();
    }
  }

  async execute(
    planToken: string,
    statement: string,
    params: readonly unknown[],
  ): Promise<ExecuteResult> {
    const startedAt = Date.now();
    const consumed = this.store.consume(planToken, payloadFor(statement, params));
    // A token that never existed (or expired before this call) has no stored
    // meta to recover — fall back to generic attribution so the attempt is
    // still audited rather than dropped.
    const meta = consumed.meta
      ? {
          tool: consumed.meta.tool,
          reason: consumed.meta.reason,
          callerId: consumed.meta.callerId,
          previewRows: consumed.meta.previewCount ?? NaN,
        }
      : { tool: "execute_plan", reason: null, callerId: this.callerId, previewRows: NaN };
    const previewRows = Number.isNaN(meta.previewRows) ? null : meta.previewRows;

    if (!consumed.ok) {
      await this.auditLog.record({
        tool: meta.tool,
        reason: meta.reason,
        statement,
        params,
        previewRows,
        actualRows: null,
        planToken,
        approvedBy: null,
        status: "failed",
        durationMs: Date.now() - startedAt,
        callerId: meta.callerId,
      });
      throw mapPlanError(consumed.error);
    }

    const dataDigest = consumed.meta.dataDigest;
    const client = await this.opts.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.opts.statementTimeoutMs}`);
      await client.query("BEGIN");

      let affectedRows: number;
      if (isDdlStatement(statement)) {
        // No RETURNING clause exists for DDL, so — mirroring the same branch
        // in preview() — this runs the raw statement and skips the digest
        // comparison entirely rather than trying to force it through
        // executeSql's RETURNING wrapper (which DDL doesn't support). The
        // ROWSET_CHANGED check exists to catch "the matched row set changed
        // between preview and execute" for DELETE/UPDATE's WHERE-matched
        // rows; DDL has no such matched row set for the same reason INSERT
        // doesn't (see the comment below) — the payload fingerprint (exact
        // statement + params) plus the token's single-use/expiry/approval
        // guarantees are what apply here instead. See DECISIONS.md.
        await client.query(statement, params as unknown[]);
        affectedRows = 0;
      } else {
        const res = await client.query(this.executeSql(statement), params as unknown[]);
        const row = res.rows[0] as {
          affected_rows: number;
          rows_digest: string;
        };
        // The digest check only makes sense for statements that *match*
        // pre-existing rows (DELETE/UPDATE's WHERE) — it exists to catch "the
        // matched row set changed under me between preview and execute". An
        // INSERT has no pre-existing rows to match: its RETURNING content is
        // freshly generated every time (most visibly, any serial/identity
        // column's nextval()), so the preview's rolled-back INSERT and the
        // execute's real one deterministically produce *different* generated
        // values even though nothing "changed" in any sense this check cares
        // about. Comparing digests for INSERT would make ROWSET_CHANGED fire
        // on effectively every insert into a table with a server-generated
        // default, which is not the concurrent-modification signal this check
        // exists to catch — the payload fingerprint (exact statement +
        // params) already guarantees execute() replays the identical INSERT
        // the agent previewed, which is the only guarantee that applies here.
        if (!isInsertStatement(statement) && dataDigest !== null && row.rows_digest !== dataDigest) {
          throw new WriteError(
            "ROWSET_CHANGED",
            "The set of rows the statement would affect changed since the preview.",
            "Another write or transaction modified matching rows. Re-run delete_rows to obtain a fresh preview and token.",
          );
        }
        affectedRows = Number(row.affected_rows);
      }
      await client.query("COMMIT");

      // Recorded after COMMIT, on the same connection (now back to
      // autocommit), so a failure to write the audit row can never roll back
      // a write that already succeeded.
      await this.auditLog.record(
        {
          tool: meta.tool,
          reason: meta.reason,
          statement,
          params,
          previewRows,
          actualRows: affectedRows,
          planToken,
          approvedBy: null,
          status: "executed",
          durationMs: Date.now() - startedAt,
          callerId: meta.callerId,
        },
        client,
      );

      return { affectedRows };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const translated = translateDbError(err);
      await this.auditLog.record(
        {
          tool: meta.tool,
          reason: meta.reason,
          statement,
          params,
          previewRows,
          actualRows: null,
          planToken,
          approvedBy: null,
          status: "failed",
          durationMs: Date.now() - startedAt,
          callerId: meta.callerId,
        },
        client,
      );
      throw translated;
    } finally {
      client.release();
    }
  }

  /**
   * Marks a plan token approved so `execute_plan` will honour it despite
   * `AWAITING_APPROVAL`. This is the whole approval mechanism ticket #6
   * builds: an internal/programmatic entry point that is deliberately NOT
   * exposed as an MCP tool (see src/server.ts) — the requesting agent must
   * not be able to approve its own gated plan. Ticket #7's localhost human
   * approval page reaches the same store through the core's approval server
   * (see src/approvalServer.ts). There is deliberately no separate
   * "approvals store" table — the plan token itself, already the unit
   * `execute_plan` is scoped to, carries the approval flag.
   *
   * Idempotent: approving an already-approved (or never-gated) token
   * succeeds without error. Does not consume the token or touch the
   * database beyond writing the audit row — execute_plan still performs its
   * own statement/fingerprint/expiry/rowset checks afterward.
   */
  async approvePlan(planToken: string, approvedBy: string | null = null): Promise<void> {
    const startedAt = Date.now();
    const result = this.store.approve(planToken);
    await this.auditApprovalOutcome(planToken, approvedBy, result.ok, result.meta, startedAt);
    if (!result.ok) throw mapPlanError(result.error);
  }

  /**
   * Permanently kills a plan token: it can never be approved or executed
   * afterward, no matter what is later done to it. `execute` reports the
   * distinguishable `PLAN_REJECTED` error for it (not a generic failure) —
   * the core keeps the token as a tombstone rather than deleting it outright
   * so the refusal stays distinguishable from UNKNOWN_TOKEN even after
   * expiry. This is the symmetric counterpart to `approvePlan()`: ticket
   * #7's localhost approval page reaches the same store through the core's
   * approval server for its Reject button.
   *
   * `reason` is optional human-readable text (e.g. "too broad, narrow the
   * WHERE clause") that gets folded into the WriteError message the agent's
   * next `execute_plan` attempt receives, so the agent has something to act
   * on rather than an opaque refusal. `rejectedBy` is recorded on the audit
   * row's `approved_by` column — reused here as the generic "who actioned
   * this token" identity field rather than adding a migration for a
   * `rejected_by` column that would otherwise sit next to it doing the exact
   * same job (see DECISIONS.md).
   *
   * Idempotent: rejecting an already-rejected token succeeds again without
   * error and without changing anything.
   */
  async rejectPlan(
    planToken: string,
    reason: string | null = null,
    rejectedBy: string | null = null,
  ): Promise<void> {
    const startedAt = Date.now();
    const result = this.store.reject(planToken, reason);
    await this.auditRejectionOutcome(planToken, rejectedBy, result.ok, result.meta, startedAt);
    if (!result.ok) throw mapPlanError(result.error);
  }

  /**
   * Writes the audit row for one approve/reject decision made through the
   * core's approval HTTP server, whose `onDecision` hook carries the action,
   * actor, and outcome but not the plan's metadata. The metadata is
   * recovered from `PostgresPlanStore.lastDecision`, captured in the same
   * synchronous segment as the store transition itself (see that class's
   * doc comment). Produces exactly the rows `approvePlan`/`rejectPlan`
   * produce for the same outcomes, so the audit trail is identical
   * regardless of which surface a human decision came through.
   */
  async recordApprovalDecision(decision: ApprovalDecision): Promise<void> {
    const captured = this.store.lastDecision;
    const matched = captured !== null && captured.planToken === decision.planToken;
    const meta = matched ? captured.meta : null;
    const startedAt = matched ? captured.startedAt : Date.now();
    if (decision.action === "approve") {
      await this.auditApprovalOutcome(decision.planToken, decision.actor, decision.ok, meta, startedAt);
    } else {
      await this.auditRejectionOutcome(decision.planToken, decision.actor, decision.ok, meta, startedAt);
    }
  }

  private async auditApprovalOutcome(
    planToken: string,
    approvedBy: string | null,
    ok: boolean,
    meta: PlanMeta | null,
    startedAt: number,
  ): Promise<void> {
    const view = metaView(meta, "approve_plan", this.callerId);
    if (!ok) {
      await this.auditLog.record({
        tool: view.tool,
        reason: view.reason,
        statement: "",
        params: [],
        previewRows: view.previewRows,
        actualRows: null,
        planToken,
        approvedBy,
        status: "failed",
        durationMs: Date.now() - startedAt,
        callerId: view.callerId,
      });
      return;
    }
    await this.auditLog.record({
      tool: "approve_plan",
      reason: view.reason,
      statement: "",
      params: [],
      previewRows: view.previewRows,
      actualRows: null,
      planToken,
      approvedBy: approvedBy ?? "unknown",
      status: "approved",
      durationMs: Date.now() - startedAt,
      callerId: view.callerId,
    });
  }

  private async auditRejectionOutcome(
    planToken: string,
    rejectedBy: string | null,
    ok: boolean,
    meta: PlanMeta | null,
    startedAt: number,
  ): Promise<void> {
    const view = metaView(meta, "reject_plan", this.callerId);
    if (!ok) {
      await this.auditLog.record({
        tool: view.tool,
        reason: view.reason,
        statement: "",
        params: [],
        previewRows: view.previewRows,
        actualRows: null,
        planToken,
        approvedBy: rejectedBy,
        status: "failed",
        durationMs: Date.now() - startedAt,
        callerId: view.callerId,
      });
      return;
    }
    await this.auditLog.record({
      tool: "reject_plan",
      reason: view.reason,
      statement: "",
      params: [],
      previewRows: view.previewRows,
      actualRows: null,
      planToken,
      approvedBy: rejectedBy ?? "unknown",
      status: "rejected",
      durationMs: Date.now() - startedAt,
      callerId: view.callerId,
    });
  }

  private previewSql(statement: string): string {
    return `
WITH _affected AS (${statement} RETURNING *)
SELECT
  count(*)::int AS affected_rows,
  COALESCE(
    (SELECT json_agg(_sub) FROM (SELECT * FROM _affected AS _sub LIMIT 10) AS _sub),
    '[]'::json
  ) AS sample_rows,
  ${rowsDigestExpr()}
FROM _affected
`;
  }

  private executeSql(statement: string): string {
    return `
WITH _affected AS (${statement} RETURNING *)
SELECT
  count(*)::int AS affected_rows,
  ${rowsDigestExpr()}
FROM _affected
`;
  }
}

/** The plan-meta view audit rows need, with the same fallback attribution the pre-core code used. */
function metaView(
  meta: PlanMeta | null,
  fallbackTool: string,
  fallbackCallerId: string,
): { tool: string; reason: string | null; callerId: string; previewRows: number | null } {
  const previewCount = meta?.previewCount ?? NaN;
  return {
    tool: meta?.tool ?? fallbackTool,
    reason: meta?.reason ?? null,
    callerId: meta?.callerId ?? fallbackCallerId,
    previewRows: Number.isNaN(previewCount) ? null : previewCount,
  };
}

/**
 * A deterministic digest over the exact rows the statement would affect. The
 * token is bound to this digest so `execute` can refuse to commit a delete that
 * no longer matches the approved preview: the digest changes if a row enters or
 * leaves the predicate, or if an affected row's content changes, between
 * preview and execution.
 */
function rowsDigestExpr(): string {
  return `COALESCE(
    (SELECT md5(string_agg(row_to_json(_s)::text, E'\\n' ORDER BY row_to_json(_s)::text))
     FROM _affected AS _s),
    ''
  ) AS rows_digest`;
}

/**
 * Statements are always constructed by this project's own tool code (see
 * src/tools/*.ts) — never passed through from arbitrary agent-supplied SQL —
 * so a simple leading-keyword check is sufficient here; this never needs to
 * handle CTEs, comments, or other disguised forms of INSERT.
 */
function isInsertStatement(statement: string): boolean {
  return /^\s*insert\b/i.test(statement);
}

/**
 * True for the DDL forms `run_migration` (ticket #9) issues — CREATE, ALTER,
 * and DROP statements. Same reasoning as `isInsertStatement` above: this
 * project's own tool code is the only thing that ever builds the statement
 * text preview()/execute() see (see src/tools/runMigration.ts, which also
 * validates the leading keyword itself before ever calling preview()), so a
 * leading-keyword check is sufficient — this never needs to handle CTEs,
 * comments, or other disguised forms. Drives two things here: which SQL
 * preview()/execute() run (DDL has no RETURNING clause to wrap) and that the
 * ROWSET_CHANGED digest comparison is skipped (DDL has no pre-existing
 * matched row set for the same reason INSERT doesn't — see execute()'s
 * comment and DECISIONS.md).
 */
function isDdlStatement(statement: string): boolean {
  return /^\s*(create|alter|drop)\b/i.test(statement);
}

function translateDbError(err: unknown): unknown {
  if (err && typeof err === "object" && "code" in err) {
    const pgErr = err as { code: string; message: string };
    // 57014 = query_canceled, raised when statement_timeout fires.
    if (pgErr.code === "57014") {
      return new WriteError(
        "STATEMENT_TIMEOUT",
        "The statement exceeded the per-connection statement_timeout and was cancelled.",
        "Narrow the statement's scope or raise write.statementTimeoutMs.",
      );
    }
  }
  return err;
}

/**
 * Fingerprint of a statement plus its parameter values, via the core's
 * canonical-JSON fingerprint. Exported for tests and tooling; the plan
 * binding itself is enforced inside PlanStore.create()/consume() on the
 * identical payload shape.
 */
export function statementFingerprint(
  statement: string,
  params: readonly unknown[],
): string {
  return fingerprint(payloadFor(statement, params));
}
