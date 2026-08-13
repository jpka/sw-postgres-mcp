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
  | "INVALID_TABLE_NAME";

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
}

export interface ExecuteResult {
  affectedRows: number;
}

export interface TwoPhaseWriteOptions {
  pool: pg.Pool;
  planTtlMs: number;
  statementTimeoutMs: number;
  /** Identity recorded as `caller_id` on every audit row this instance writes. Default "unknown". */
  callerId?: string;
  /** Audit sink. Defaults to an `AuditLog` writing through `pool` (the writer role). */
  auditLog?: AuditLog;
}

/** Per-call context recorded onto the audit trail. `tool` names the MCP tool driving this preview. */
export interface WriteMeta {
  tool: string;
  reason?: string | null;
}

const DEFAULT_WRITE_META: WriteMeta = { tool: "unknown_tool" };

interface TokenMeta {
  tool: string;
  reason: string | null;
  callerId: string;
  previewRows: number;
}

interface TokenEntry extends TokenMeta {
  fingerprint: string;
  rowsDigest: string;
  expiresAt: number;
  used: boolean;
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

class TokenStore {
  private tokens = new Map<string, TokenEntry>();

  constructor(private ttlMs: number) {}

  create(fingerprint: string, rowsDigest: string, meta: TokenMeta): string {
    this.prune();
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, {
      fingerprint,
      rowsDigest,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
      ...meta,
    });
    return token;
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
    entry.used = true;
    return { ok: true, rowsDigest: entry.rowsDigest, meta: meta! };
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
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

  constructor(private opts: TwoPhaseWriteOptions) {
    this.store = new TokenStore(opts.planTtlMs);
    this.auditLog = opts.auditLog ?? new AuditLog(opts.pool);
    this.callerId = opts.callerId ?? "unknown";
  }

  async preview(
    statement: string,
    params: readonly unknown[],
    meta: WriteMeta = DEFAULT_WRITE_META,
  ): Promise<WritePreview> {
    const startedAt = Date.now();
    const reason = meta.reason ?? null;
    const client = await this.opts.pool.connect();
    try {
      await client.query(`SET statement_timeout = ${this.opts.statementTimeoutMs}`);
      await client.query("BEGIN");
      const res = await client.query(this.previewSql(statement), params as unknown[]);
      await client.query("ROLLBACK");

      const row = res.rows[0] as {
        affected_rows: number;
        sample_rows: unknown;
        rows_digest: string;
      };
      const affectedRows = Number(row.affected_rows);
      const sampleRows = Array.isArray(row.sample_rows)
        ? row.sample_rows
        : [];

      const planToken = this.store.create(
        statementFingerprint(statement, params),
        row.rows_digest,
        { tool: meta.tool, reason, callerId: this.callerId, previewRows: affectedRows },
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
          status: "previewed",
          durationMs: Date.now() - startedAt,
          callerId: this.callerId,
        },
        client,
      );

      return { planToken, affectedRows, sampleRows, statement, params };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
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
      consumed.meta ?? { tool: "execute_plan", reason: null, callerId: this.callerId, previewRows: NaN };
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
      const res = await client.query(this.executeSql(statement), params as unknown[]);
      const row = res.rows[0] as {
        affected_rows: number;
        rows_digest: string;
      };
      if (row.rows_digest !== consumed.rowsDigest) {
        throw new WriteError(
          "ROWSET_CHANGED",
          "The set of rows the statement would affect changed since the preview.",
          "Another write or transaction modified matching rows. Re-run delete_rows to obtain a fresh preview and token.",
        );
      }
      await client.query("COMMIT");
      const affectedRows = Number(row.affected_rows);

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
