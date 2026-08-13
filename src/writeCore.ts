import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
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

/**
 * One awaiting_approval plan, shaped for a human approval surface (ticket
 * #7's localhost UI): everything it needs to render a card — the exact
 * statement, the agent's stated reason, the exact preview row count, and the
 * sample rows from the preview — without giving it a raw `TokenEntry`.
 * Returned by `TwoPhaseWrite.listPendingPlans()`.
 */
export interface PendingPlan {
  planToken: string;
  tool: string;
  reason: string | null;
  statement: string;
  params: readonly unknown[];
  previewRows: number;
  sampleRows: unknown[];
  expiresAt: number;
  callerId: string;
  /** See WritePreview.target. null for every tool except run_migration. */
  target: string | null;
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

interface TokenMeta {
  tool: string;
  reason: string | null;
  callerId: string;
  previewRows: number;
  target: string | null;
}

interface TokenEntry extends TokenMeta {
  fingerprint: string;
  rowsDigest: string;
  expiresAt: number;
  used: boolean;
  /** True when previewRows exceeded approvalRequiredAboveRows at preview time. */
  requiresApproval: boolean;
  /** Always true when !requiresApproval; flipped by TokenStore.approve() otherwise. */
  approved: boolean;
  /**
   * True once TokenStore.reject() has been called. A permanent tombstone:
   * once set, this entry is never deleted by prune()'s expiry sweep, never
   * approvable, and consume()/approve() report PLAN_REJECTED for it ahead of
   * every other check (used, expired, fingerprint), regardless of how much
   * later execute_plan or approvePlan is called against it.
   */
  rejected: boolean;
  /** Human-supplied rejection reason, surfaced back to the agent's next execute_plan attempt. */
  rejectionReason: string | null;
  /** The exact statement/params/sample rows from the preview — kept so listPending() can render a full card without re-running the preview. */
  statement: string;
  params: readonly unknown[];
  sampleRows: unknown[];
}

/**
 * Fingerprint of a statement plus its parameter values. The token is bound to
 * this hash, so `execute_plan` can refuse a changed statement or different
 * params without trusting the agent's claim that it is the same statement.
 */
export function statementFingerprint(
  statement: string,
  params: readonly unknown[],
): string {
  const canonical = statement.trim();
  const paramJson = JSON.stringify(params);
  return createHash("sha256")
    .update(canonical)
    .update("\u0000")
    .update(paramJson)
    .digest("hex");
}

type ConsumeResult =
  | { ok: true; rowsDigest: string; meta: TokenMeta }
  | { ok: false; error: WriteError; meta?: TokenMeta };

type ApproveResult =
  | { ok: true; alreadyApproved: boolean; meta: TokenMeta }
  | { ok: false; error: WriteError; meta?: TokenMeta };

type RejectResult =
  | { ok: true; alreadyRejected: boolean; meta: TokenMeta }
  | { ok: false; error: WriteError; meta?: TokenMeta };

/** The exact statement/params/sample rows a preview produced, kept on the token so a human approval surface can render them later without re-running the preview. */
interface PlanData {
  statement: string;
  params: readonly unknown[];
  sampleRows: unknown[];
}

class TokenStore {
  private tokens = new Map<string, TokenEntry>();

  constructor(private ttlMs: number) {}

  create(
    fingerprint: string,
    rowsDigest: string,
    meta: TokenMeta,
    requiresApproval: boolean,
    planData: PlanData,
  ): string {
    this.prune();
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, {
      fingerprint,
      rowsDigest,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
      requiresApproval,
      approved: !requiresApproval,
      rejected: false,
      rejectionReason: null,
      statement: planData.statement,
      params: planData.params,
      sampleRows: planData.sampleRows,
      ...meta,
    });
    return token;
  }

  /**
   * Plans still awaiting a human decision: requiresApproval, not yet
   * approved, not used, not rejected, and not expired. Expired entries are
   * deliberately omitted rather than flagged stale — ticket #7's acceptance
   * criteria calls for an expired plan to disappear from the pending list,
   * not sit there approvable.
   */
  listPending(): PendingPlan[] {
    const now = Date.now();
    const out: PendingPlan[] = [];
    for (const [token, entry] of this.tokens) {
      if (!entry.requiresApproval) continue;
      if (entry.approved || entry.used || entry.rejected) continue;
      if (now > entry.expiresAt) continue;
      out.push({
        planToken: token,
        tool: entry.tool,
        reason: entry.reason,
        statement: entry.statement,
        params: entry.params,
        previewRows: entry.previewRows,
        sampleRows: entry.sampleRows,
        expiresAt: entry.expiresAt,
        callerId: entry.callerId,
        target: entry.target,
      });
    }
    // Soonest-expiring first — the plans a human needs to act on most urgently lead the list.
    out.sort((a, b) => a.expiresAt - b.expiresAt);
    return out;
  }

