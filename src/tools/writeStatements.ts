import { WriteError } from "../writeCore.js";

/**
 * Shared statement-construction helpers for the write tools
 * (`delete_rows`, `insert_rows`, `update_rows`). Kept here rather than
 * duplicated per tool so a fix or a hardening change (e.g. the no-WHERE
 * guard, identifier quoting) only has to happen once and applies to every
 * write tool identically.
 */

export function parseQualifiedName(
  name: string,
): { schema: string; table: string } {
  const parts = name.split(".").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 2) {
    throw new WriteError(
      "INVALID_TABLE_NAME",
      `Invalid table name "${name}". Expected "table" or "schema.table".`,
    );
  }
  if (parts.length === 1) return { schema: "public", table: parts[0] };
  return { schema: parts[0], table: parts[1] };
}

export function quoteIdentifier(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

/**
 * The no-WHERE guard `delete_rows` has always had, generalized so
 * `update_rows` (#8) shares the exact same logic rather than reimplementing
 * it: a statement with an empty/whitespace-only WHERE clause is refused
 * unless `confirmFullTable` is explicitly `true`. Deliberately does not
 * inspect the WHERE text for tautologies (e.g. `1=1`) — a syntactically
 * present WHERE clause, no matter how permissive, counts as "has a WHERE
 * clause"; that has always been this guard's behavior for `delete_rows` and
 * generalizing it here must not quietly narrow or loosen it.
 *
 * Returns the trimmed WHERE text (possibly empty, when confirmed) so the
 * caller can build its statement from the same trimmed value this function
 * validated.
 */
export function requireWhereOrConfirm(opts: {
  where?: string;
  confirmFullTable?: boolean;
  /** Uppercase SQL verb for the error message, e.g. "DELETE" or "UPDATE". */
  statementVerb: string;
  /** Gerund for the hint, e.g. "deleting" or "updating". */
  actionGerund: string;
}): string {
  const trimmed = (opts.where ?? "").trim();
  if (trimmed.length === 0 && opts.confirmFullTable !== true) {
    throw new WriteError(
      "NO_WHERE_CLAUSE",
      `${opts.statementVerb} requires a WHERE clause.`,
      `Add a WHERE clause, or pass confirm_full_table: true to allow ${opts.actionGerund} the whole table.`,
    );
  }
  return trimmed;
}
