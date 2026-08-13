import type { AppConfig } from "../config.js";
import { isTableWritable } from "../config.js";
import {
  TwoPhaseWrite,
  WriteError,
  type WritePreview,
} from "../writeCore.js";
import { parseQualifiedName, quoteIdentifier } from "./writeStatements.js";

export interface InsertRowsInput {
  table: string;
  /** Column names to insert into, e.g. ["email", "active"]. */
  columns: string[];
  /** One array of values per row, positional against `columns`. */
  rows: unknown[][];
  reason?: string;
}

/**
 * Preview an INSERT (two-phase, same machinery as `delete_rows`/`update_rows`):
 * runs the statement inside a transaction, captures the exact row count and a
 * sample via RETURNING, then rolls back. Nothing is written until
 * `execute_plan` replays the identical statement.
 *
 * Column names are quoted identifiers (`quoteIdentifier`), never
 * string-concatenated into the statement unescaped — a malicious column name
 * can only ever produce an invalid/nonexistent identifier, not break out of
 * identifier context. Values are always passed as `$n` parameters, never
 * inlined into the SQL text.
 *
 * Note: because the preview's INSERT is rolled back rather than committed,
 * any `serial`/`identity` sequence the table's columns pull a default from
 * still advances — Postgres sequences are not transactional, so a rolled-back
 * preview leaves a permanent gap in that column's values. See the README.
 */
export async function previewInsertRows(
  write: TwoPhaseWrite,
  config: AppConfig,
  input: InsertRowsInput,
): Promise<WritePreview> {
  const { schema, table } = parseQualifiedName(input.table);
  if (!isTableWritable(schema, table, config.allowlist)) {
    throw new WriteError(
      "TABLE_NOT_WRITABLE",
      `Table "${schema}.${table}" is not in the write allowlist.`,
      "Add it to allowlist.write in the config file to allow writes.",
    );
  }

  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    throw new WriteError(
      "INVALID_INPUT",
      "insert_rows requires a non-empty `columns` array.",
      'Pass the column names to insert into, e.g. ["email", "active"].',
    );
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw new WriteError(
      "INVALID_INPUT",
      "insert_rows requires a non-empty `rows` array.",
      'Pass at least one row of values matching `columns`, e.g. [["a@example.com", true]].',
    );
  }
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (!Array.isArray(row) || row.length !== input.columns.length) {
      throw new WriteError(
        "INVALID_INPUT",
        `Row ${i} does not have exactly one value per column (expected ${input.columns.length}).`,
        "Every entry in `rows` must be an array with exactly one value per entry in `columns`, in the same order.",
      );
    }
  }

  const columnList = input.columns.map(quoteIdentifier).join(", ");
  const params: unknown[] = [];
  const valueTuples = input.rows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  const statement = `INSERT INTO ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columnList}) VALUES ${valueTuples.join(", ")}`;

  return write.preview(statement, params, {
    tool: "insert_rows",
    reason: input.reason ?? null,
  });
}