  /**
   * Marks a plan token approved so a subsequent `consume()` (via
   * `TwoPhaseWrite.execute`) no longer refuses it with `AWAITING_APPROVAL`.
   * Does not consume the token — execute_plan still runs its own statement,
   * fingerprint, expiry, and rowset checks afterward.
   */
  approve(token: string): ApproveResult {
    const entry = this.tokens.get(token);
    const meta: TokenMeta | undefined = entry
      ? {
          tool: entry.tool,
          reason: entry.reason,
          callerId: entry.callerId,
          previewRows: entry.previewRows,
          target: entry.target,
        }
      : undefined;

    if (!entry) {
      return {
        ok: false,
        error: new WriteError(
          "UNKNOWN_TOKEN",
          "No plan matches this token. It may have been revoked or never issued.",
        ),
      };
    }
    if (entry.rejected) {
      return {
        ok: false,
        error: new WriteError(
          "PLAN_REJECTED",
          "This plan was rejected by a human reviewer and cannot be approved.",
          "A rejected plan cannot be un-rejected. Narrow the statement and re-preview to get a fresh token.",
        ),
        meta,
      };
    }
    if (entry.used) {
      return {
        ok: false,
        error: new WriteError(
          "USED_TOKEN",
          "This plan token was already used and can no longer be approved.",
        ),
        meta,
      };
    }
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return {
        ok: false,
        error: new WriteError(
          "EXPIRED_TOKEN",
          "This plan token has expired. Re-run the write to obtain a fresh preview and token.",
        ),
        meta,
      };
    }
    const alreadyApproved = entry.approved;
    entry.approved = true;
    return { ok: true, alreadyApproved, meta: meta! };
  }

  /**
   * Permanently kills a plan token: it can never be approved or executed
   * afterward, no matter what is later done to it. Unlike approve()/consume()
   * this does not delete the entry from the map — it stays as a tombstone
   * (see the `rejected` field's doc comment) so a later execute_plan or
   * approvePlan call reports the distinguishable PLAN_REJECTED error instead
   * of falling through to a generic UNKNOWN_TOKEN once enough time has
   * passed. Idempotent: rejecting an already-rejected token succeeds again
   * without changing anything (alreadyRejected: true), so "reject twice" is
   * harmless rather than an error a human approval UI has to guard against.
   */
  reject(token: string, reason: string | null): RejectResult {
    const entry = this.tokens.get(token);
    const meta: TokenMeta | undefined = entry
      ? {
          tool: entry.tool,
          reason: entry.reason,
          callerId: entry.callerId,
          previewRows: entry.previewRows,
          target: entry.target,
        }
      : undefined;

    if (!entry) {
      return {
        ok: false,
        error: new WriteError(
          "UNKNOWN_TOKEN",
          "No plan matches this token. It may have been revoked or never issued.",
        ),
      };
    }
    if (entry.used) {
      return {
        ok: false,
        error: new WriteError(
          "USED_TOKEN",
          "This plan token was already executed and can no longer be rejected.",
        ),
        meta,
      };
    }
    // Skip the expiry check once already rejected: an already-dead token
    // must stay reported as PLAN_REJECTED forever, not flip to EXPIRED_TOKEN
    // (and get pruned) just because enough wall-clock time passed between
    // two reject() calls.
    if (!entry.rejected && Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return {
        ok: false,
        error: new WriteError(
          "EXPIRED_TOKEN",
          "This plan token has already expired. There is nothing left to reject.",
        ),
        meta,
      };
    }
    const alreadyRejected = entry.rejected;
    entry.rejected = true;
    // First reason wins: a second reject() call (or one that omits a reason)
    // does not overwrite the reason a human already gave.
    if (!entry.rejectionReason && reason) entry.rejectionReason = reason;
    return { ok: true, alreadyRejected, meta: meta! };
  }

  consume(token: string, fingerprint: string): ConsumeResult {
    const entry = this.tokens.get(token);
    // Captured before any mutation below, so a failure path can still audit
    // *what* was being executed (tool, reason, caller) even though the token
    // itself is about to be deleted or was never valid to begin with.
    const meta: TokenMeta | undefined = entry
      ? {
          tool: entry.tool,
          reason: entry.reason,
          callerId: entry.callerId,
          previewRows: entry.previewRows,
          target: entry.target,
        }
      : undefined;

    if (!entry) {
      return {
        ok: false,
        error: new WriteError(
          "UNKNOWN_TOKEN",
          "No plan matches this token. It may have been revoked or never issued.",
        ),
      };
    }
    // Checked ahead of used/expired/fingerprint: rejection is a permanent
    // kill, so it must win regardless of what else is true about the token
    // (including a statement/params that no longer even matches — there is
    // no scenario in which a rejected token should report anything else).
    if (entry.rejected) {
      return {
        ok: false,
        error: new WriteError(
          "PLAN_REJECTED",
          entry.rejectionReason
            ? `This plan was rejected by a human reviewer: ${entry.rejectionReason}`
            : "This plan was rejected by a human reviewer.",
          "This plan cannot be executed. Narrow the statement (or ask a different question) and call delete_rows again for a fresh preview and token.",
        ),
        meta,
      };
    }
    if (entry.used) {
      this.tokens.delete(token);
      return {
        ok: false,
        error: new WriteError(
          "USED_TOKEN",
          "This plan token was already used. A plan token can only be executed once.",
        ),
        meta,
      };
    }
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return {
        ok: false,
        error: new WriteError(
          "EXPIRED_TOKEN",
          "This plan token has expired. Re-run the write to obtain a fresh preview and token.",
        ),
        meta,
      };
    }
    if (entry.fingerprint !== fingerprint) {
      return {
        ok: false,
        error: new WriteError(
          "STATEMENT_MISMATCH",
          "The statement or parameters do not match the plan the token was issued for.",
          "Pass the exact statement and params from the preview response.",
        ),
        meta,
      };
    }
    if (entry.requiresApproval && !entry.approved) {
      // Deliberately does not delete or mark the token used: it stays
      // pending so a later TwoPhaseWrite.approvePlan() + execute_plan can
      // still succeed.
      return {
        ok: false,
        error: new WriteError(
          "AWAITING_APPROVAL",
          "This plan affected more rows than the approval threshold allows and has not been approved yet.",
          "This requires approval through an out-of-band human approval process — it cannot be approved by this agent. Wait for approval, or narrow the statement and re-preview to stay under the threshold.",
        ),
        meta,
      };
    }
    entry.used = true;
    return { ok: true, rowsDigest: entry.rowsDigest, meta: meta! };
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      // Rejected entries are deliberately exempt from the expiry sweep —
      // they are kept as tombstones (see reject()'s doc comment) so a late
      // execute_plan/approvePlan call still reports PLAN_REJECTED instead of
      // falling back to UNKNOWN_TOKEN once enough time has passed.
      if (entry.rejected) continue;
      if (entry.used || now > entry.expiresAt) {
        this.tokens.delete(token);
      }
    }
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
 * The preview and the execute never share an open transaction: each call
 * checks out its own connection from the pool, so no transaction is left open
 * while the agent is deciding whether to execute.
 */
