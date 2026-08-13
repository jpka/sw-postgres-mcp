import type { AppConfig } from "../config.js";
import { isTableWritable } from "../config.js";
import { TwoPhaseWrite, WriteError, type WritePreview } from "../writeCore.js";
import { assertSingleStatement, sanitizeSql } from "./sqlGuard.js";
import { parseDdlStatement } from "./ddlTarget.js";

export interface RunMigrationInput {
  /** The full DDL statement text, e.g. "ALTER TABLE customers ADD COLUMN ...". */
  statement: string;
  reason?: string;
}

const SUPPORTED_FORMS_HINT =
  "Supported forms: CREATE TABLE, ALTER TABLE, DROP TABLE, and CREATE [UNIQUE] INDEX ... ON <table>. " +
  "DROP INDEX is not supported here because the target table cannot be determined from statement text " +
  "alone (see DECISIONS.md) — use ALTER TABLE ... DROP CONSTRAINT or drop and recreate the table's " +
  "indexes via CREATE/DROP TABLE instead, or ask for DROP INDEX support to be added.";

// PostgreSQL categorically refuses to run CREATE INDEX CONCURRENTLY inside a
// transaction block (SQLSTATE 25001), but preview()/execute() always wrap DDL
// in BEGIN...ROLLBACK / BEGIN...COMMIT (see writeCore.ts). Left unchecked,
// this reaches the database and fails with a raw Postgres error instead of a
// clean refusal — checked here, before write.preview() is ever called (and
// so before that BEGIN runs), the same place the other unsupported-input
// cases above are refused.
const CREATE_INDEX_CONCURRENTLY_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;

/**
 * Preview a DDL migration (two-phase, same core as `delete_rows`/`insert_rows`/
 * `update_rows`): runs the statement inside a transaction — Postgres DDL is
 * transactional, so this rolls back cleanly like any other preview — then
 * rolls back. Nothing is changed until `execute_plan` replays the identical
 * statement.
 *
 * Differs from the data write tools in one deliberate way: every call passes
 * `alwaysRequireApproval: true` to `TwoPhaseWrite.preview()`, hardcoded here
 * and never derived from `input` — there is no field in run_migration's MCP
 * tool schema (src/server.ts) that reaches it, so the calling agent has no
 * way to weaken or bypass it. `write.approvalRequiredAboveRows`/`hardMaxRows`
 * are never consulted for this tool: a migration affecting zero rows (e.g.
 * adding a column) can still be the most destructive thing this server does,
 * so row count is deliberately the wrong signal here. See DECISIONS.md.
 */
export async function previewRunMigration(
  write: TwoPhaseWrite,
  config: AppConfig,
  input: RunMigrationInput,
): Promise<WritePreview> {
  const statement = typeof input.statement === "string" ? input.statement.trim() : "";
  if (statement.length === 0) {
    throw new WriteError(
      "INVALID_INPUT",
      "run_migration requires a non-empty `statement`.",
      "Pass a single DDL statement, e.g. \"CREATE TABLE t (id serial primary key)\".",
    );
  }

  // Reject multi-statement input before it ever reaches the database — the
  // exact same comment/string-literal-safe guard `query`/`explain_plan` use
  // (src/tools/sqlGuard.ts) against a semicolon-separated pair of SELECTs,
  // reused here rather than a second implementation for DDL. A `;` or the
  // word CREATE/ALTER/DROP inside a quoted identifier or string literal
  // (e.g. a CHECK constraint's default text) does not false-positive here —
  // sanitizeSql blanks those out before the check runs.
  const clean = sanitizeSql(statement);
  assertSingleStatement(clean);

  if (!/^\s*(create|alter|drop)\b/i.test(clean)) {
    throw new WriteError(
      "INVALID_INPUT",
      "run_migration only accepts CREATE, ALTER, or DROP statements.",
      `Use delete_rows/insert_rows/update_rows for data changes. ${SUPPORTED_FORMS_HINT}`,
    );
  }

  if (CREATE_INDEX_CONCURRENTLY_RE.test(clean)) {
    throw new WriteError(
      "INVALID_INPUT",
      "CREATE INDEX CONCURRENTLY cannot run here: PostgreSQL refuses to run it inside a " +
        "transaction block, and run_migration's preview/execute always wrap DDL in one.",
      "Drop CONCURRENTLY and use plain CREATE [UNIQUE] INDEX instead, or run this migration " +
        "directly against the database outside run_migration.",
    );
  }

  const parsed = parseDdlStatement(statement);
  if (parsed.kind === "UNSUPPORTED" || parsed.targets.length === 0) {
    throw new WriteError(
      "INVALID_INPUT",
      "Could not determine the table/index this migration targets, so the write allowlist cannot be enforced against it.",
      SUPPORTED_FORMS_HINT,
    );
  }

  // Every target this statement touches (DROP TABLE can name more than one)
  // must be individually allowlisted — the same table-matching logic
  // (`isTableWritable`) delete_rows/insert_rows/update_rows already use, so
  // a migration can't reach a table those tools couldn't touch either.
  for (const t of parsed.targets) {
    if (!isTableWritable(t.schema, t.table, config.allowlist)) {
      throw new WriteError(
        "TABLE_NOT_WRITABLE",
        `Table "${t.schema}.${t.table}" is not in the write allowlist.`,
        "Add it to allowlist.write in the config file to allow migrations against it.",
      );
    }
  }

  const target = parsed.targets.map((t) => `${t.schema}.${t.table}`).join(", ");

  // run_migration never accepts params: DDL statement text cannot reference
  // `$1, $2, ...` bind parameters the way a DML WHERE/SET clause can (there
  // is nothing in `input` to build them from anyway — `statement` is the
  // agent's full literal DDL text), so this is always `[]`.
  return write.preview(statement, [], {
    tool: "run_migration",
    reason: input.reason ?? null,
    alwaysRequireApproval: true,
    target,
  });
}
