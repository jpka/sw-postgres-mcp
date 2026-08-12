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

export interface AppConfig {
  database: DatabaseConfig;
  allowlist: AllowlistConfig;
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

  return { database, allowlist };
}