export class TwoPhaseWrite {
  private store: TokenStore;
  private auditLog: AuditLog;
  private callerId: string;
  private approvalRequiredAboveRows: number;
  private hardMaxRows: number;

  constructor(private opts: TwoPhaseWriteOptions) {
    this.store = new TokenStore(opts.planTtlMs);
    this.auditLog = opts.auditLog ?? new AuditLog(opts.pool);
    this.callerId = opts.callerId ?? "unknown";
    this.approvalRequiredAboveRows =
      opts.approvalRequiredAboveRows ?? DEFAULT_APPROVAL_REQUIRED_ABOVE_ROWS;
    this.hardMaxRows = opts.hardMaxRows ?? DEFAULT_HARD_MAX_ROWS;
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

      // `alwaysRequireApproval` (run_migration, ticket #9) forces this true
      // unconditionally — the approvalRequiredAboveRows/hardMaxRows
      // thresholds above are never consulted for it, on purpose: a DDL
      // statement affecting zero rows can still be the most destructive
      // thing this server does, so row count is deliberately not the gate.
      const requiresApproval =
        meta.alwaysRequireApproval === true || affectedRows > this.approvalRequiredAboveRows;
      const status: WritePreview["status"] = requiresApproval
        ? "awaiting_approval"
        : "previewed";

      const planToken = this.store.create(
        statementFingerprint(statement, params),
        rowsDigest,
        { tool: meta.tool, reason, callerId: this.callerId, previewRows: affectedRows, target },
        requiresApproval,
        { statement, params, sampleRows },
      );

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
          planToken,
          approvedBy: null,
          status,
          durationMs: Date.now() - startedAt,
          callerId: this.callerId,
        },
        client,
      );

      return { planToken, affectedRows, sampleRows, statement, params, status, target };
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
    const fingerprint = statementFingerprint(statement, params);
    const consumed = this.store.consume(planToken, fingerprint);
    // A token that never existed (or expired before this call) has no stored
    // meta to recover — fall back to generic attribution so the attempt is
    // still audited rather than dropped.
    const meta: TokenMeta =
      consumed.meta ??
      { tool: "execute_plan", reason: null, callerId: this.callerId, previewRows: NaN, target: null };
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
      throw consumed.error;
    }

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
        // doesn't (see the comment below) — statementFingerprint (exact
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
        // exists to catch — statementFingerprint (exact statement + params)
        // already guarantees execute() replays the identical INSERT the agent
        // previewed, which is the only guarantee that applies here.
        if (!isInsertStatement(statement) && row.rows_digest !== consumed.rowsDigest) {
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
   * approval page is expected to call this method directly. There is
   * deliberately no separate "approvals store" table — the plan token
   * itself, already the unit `execute_plan` is scoped to, carries the
   * approval flag; see TokenEntry.approved in this file.
   *
   * Idempotent: approving an already-approved (or never-gated) token
   * succeeds without error. Does not consume the token or touch the
   * database beyond writing the audit row — execute_plan still performs its
   * own statement/fingerprint/expiry/rowset checks afterward.
   */
  async approvePlan(planToken: string, approvedBy: string | null = null): Promise<void> {
    const startedAt = Date.now();
    const result = this.store.approve(planToken);
    const meta: TokenMeta =
      result.meta ??
      { tool: "approve_plan", reason: null, callerId: this.callerId, previewRows: NaN, target: null };
    const previewRows = Number.isNaN(meta.previewRows) ? null : meta.previewRows;

    if (!result.ok) {
      await this.auditLog.record({
        tool: meta.tool,
        reason: meta.reason,
        statement: "",
        params: [],
        previewRows,
        actualRows: null,
        planToken,
        approvedBy,
        status: "failed",
        durationMs: Date.now() - startedAt,
        callerId: meta.callerId,
      });
      throw result.error;
    }

    await this.auditLog.record({
      tool: "approve_plan",
      reason: meta.reason,
      statement: "",
      params: [],
      previewRows,
      actualRows: null,
      planToken,
      approvedBy: approvedBy ?? "unknown",
      status: "approved",
      durationMs: Date.now() - startedAt,
      callerId: meta.callerId,
    });
  }

  /**
   * Permanently kills a plan token: it can never be approved or executed
   * afterward, and `execute` reports the distinguishable `PLAN_REJECTED`
   * error for it (not a generic failure) — see TokenStore.reject()'s doc
   * comment for why the token stays around as a tombstone rather than being
   * deleted outright. This is the symmetric counterpart to `approvePlan()`:
   * ticket #7's localhost approval page calls this directly for its Reject
   * button, the same (deliberately non-MCP-tool) way it calls `approvePlan`
   * for Approve.
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
    const meta: TokenMeta =
      result.meta ??
      { tool: "reject_plan", reason: null, callerId: this.callerId, previewRows: NaN, target: null };
    const previewRows = Number.isNaN(meta.previewRows) ? null : meta.previewRows;

    if (!result.ok) {
      await this.auditLog.record({
        tool: meta.tool,
        reason: meta.reason,
        statement: "",
        params: [],
        previewRows,
        actualRows: null,
        planToken,
        approvedBy: rejectedBy,
        status: "failed",
        durationMs: Date.now() - startedAt,
        callerId: meta.callerId,
      });
      throw result.error;
    }

    await this.auditLog.record({
      tool: "reject_plan",
      reason: meta.reason,
      statement: "",
      params: [],
      previewRows,
      actualRows: null,
      planToken,
      approvedBy: rejectedBy ?? "unknown",
      status: "rejected",
      durationMs: Date.now() - startedAt,
      callerId: meta.callerId,
    });
  }

  /**
   * Plans currently awaiting a human decision — requiresApproval, not yet
   * approved, not used, not rejected, not expired — with the exact
   * statement, reason, preview row count, and sample rows a human approval
   * surface (ticket #7) needs to render a card per plan. Deliberately not an
   * MCP tool: this is read access to the same out-of-band surface
   * `approvePlan`/`rejectPlan` already are, not something the requesting
   * agent needs (or should get) a live view of.
   */
  listPendingPlans(): PendingPlan[] {
    return this.store.listPending();
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
