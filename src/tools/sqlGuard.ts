import type pg from "pg";
import type { AppConfig } from "../config.js";
import { isTableReadable } from "../config.js";
import { ToolFailure } from "./errors.js";

interface ScanResult {
  /** SQL with comments and string literals replaced by single spaces. */
  clean: string;
  /**
   * Raw index just past the last real token. Real tokens are everything that is
   * not whitespace, not a comment, and not a `;` terminator — so string
   * literals count and trailing comments do not.
   */
  lastRealEnd: number;
}

function scanStatement(sql: string): ScanResult {
  let out = "";
  let lastRealEnd = 0;
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
      const eString = i >= 1 && /^[Ee]$/.test(sql[i - 1]);
      const uString = i >= 2 && sql[i - 1] === "&" && /^[Uu]$/.test(sql[i - 2]);
      const escapeCapable = eString || uString;
      i++;
      while (i < n) {
        if (escapeCapable && sql[i] === "\\") {
          i += 2;
          continue;
        }
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
      lastRealEnd = i;
      out += " ";
      continue;
    }

    if (ch === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end !== -1) {
          i = end + tag[0].length;
          lastRealEnd = i;
          out += " ";
          continue;
        }
      }
    }

    if (ch !== ";" && !/\s/.test(ch)) lastRealEnd = i + 1;
    out += ch;
    i++;
  }

  return { clean: out, lastRealEnd };
}

/**
 * Replace comments and string literals with spaces so keyword and identifier
 * scanning is not fooled by SQL-looking text inside a literal or comment.
 * Preserves token boundaries (each removed span becomes a single space).
 */
export function sanitizeSql(sql: string): string {
  return scanStatement(sql).clean;
}

/**
 * Drop trailing statement terminators and comments from the raw SQL, so a
 * single statement can be wrapped in a derived table. The cut point is the end
 * of the last real token (string literals count; comments and `;` do not), so a
 * `;` or `--` inside a string literal is never mistaken for a terminator.
 */
export function stripTrailingTerminators(sql: string): string {
  const { lastRealEnd } = scanStatement(sql);
  return sql.slice(0, lastRealEnd).trimEnd();
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

const CONTEXT_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO", "TABLE"]);
const CLAUSE_END_KEYWORDS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "FOR",
  "WINDOW",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "RETURNING",
]);

function skipWs(sql: string, i: number): number {
  while (i < sql.length && /\s/.test(sql[i])) i++;
  return i;
}

/** Read an identifier (quoted or unquoted). Returns null when `start` is not one. */
function readWord(
  sql: string,
  start: number,
): { value: string; end: number; raw: string } | null {
  const ch = sql[start];
  if (ch === '"') {
    let i = start + 1;
    let out = "";
    while (i < sql.length) {
      if (sql[i] === '"') {
        if (sql[i + 1] === '"') {
          out += '"';
          i += 2;
          continue;
        }
        return { value: out, end: i + 1, raw: sql.slice(start, i + 1) };
      }
      out += sql[i];
      i++;
    }
    return { value: out, end: sql.length, raw: sql.slice(start) };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(start));
  if (!m) return null;
  return { value: m[0], end: start + m[0].length, raw: m[0] };
}

/** Read a possibly schema-qualified relation starting at `start`. */
function readRelation(
  sql: string,
  start: number,
): { ref: string; end: number } | null {
  const first = readWord(sql, start);
  if (!first) return null;
  const parts = [first.raw];
  let pos = skipWs(sql, first.end);
  if (sql[pos] === ".") {
    const second = readWord(sql, skipWs(sql, pos + 1));
    if (second) {
      parts.push(second.raw);
      pos = skipWs(sql, second.end);
    }
  }
  return { ref: parts.join("."), end: pos };
}

/** Index just past the `)` that closes the group opened at `open`, or -1. */
function matchingParen(sql: string, open: number): number {
  let depth = 0;
  for (let j = open; j < sql.length; j++) {
    if (sql[j] === "(") depth++;
    else if (sql[j] === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Read the relation that follows `ONLY`, in either `ONLY t` or `ONLY (t)` form. */
function readOnlyRelation(
  sql: string,
  start: number,
): { ref: string; end: number } | null {
  let pos = skipWs(sql, start);
  if (sql[pos] === "(") {
    const inner = readRelation(sql, skipWs(sql, pos + 1));
    if (!inner) return null;
    let end = skipWs(sql, inner.end);
    if (sql[end] === ")") end++;
    return { ref: inner.ref, end };
  }
  return readRelation(sql, pos);
}

/**
 * Extract candidate table references from a sanitized statement. Walks the
 * token stream so every relation in a FROM/JOIN list is captured, including
 * comma-joins (`FROM t1, t2`), aliased items (`FROM a x, b`), the `ONLY` forms
 * (`ONLY t`, `ONLY (t)`), `LATERAL` modifiers, relations that follow a join
 * condition (`FROM a JOIN b ON ..., c`), parenthesized join groups
 * (`FROM (a JOIN b ON ...)`), and relations inside parenthesized subqueries
 * (derived tables, WHERE IN (...), CTEs). When `inFromClause` is set, the scan
 * starts expecting a from-item, so the first relation inside a parenthesized
 * group is not skipped. Function calls and CTE names come back too; the
 * allowlist check resolves each reference against the catalog and only enforces
 * on identifiers that are real relations.
 */
export function extractTableReferences(clean: string, inFromClause = false): string[] {
  const refs: string[] = [];
  let i = 0;
  let expectRelation = inFromClause;
  let inFrom = inFromClause;

  while (i < clean.length) {
    const ch = clean[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      const end = matchingParen(clean, i);
      if (end === -1) {
        i++;
        continue;
      }
      refs.push(
        ...extractTableReferences(
          clean.slice(i + 1, end),
          expectRelation || inFrom,
        ),
      );
      i = end + 1;
      expectRelation = false;
      continue;
    }
    if (ch === ",") {
      i++;
      if (inFrom && !expectRelation) expectRelation = true;
      continue;
    }

    const word = readWord(clean, i);
    if (!word) {
      i++;
      continue;
    }
    const upper = word.value.toUpperCase();

    // ONLY always precedes a relation, with or without a preceding FROM.
    if (upper === "ONLY") {
      const only = readOnlyRelation(clean, word.end);
      if (only) {
        refs.push(only.ref);
        i = only.end;
      } else {
        i = word.end;
      }
      expectRelation = false;
      continue;
    }

    if (expectRelation) {
      // expectRelation: the next token is a from-item (relation or a modifier).
      if (upper === "LATERAL") {
        i = word.end;
        expectRelation = true;
        continue;
      }
      const rel = readRelation(clean, i);
      if (rel) {
        refs.push(rel.ref);
        i = rel.end;
      } else {
        i = word.end;
      }
      expectRelation = false;
      continue;
    }

    if (CONTEXT_KEYWORDS.has(upper)) {
      expectRelation = true;
      inFrom = true;
    } else if (CLAUSE_END_KEYWORDS.has(upper)) {
      inFrom = false;
    }
    i = word.end;
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