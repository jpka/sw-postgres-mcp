import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DatabaseConfig {
  readonlyConnectionString: string;
  writerConnectionString: string;
}

export interface AllowlistSection {
  /** Schemas whose tables are allowed. Empty or undefined means no schema-level allowlist. */
  schemas?: string[];
  /** Fully-qualified tables e.g. "public.users". Empty or undefined means governed only by schemas. */
  tables?: string[];
}

export interface AllowlistConfig {
  read: AllowlistSection;
  write: AllowlistSection;
}

export interface WriteConfig {
  /** How long a plan token stays valid, in milliseconds. Default 60_000. */
  planTtlMs: number;
  /** Per-connection statement_timeout for write executions, in milliseconds. Default 10_000. */
  statementTimeoutMs: number;
  /**
   * A preview whose exact rollback-preview affected-row count is at or below
   * this threshold returns a token `execute_plan` will honour immediately.
   * Above it, the preview returns `status: "awaiting_approval"` instead — the
   * token exists but `execute_plan` refuses it until `TwoPhaseWrite.approvePlan()`
   * marks it approved (deliberately not an agent-facing MCP tool). Default 100.
   */
  approvalRequiredAboveRows: number;
  /**
   * A preview whose exact rollback-preview affected-row count exceeds this
   * (separate, higher) threshold is refused outright: no token is issued and
   * there is no approval path, regardless of `approvalRequiredAboveRows`.
   * Default 10_000. Must be >= approvalRequiredAboveRows.
   */
  hardMaxRows: number;
}

export const DEFAULT_WRITE_CONFIG: WriteConfig = {
  planTtlMs: 60_000,
  statementTimeoutMs: 10_000,
  approvalRequiredAboveRows: 100,
  hardMaxRows: 10_000,
};

export interface AppConfig {
  database: DatabaseConfig;
  allowlist: AllowlistConfig;
  write: WriteConfig;
  /**
   * Identity recorded as `caller_id` on every mcp_audit.log row this server
   * instance writes. The server has no per-request authentication (see
   * DECISIONS.md / build plan risks — "no auth beyond local config" is a
   * deliberate v1 scope limit), so this identifies the deployment/agent
   * session as a whole rather than an individual end user. Default "unknown".
   */
  callerId?: string;
}

function parseAllowlistSection(raw: unknown): AllowlistSection {
  if (!raw || typeof raw !== "object") return { schemas: [], tables: [] };
  const r = raw as Record<string, unknown>;
  const schemas = Array.isArray(r.schemas)
    ? (r.schemas as unknown[]).filter((s) => typeof s === "string") as string[]
    : [];
  const tables = Array.isArray(r.tables)
    ? (r.tables as unknown[]).filter((s) => typeof s === "string") as string[]
    : [];
  return { schemas, tables };
}

export function isTableAllowed(
  schema: string,
  table: string,
  section: AllowlistSection,
): boolean {
  const fq = `${schema}.${table}`;
  // Explicit table allowlist takes precedence: if tables list is non-empty, only those tables are allowed
  if (section.tables && section.tables.length > 0) {
    return section.tables.includes(fq);
  }
  // Otherwise check schema allowlist: if schemas list is non-empty, only those schemas are allowed
  if (section.schemas && section.schemas.length > 0) {
    return section.schemas.includes(schema);
  }
  // Empty both: no allowlist configured. For read we treat as "allow all"; for write we treat as "deny all".
  // This distinction is handled by callers via defaults, but this helper returns false (deny).
  return false;
}

export function isTableReadable(
  schema: string,
  table: string,
  allowlist: AllowlistConfig,
): boolean {
  // If read allowlist is empty (both arrays empty/undefined), allow all tables.
  const read = allowlist.read;
  const hasReadConfig =
    (read.schemas && read.schemas.length > 0) ||
    (read.tables && read.tables.length > 0);
  if (!hasReadConfig) return true;
  return isTableAllowed(schema, table, read);
}

export function isTableWritable(
  schema: string,
  table: string,
  allowlist: AllowlistConfig,
): boolean {
  // Default deny on write: if no write allowlist configured, nothing is writable.
  const write = allowlist.write;
  const hasWriteConfig =
    (write.schemas && write.schemas.length > 0) ||
    (write.tables && write.tables.length > 0);
  if (!hasWriteConfig) return false;
  return isTableAllowed(schema, table, write);
}

