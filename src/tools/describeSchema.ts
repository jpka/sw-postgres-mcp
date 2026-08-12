import type pg from "pg";
import type { AppConfig } from "../config.js";
import { isTableReadable } from "../config.js";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface ForeignKeyInfo {
  constraintName: string;
  column: string;
  referencesSchema: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface TableInfo {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowCountEstimate: number;
}

export async function describeSchema(
  pool: pg.Pool,
  config: AppConfig,
): Promise<TableInfo[]> {
  // 1. Fetch all user tables (exclude system schemas) with row count estimate from pg_class.reltuples
  const tablesRes = await pool.query<{
    schema_name: string;
    table_name: string;
    row_estimate: string;
  }>(
    `
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      c.reltuples::bigint AS row_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
    ORDER BY n.nspname, c.relname
    `,
  );

  const filtered = tablesRes.rows.filter((r) =>
    isTableReadable(r.schema_name, r.table_name, config.allowlist),
  );

  if (filtered.length === 0) return [];

  // Build a set of allowed tables for downstream filtering
  const allowedSet = new Set(filtered.map((r) => `${r.schema_name}.${r.table_name}`));

  // 2. Fetch columns for allowed tables
  const columnsRes = await pool.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `
    SELECT
      table_schema,
      table_name,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
    `,
  );

  // 3. Fetch foreign keys via pg_catalog (information_schema is unreliable across roles).
  // Use ordinal pairing for composite keys to avoid N×N cross-product from ANY joins.
  const fkRes = await pool.query<{
    constraint_name: string;
    table_schema: string;
    table_name: string;
    column_name: string;
    foreign_table_schema: string;
    foreign_table_name: string;
    foreign_column_name: string;
  }>(
    `
    SELECT
      con.conname AS constraint_name,
      n.nspname AS table_schema,
      c.relname AS table_name,
      a.attname AS column_name,
      fn.nspname AS foreign_table_schema,
      fc.relname AS foreign_table_name,
      fa.attname AS foreign_column_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class fc ON fc.oid = con.confrelid
    JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    CROSS JOIN LATERAL generate_series(1, array_length(con.conkey, 1)) AS gs(ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[gs.ord]
    JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[gs.ord]
    WHERE con.contype = 'f'
    ORDER BY n.nspname, c.relname, con.conname, gs.ord
    `,
  );

  // Group columns and FKs by table
  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const col of columnsRes.rows) {
    const key = `${col.table_schema}.${col.table_name}`;
    if (!allowedSet.has(key)) continue;
    const list = columnsByTable.get(key) ?? [];
    list.push({
      name: col.column_name,
      type: col.data_type === "USER-DEFINED" ? col.udt_name : col.data_type,
      nullable: col.is_nullable === "YES",
      defaultValue: col.column_default,
    });
    columnsByTable.set(key, list);
  }

  const fksByTable = new Map<string, ForeignKeyInfo[]>();
  for (const fk of fkRes.rows) {
    const key = `${fk.table_schema}.${fk.table_name}`;
    if (!allowedSet.has(key)) continue;
    const list = fksByTable.get(key) ?? [];
    list.push({
      constraintName: fk.constraint_name,
      column: fk.column_name,
      referencesSchema: fk.foreign_table_schema,
      referencesTable: fk.foreign_table_name,
      referencesColumn: fk.foreign_column_name,
    });
    fksByTable.set(key, list);
  }

  return filtered.map((r) => {
    const key = `${r.schema_name}.${r.table_name}`;
    return {
      schema: r.schema_name,
      table: r.table_name,
      columns: columnsByTable.get(key) ?? [],
      foreignKeys: fksByTable.get(key) ?? [],
      rowCountEstimate: Number(r.row_estimate),
    };
  });
}
