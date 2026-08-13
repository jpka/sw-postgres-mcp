import type { AppConfig } from "../config.js";
import { isTableWritable } from "../config.js";
import {
  TwoPhaseWrite,
  WriteError,
  type WritePreview,
} from "../writeCore.js";

export interface DeleteRowsInput {
  table: string;
  where?: string;
  params?: unknown[];
  confirm_full_table?: boolean;
  reason?: string;
}

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

export async function previewDeleteRows(
  write: TwoPhaseWrite,
  config: AppConfig,
  input: DeleteRowsInput,
): Promise<WritePreview> {
  const { schema, table } = parseQualifiedName(input.table);
  if (!isTableWritable(schema, table, config.allowlist)) {
    throw new WriteError(
      "TABLE_NOT_WRITABLE",
      `Table "${schema}.${table}" is not in the write allowlist.`,
      "Add it to allowlist.write in the config file to allow writes.",
    );
  }

  const where = (input.where ?? "").trim();
  if (where.length === 0 && input.confirm_full_table !== true) {
    throw new WriteError(
      "NO_WHERE_CLAUSE",
      "DELETE requires a WHERE clause.",
      "Add a WHERE clause, or pass confirm_full_table: true to allow deleting the whole table.",
    );
  }

  const statement = `DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${
    where ? ` WHERE ${where}` : ""
  }`;
  return write.preview(statement, input.params ?? []);
}
