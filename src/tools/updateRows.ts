import type { AppConfig } from "../config.js";
import { isTableWritable } from "../config.js";
import {
  TwoPhaseWrite,
  WriteError,
  type WritePreview,
} from "../writeCore.js";
import {
  parseQualifiedName,
  quoteIdentifier,
  requireWhereOrConfirm,
} from "./writeStatements.js";

export interface UpdateRowsInput {
  table: string;
  /** Column -> new value. Column names are quoted identifiers; values are always parameterized. */
  set: Record<string, unknown>;
  where?: string;
  /** Parameter values referenced by $1, $2, ... in `where`. */
  params?: unknown[];
  confirm_full_table?: boolean;
  reason?: string;
}

/**
 * Preview an UPDATE (two-phase, same machinery as `delete_rows`/`insert_rows`):
 * runs the statement inside a transaction, captures the exact affected row
 * count and a sample via RETURNING, then rolls back. Nothing is written
 * until `execute_plan` replays the identical statement.
 *
 * Shares `requireWhereOrConfirm` with `delete_rows` (src/tools/writeStatements.ts)
 * rather than reimplementing the no-WHERE guard: an UPDATE with no WHERE
 * clause is refused unless `confirm_full_table: true` is passed, with the
 * exact same semantics (a syntactically present WHERE clause counts, however
 * permissive — no tautology detection).
 *
 * The `where` clause is the caller's raw SQL text referencing `$1, $2, ...`
 * against `params`, exactly like `delete_rows` — never string-concatenated
 * values. `set`'s column names are quoted identifiers (`quoteIdentifier`),
 * never concatenated into the statement unescaped, and its values are always
 * passed as `$n` parameters appended after the WHERE params, so neither a
 * crafted column name nor a crafted value can break out of its syntactic
 * position to inject SQL.
 */
export async function previewUpdateRows(
  write: TwoPhaseWrite,
  config: AppConfig,
  input: UpdateRowsInput,
): Promise<WritePreview> {
  const { schema, table } = parseQualifiedName(input.table);
  if (!isTableWritable(schema, table, config.allowlist)) {
    throw new WriteError(
      "TABLE_NOT_WRITABLE",
      `Table "${schema}.${table}" is not in the write allowlist.`,
      "Add it to allowlist.write in the config file to allow writes.",
    );
  }

  const setEntries = Object.entries(input.set ?? {});
  if (setEntries.length === 0) {
    throw new WriteError(
      "INVALID_INPUT",
      "update_rows requires a non-empty `set` object.",
      'Pass at least one column to update, e.g. { "active": false }.',
    );
  }

  const where = requireWhereOrConfirm({
    where: input.where,
    confirmFullTable: input.confirm_full_table,
    statementVerb: "UPDATE",
    actionGerund: "updating",
  });

  // WHERE params come first, unchanged from the caller's own $1.. numbering
  // (matching delete_rows) — the SET clause's placeholders are appended
  // after, so the caller's WHERE text never needs renumbering.
  const params: unknown[] = [...(input.params ?? [])];
  const setClauses = setEntries.map(([column, value]) => {
    params.push(value);
    return `${quoteIdentifier(column)} = $${params.length}`;
  });

  const statement = `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} SET ${setClauses.join(", ")}${
    where ? ` WHERE ${where}` : ""
  }`;

  return write.preview(statement, params, {
    tool: "update_rows",
    reason: input.reason ?? null,
  });
}