export function loadConfig(configPath?: string): AppConfig {
  const envPath = process.env.SW_POSTGRES_CONFIG;
  const resolvedPath = configPath ?? envPath ?? resolve(process.cwd(), "config.json");

  let raw: unknown = {};
  if (existsSync(resolvedPath)) {
    const content = readFileSync(resolvedPath, "utf-8");
    raw = JSON.parse(content) as unknown;
  }

  const r = (raw ?? {}) as Record<string, unknown>;
  const dbRaw = (r.database ?? {}) as Record<string, unknown>;
  const allowRaw = (r.allowlist ?? {}) as Record<string, unknown>;
  const writeRaw = (r.write ?? {}) as Record<string, unknown>;

  const positiveIntOrThrow = (value: unknown, setting: string): number | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") {
      if (Number.isInteger(value) && value > 0) return value;
    } else if (typeof value === "string" && /^[0-9]+$/.test(value)) {
      const n = Number(value);
      if (Number.isSafeInteger(n) && n > 0) return n;
    }
    throw new Error(
      `write.${setting} must be a positive integer, got ${JSON.stringify(value)}`,
    );
  };

  const write: WriteConfig = {
    planTtlMs:
      positiveIntOrThrow(process.env.SW_PLAN_TTL_MS, "planTtlMs") ??
      positiveIntOrThrow(writeRaw.planTtlMs, "planTtlMs") ??
      DEFAULT_WRITE_CONFIG.planTtlMs,
    statementTimeoutMs:
      positiveIntOrThrow(process.env.SW_STATEMENT_TIMEOUT_MS, "statementTimeoutMs") ??
      positiveIntOrThrow(writeRaw.statementTimeoutMs, "statementTimeoutMs") ??
      DEFAULT_WRITE_CONFIG.statementTimeoutMs,
    approvalRequiredAboveRows:
      positiveIntOrThrow(
        process.env.SW_APPROVAL_REQUIRED_ABOVE_ROWS,
        "approvalRequiredAboveRows",
      ) ??
      positiveIntOrThrow(writeRaw.approvalRequiredAboveRows, "approvalRequiredAboveRows") ??
      DEFAULT_WRITE_CONFIG.approvalRequiredAboveRows,
    hardMaxRows:
      positiveIntOrThrow(process.env.SW_HARD_MAX_ROWS, "hardMaxRows") ??
      positiveIntOrThrow(writeRaw.hardMaxRows, "hardMaxRows") ??
      DEFAULT_WRITE_CONFIG.hardMaxRows,
  };

  if (write.hardMaxRows < write.approvalRequiredAboveRows) {
    throw new Error(
      `write.hardMaxRows (${write.hardMaxRows}) must be >= write.approvalRequiredAboveRows (${write.approvalRequiredAboveRows})`,
    );
  }

  // Allowlist supports both nested {read, write} and legacy flat keys for backwards compat
  let allowlist: AllowlistConfig;
  if (allowRaw.read || allowRaw.write) {
    allowlist = {
      read: parseAllowlistSection(allowRaw.read),
      write: parseAllowlistSection(allowRaw.write),
    };
  } else {
    // Legacy: { readableSchemas, readableTables, writableSchemas, writableTables } or { readSchemas, ... }
    const readSchemas =
      (allowRaw.readSchemas as string[]) ??
      (allowRaw.readableSchemas as string[]) ??
      [];
    const readTables =
      (allowRaw.readTables as string[]) ??
      (allowRaw.readableTables as string[]) ??
      [];
    const writeSchemas =
      (allowRaw.writeSchemas as string[]) ??
      (allowRaw.writableSchemas as string[]) ??
      [];
    const writeTables =
      (allowRaw.writeTables as string[]) ??
      (allowRaw.writableTables as string[]) ??
      [];
    allowlist = {
      read: {
        schemas: Array.isArray(readSchemas) ? readSchemas : [],
        tables: Array.isArray(readTables) ? readTables : [],
      },
      write: {
        schemas: Array.isArray(writeSchemas) ? writeSchemas : [],
        tables: Array.isArray(writeTables) ? writeTables : [],
      },
    };
  }

  const database: DatabaseConfig = {
    readonlyConnectionString:
      process.env.DATABASE_URL_READONLY ??
      process.env.POSTGRES_READONLY_URL ??
      (dbRaw.readonlyConnectionString as string) ??
      "",
    writerConnectionString:
      process.env.DATABASE_URL_WRITER ??
      process.env.POSTGRES_WRITER_URL ??
      process.env.DATABASE_URL ??
      (dbRaw.writerConnectionString as string) ??
      "",
  };

  if (!database.readonlyConnectionString) {
    throw new Error(
      `Missing readonly connection string. Set database.readonlyConnectionString in ${resolvedPath} or env DATABASE_URL_READONLY`,
    );
  }
  if (!database.writerConnectionString) {
    throw new Error(
      `Missing writer connection string. Set database.writerConnectionString in ${resolvedPath} or env DATABASE_URL_WRITER`,
    );
  }

  const callerId =
    process.env.SW_CALLER_ID ??
    (typeof r.callerId === "string" && r.callerId.trim().length > 0
      ? r.callerId
      : undefined) ??
    "unknown";

  return { database, allowlist, write, callerId };
}
