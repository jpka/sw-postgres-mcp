import type pg from "pg";
import type { AppConfig } from "../config.js";
import { ToolFailure, validateReason } from "./errors.js";
import {
  sanitizeSql,
  assertSingleStatement,
  assertReadStatement,
  assertTablesAllowlisted,
  dbError,
} from "./sqlGuard.js";

export interface QueryArgs {
  statement: string;
  params?: (string | number | boolean | null)[];
  limit?: number;
  reason: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
}

export async function runQuery(
  pool: pg.Pool,
  args: QueryArgs,
  config: AppConfig,
): Promise<QueryResult> {
  validateReason(args.reason);

  const clean = sanitizeSql(args.statement);
  assertSingleStatement(clean);
  assertReadStatement(clean);
  await assertTablesAllowlisted(pool, clean, config);

  // A trailing semicolon (optionally followed by a comment) would break the
  // derived-table wrapper, so drop it before wrapping.
  const base = args.statement.replace(/;\s*(--[^\n]*|\/\*[\s\S]*?\*\/)?$/, "").trimEnd();

  // Apply the requested limit by wrapping, so it composes with statements that
  // already carry their own LIMIT and never conflicts with one.
  const finalSql =
    typeof args.limit === "number"
      ? `SELECT * FROM (${base}) AS _q LIMIT ${args.limit}`
      : args.statement;

  try {
    const res = await pool.query(finalSql, args.params ?? []);
    return {
      columns: res.fields.map((f) => f.name),
      rows: res.rows as Record<string, unknown>[],
      row_count: res.rowCount ?? res.rows.length,
    };
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    throw dbError("QUERY_FAILED", err);
  }
}