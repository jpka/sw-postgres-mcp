import type { AppConfig } from "../config.js";
import { isTableWritable } from "../config.js";
import {
  TwoPhaseWrite,
  WriteError,
  type WritePreview,
} from "../writeCore.js";
import {
  parseQualifiedName,
  quoteIdentifier,
  requireWhereOrConfirm,
} from "./writeStatements.js";

export interface DeleteRowsInput {
  table: string;
  where?: string;
  params?: unknown[];
  confirm_full_table?: boolean;
  reason?: string;
}

// Re-exported for backwards compatibility — these used to be defined here
// directly; they now live in ./writeStatements.js so insert_rows/update_rows
// (#8) can share them instead of duplicating.
export { parseQualifiedName, quoteIdentifier };

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

  const where = requireWhereOrConfirm({
    where: input.where,
    confirmFullTable: input.confirm_full_table,
    statementVerb: "DELETE",
    actionGerund: "deleting",
  });

  const statement = `DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${
    where ? ` WHERE ${where}` : ""
  }`;
  return write.preview(statement, input.params ?? [], {
    tool: "delete_rows",
    reason: input.reason ?? null,
  });
}
