import type pg from "pg";
import type { AppConfig } from "../config.js";
import { isTableReadable } from "../config.js";
import { ToolFailure } from "./errors.js";

/**
 * Replace comments and string literals with spaces so keyword and identifier
 * scanning below is not fooled by SQL-looking text inside a literal or comment.
 * Preserves token boundaries (each removed span becomes a single space).
 */
export function sanitizeSql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }

    if (ch === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end !== -1) {
          i = end + tag[0].length;
          out += " ";
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/** Throw MULTI_STATEMENT / EMPTY_STATEMENT unless `clean` is exactly one statement. */
export function assertSingleStatement(clean: string): void {
  const stripped = clean.trim().replace(/;+\s*$/, "");
  if (stripped.length === 0) {
    throw new ToolFailure(
      "EMPTY_STATEMENT",
      "No statement was provided.",
      "Pass a single SQL statement to run.",
    );
  }
  if (/;\s*\S/.test(stripped)) {
    throw new ToolFailure(
      "MULTI_STATEMENT",
      "Multiple statements are not allowed.",
      "Pass exactly one statement per call. Split the work into separate calls.",
    );
  }
}

const READ_KEYWORDS = ["SELECT", "WITH", "VALUES", "TABLE"];

/** Throw NOT_SELECT unless the statement starts with a read keyword. */
export function assertReadStatement(clean: string): void {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(clean);
  const keyword = m ? m[1].toUpperCase() : "";
  if (!READ_KEYWORDS.includes(keyword)) {
    throw new ToolFailure(
      "NOT_SELECT",
      "Only read-only SELECT statements are allowed.",
      "Use a SELECT statement (or WITH/VALUES/TABLE). Read-only is also enforced by the database role.",
    );
  }
}

const TABLE_REF_RE =
  /(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:ONLY\s+)?((?:"(?:\"|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:\"|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*))?)/gi;

/**
 * Extract candidate table references from a sanitized statement. Function calls
 * and CTE names come back too; the allowlist check resolves each reference
 * against the catalog and only enforces on identifiers that are real relations.
 */
export function extractTableReferences(clean: string): string[] {
  const refs: string[] = [];
  for (const match of clean.matchAll(TABLE_REF_RE)) {
    const raw = match[1].replace(/\s/g, "");
    const parts = raw.split(".").map((p) => p.replace(/^"|"$/g, ""));
    refs.push(parts.join("."));
  }
  return refs;
}

/**
 * Reject statements that reference any relation outside the read allowlist.
 * Each extracted reference is resolved with to_regclass so non-relations
 * (functions, CTE names) are ignored.
 */
export async function assertTablesAllowlisted(
  pool: pg.Pool,
  clean: string,
  config: AppConfig,
): Promise<void> {
  const refs = extractTableReferences(clean);
  const seen = new Set<string>();

  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);

    const res = await pool.query<{ schema: string | null; relname: string | null }>(
      `
      SELECT n.nspname AS schema, c.relname AS relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass($1)::oid
        AND c.relkind IN ('r', 'v', 'm', 'p')
      `,
      [ref],
    );

    if (res.rows.length === 0) continue;

    const { schema, relname } = res.rows[0];
    if (schema && relname && !isTableReadable(schema, relname, config.allowlist)) {
      throw new ToolFailure(
        "TABLE_NOT_ALLOWLISTED",
        `Table ${schema}.${relname} is not in the read allowlist.`,
        "Add it to allowlist.read in the server config, or query an allowlisted table.",
      );
    }
  }
}

/** Wrap a raw database failure as a structured error without leaking PG error text. */
export function dbError(code: string, err: unknown): ToolFailure {
  const lower = err instanceof Error ? err.message.toLowerCase() : "";
  if (/permission denied|insufficient_privilege|not allowed/.test(lower)) {
    return new ToolFailure(
      code,
      "The database refused the statement.",
      "The readonly role only permits reads. If a read is being denied, check the role's grants.",
    );
  }
  if (/syntax error|does not exist|relation .* does not exist/.test(lower)) {
    return new ToolFailure(
      code,
      "The database rejected the statement.",
      "Review the SQL for syntax or object-name errors, then retry.",
    );
  }
  return new ToolFailure(
    code,
    "The database failed to execute the statement.",
    "Review the statement and retry; if it keeps failing, check database health.",
  );
}