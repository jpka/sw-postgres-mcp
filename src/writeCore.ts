import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

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
}

interface TokenEntry {
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

class TokenStore {
  private tokens = new Map<string, TokenEntry>();

  constructor(private ttlMs: number) {}

  create(fingerprint: string, rowsDigest: string): string {
    this.prune();
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, {
      fingerprint,
      rowsDigest,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
    });
    return token;
  }

  consume(
    token: string,
    fingerprint: string,
  ): { ok: true; rowsDigest: string } | { ok: false; error: WriteError } {
    const entry = this.tokens.get(token);
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
      };
    }
    entry.used = true;
    return { ok: true, rowsDigest: entry.rowsDigest };
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

  constructor(private opts: TwoPhaseWriteOptions) {
    this.store = new TokenStore(opts.planTtlMs);
  }

  async preview(
    statement: string,
    params: readonly unknown[],
  ): Promise<WritePreview> {
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
      );
      return { planToken, affectedRows, sampleRows, statement, params };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw translateDbError(err);
    } finally {
      client.release();
    }
  }

  async execute(
    planToken: string,
    statement: string,
    params: readonly unknown[],
  ): Promise<ExecuteResult> {
    const fingerprint = statementFingerprint(statement, params);
    const consumed = this.store.consume(planToken, fingerprint);
    if (!consumed.ok) throw consumed.error;

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
        await client.query("ROLLBACK").catch(() => {});
        throw new WriteError(
          "ROWSET_CHANGED",
          "The set of rows the statement would affect changed since the preview.",
          "Another write or transaction modified matching rows. Re-run delete_rows to obtain a fresh preview and token.",
        );
      }
      await client.query("COMMIT");
      return { affectedRows: Number(row.affected_rows) };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw translateDbError(err);
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
