/**
 * Extracts the table/index a DDL statement targets, for `run_migration`
 * (ticket #9): the write allowlist must be enforced against whatever the
 * migration actually creates/alters/drops, and a human approving it needs to
 * see the target too (there's no RETURNING-based row count to show instead —
 * see src/writeCore.ts's `isDdlStatement` handling and DECISIONS.md).
 *
 * Deliberately narrow: only the forms named in the ticket ("CREATE/ALTER/DROP
 * TABLE, indexes, etc.") are recognized. Anything else (including `DROP
 * INDEX`, whose owning table cannot be determined from statement text alone
 * without a catalog lookup — see DECISIONS.md) comes back as `UNSUPPORTED`
 * with no targets, and `run_migration` refuses it outright rather than
 * silently skipping the allowlist check.
 *
 * Reuses `sanitizeSql`/`readWord`/`skipWs` from ./sqlGuard.js — the same
 * comment/string-literal-safe tokenizer already trusted for the read
 * allowlist's table-reference extraction — rather than a second, independent
 * regex-based parser that could disagree with it on edge cases (quoted
 * identifiers, a `'...;...'` default value containing a semicolon or the
 * word TABLE, etc.).
 */
import { readWord, sanitizeSql, skipWs } from "./sqlGuard.js";

export type DdlKind =
  | "CREATE_TABLE"
  | "ALTER_TABLE"
  | "DROP_TABLE"
  | "CREATE_INDEX"
  | "UNSUPPORTED";

export interface DdlTarget {
  schema: string;
  table: string;
}

export interface ParsedDdl {
  kind: DdlKind;
  /** Empty when the target couldn't be extracted, including for UNSUPPORTED. */
  targets: DdlTarget[];
}

const CREATE_TABLE_RE =
  /^\s*CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i;
const ALTER_TABLE_RE = /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i;
const DROP_TABLE_RE = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i;
const CREATE_INDEX_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i;

/**
 * Reads one possibly schema-qualified relation name (`table` or
 * `schema.table`, each part quoted or unquoted) starting at `start`.
 * Deliberately simpler than sqlGuard's `readRelation`: that one also handles
 * the `ONLY (...)`/`LATERAL` forms meaningful in a SELECT's FROM clause,
 * which don't occur in DDL target position.
 */
function readQualifiedRelation(
  clean: string,
  start: number,
): { schema: string | null; table: string; end: number } | null {
  const first = readWord(clean, skipWs(clean, start));
  if (!first) return null;
  const afterFirst = skipWs(clean, first.end);
  if (clean[afterFirst] === ".") {
    const second = readWord(clean, skipWs(clean, afterFirst + 1));
    if (second) {
      const afterSecond = skipWs(clean, second.end);
      // PostgreSQL accepts a pro-forma three-part `database.schema.table`
      // name, valid only when `database` matches the currently-connected
      // database — this parser has no way to know that, so reading only the
      // first two parts here would report schema=database, table=schema and
      // silently drop the real table name, letting the allowlist check run
      // against an identity Postgres never touches while it operates on the
      // (unread) real target. Rather than guess, treat any three-part name
      // as unparseable so the caller refuses the statement outright.
      if (clean[afterSecond] === "." && readWord(clean, skipWs(clean, afterSecond + 1))) {
        return null;
      }
      return { schema: first.value, table: second.value, end: afterSecond };
    }
  }
  return { schema: null, table: first.value, end: afterFirst };
}

function toTarget(rel: { schema: string | null; table: string }): DdlTarget {
  return { schema: rel.schema ?? "public", table: rel.table };
}

/** `DROP TABLE a, b, c [CASCADE|RESTRICT]` — one or more comma-separated relations. */
function parseDropTableTargets(clean: string, start: number): DdlTarget[] {
  const targets: DdlTarget[] = [];
  let pos = start;
  for (;;) {
    const rel = readQualifiedRelation(clean, pos);
    if (!rel) break;
    targets.push(toTarget(rel));
    pos = skipWs(clean, rel.end);
    if (clean[pos] === ",") {
      pos++;
      continue;
    }
    break;
  }
  return targets;
}

/** True when `word` is the bare (unquoted) keyword, case-insensitively. */
function isUnquotedKeyword(word: { value: string; raw: string }, keyword: string): boolean {
  return word.raw[0] !== '"' && word.value.toUpperCase() === keyword;
}

/**
 * `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] table`
 * — the optional index name is consumed positionally (one token, quoted or
 * unquoted, or absent) rather than by searching the remaining text for the
 * `ON` keyword. A quoted index name can itself contain the substring `ON`
 * (e.g. `"i ON public.customers "`), which a text search would find before
 * the real `ON` and misreport as the target — this previously let a crafted
 * index name smuggle a false target past the allowlist check while the
 * statement executed against a different, unchecked table (CWE-863). By
 * reading one token at a time, a quoted name is consumed whole (via
 * `readWord`'s quote handling) and never inspected for keyword text, so only
 * the literal, unquoted `ON` token that follows it can ever match.
 */
function parseCreateIndexTarget(clean: string, afterPrefix: number): DdlTarget | null {
  let pos = skipWs(clean, afterPrefix);
  let word = readWord(clean, pos);
  if (!word) return null;

  if (!isUnquotedKeyword(word, "ON")) {
    // Not the ON keyword, so this token was the optional index name (quoted
    // or unquoted). The very next token must now literally be ON.
    pos = skipWs(clean, word.end);
    word = readWord(clean, pos);
    if (!word || !isUnquotedKeyword(word, "ON")) return null;
  }

  pos = skipWs(clean, word.end);
  const only = readWord(clean, pos);
  if (only && isUnquotedKeyword(only, "ONLY")) {
    pos = skipWs(clean, only.end);
  }

  const rel = readQualifiedRelation(clean, pos);
  return rel ? toTarget(rel) : null;
}

export function parseDdlStatement(rawStatement: string): ParsedDdl {
  const clean = sanitizeSql(rawStatement);

  let m = CREATE_TABLE_RE.exec(clean);
  if (m) {
    const rel = readQualifiedRelation(clean, m[0].length);
    return { kind: "CREATE_TABLE", targets: rel ? [toTarget(rel)] : [] };
  }

  m = ALTER_TABLE_RE.exec(clean);
  if (m) {
    const rel = readQualifiedRelation(clean, m[0].length);
    return { kind: "ALTER_TABLE", targets: rel ? [toTarget(rel)] : [] };
  }

  m = DROP_TABLE_RE.exec(clean);
  if (m) {
    return { kind: "DROP_TABLE", targets: parseDropTableTargets(clean, m[0].length) };
  }

  m = CREATE_INDEX_RE.exec(clean);
  if (m) {
    const target = parseCreateIndexTarget(clean, m[0].length);
    return { kind: "CREATE_INDEX", targets: target ? [target] : [] };
  }

  return { kind: "UNSUPPORTED", targets: [] };
}
