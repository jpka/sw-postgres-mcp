import type pg from "pg";
import type { AppConfig } from "../config.js";
import { validateReason } from "./errors.js";
import {
  sanitizeSql,
  assertSingleStatement,
  assertReadStatement,
  assertTablesAllowlisted,
  dbError,
} from "./sqlGuard.js";

export interface ExplainArgs {
  statement: string;
  params?: (string | number | boolean | null)[];
  reason: string;
}

export interface ExplainResult {
  cost: number;
  rows: number;
  plan: unknown;
}

export async function explainPlan(
  pool: pg.Pool,
  args: ExplainArgs,
  config: AppConfig,
): Promise<ExplainResult> {
  validateReason(args.reason);

  const clean = sanitizeSql(args.statement);
  assertSingleStatement(clean);
  assertReadStatement(clean);
  await assertTablesAllowlisted(pool, clean, config);

  try {
    const res = await pool.query(
      `EXPLAIN (FORMAT JSON, COSTS ON) ${args.statement}`,
      args.params ?? [],
    );
    const plan = res.rows[0]["QUERY PLAN"] as Array<{
      Plan?: { "Total Cost"?: number; "Plan Rows"?: number };
    }>;
    const root = plan?.[0]?.Plan;
    return {
      cost: typeof root?.["Total Cost"] === "number" ? root["Total Cost"] : 0,
      rows: typeof root?.["Plan Rows"] === "number" ? root["Plan Rows"] : 0,
      plan,
    };
  } catch (err) {
    throw dbError("EXPLAIN_FAILED", err);
  }
}