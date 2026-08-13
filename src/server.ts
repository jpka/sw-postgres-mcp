import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Pools } from "./db.js";
import type { AppConfig } from "./config.js";
import { describeSchema } from "./tools/describeSchema.js";
import { runQuery } from "./tools/query.js";
import { explainPlan } from "./tools/explainPlan.js";
import { previewDeleteRows } from "./tools/deleteRows.js";
import { previewInsertRows } from "./tools/insertRows.js";
import { previewUpdateRows } from "./tools/updateRows.js";
import { ToolFailure } from "./tools/errors.js";
import { TwoPhaseWrite, WriteError, type WritePreview } from "./writeCore.js";

const paramValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const queryArgsSchema = z
  .object({
    statement: z.string().min(1),
    params: z.array(paramValue).optional(),
    limit: z.number().int().positive().optional(),
    reason: z.string().min(1),
  })
  .strict();

const explainArgsSchema = z
  .object({
    statement: z.string().min(1),
    params: z.array(paramValue).optional(),
    reason: z.string().min(1),
  })
  .strict();

const deleteRowsSchema = z.object({
  table: z.string(),
  where: z.string().optional(),
  params: z.array(z.unknown()).optional(),
  confirm_full_table: z.boolean().optional(),
  // Required to match the tool's declared inputSchema below and so every
  // audit row for a write carries a real reason (see mcp_audit.log).
  reason: z.string().min(1),
});

const insertRowsSchema = z.object({
  table: z.string(),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.unknown())).min(1),
  // Required to match the tool's declared inputSchema below and so every
  // audit row for a write carries a real reason (see mcp_audit.log).
  reason: z.string().min(1),
});

const updateRowsSchema = z.object({
  table: z.string(),
  set: z.record(z.string(), z.unknown()),
  where: z.string().optional(),
  params: z.array(z.unknown()).optional(),
  confirm_full_table: z.boolean().optional(),
  // Required to match the tool's declared inputSchema below and so every
  // audit row for a write carries a real reason (see mcp_audit.log).
  reason: z.string().min(1),
});

const executePlanSchema = z.object({
  plan_token: z.string(),
  statement: z.string(),
  params: z.array(z.unknown()).optional(),
});

function text(content: string) {
  return { content: [{ type: "text", text: content }] as const };
}

/**
 * Shared response shape for every two-phase preview tool (`delete_rows`,
 * `insert_rows`, `update_rows`) — same fields, same `awaiting_approval`
 * message, so the three tools stay indistinguishable to the agent beyond
 * their input shape and the statement they produce.
 */
function previewResponse(
  preview: WritePreview,
  approvalRequiredAboveRows: number,
) {
  const message =
    preview.status === "awaiting_approval"
      ? `This plan affects ${preview.affectedRows} rows, above the approval threshold of ${approvalRequiredAboveRows}. It requires human approval through an out-of-band approval surface before execute_plan will succeed — wait for approval, or narrow the statement and re-preview.`
      : null;
  return text(
    JSON.stringify(
      {
        status: preview.status,
        plan_token: preview.planToken,
        statement: preview.statement,
        params: preview.params,
        affected_rows: preview.affectedRows,
        sample_rows: preview.sampleRows,
        message,
      },
      null,
      2,
    ),
  );
}

function errorBody(err: unknown) {
  if (err instanceof WriteError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: err.code,
            message: err.message,
            hint: err.hint ?? null,
          }),
        },
      ],
      isError: true,
    };
  }
  const shape =
    err instanceof ToolFailure
      ? err.toJSON()
      : {
          code: "INTERNAL_ERROR",
          message: "Unexpected server error.",
          hint: "Retry the call; if it persists, check the server logs.",
        };
  return { content: [{ type: "text", text: JSON.stringify(shape) }], isError: true };
}

function invalidArguments(error: z.ZodError) {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "INVALID_ARGUMENTS",
          message: `Invalid arguments: ${details}`,
          hint: "Check the tool's input schema and retry.",
        }),
      },
    ],
    isError: true,
  };
}

/**
 * `write` is optional and defaults to a fresh `TwoPhaseWrite` bound to
 * `pools.writerPool` — the normal path for `startServer`. Tests that need to
 * call `TwoPhaseWrite.approvePlan()` directly (it is deliberately NOT exposed
 * as an MCP tool — see the note on the tool list below) can construct their
 * own instance and pass it in here so it shares the in-memory plan-token
 * store with the server the MCP client talks to.
 */
export function createServer(
  pools: Pools,
  config: AppConfig,
  write: TwoPhaseWrite = new TwoPhaseWrite({
    pool: pools.writerPool,
    planTtlMs: config.write.planTtlMs,
    statementTimeoutMs: config.write.statementTimeoutMs,
    approvalRequiredAboveRows: config.write.approvalRequiredAboveRows,
    hardMaxRows: config.write.hardMaxRows,
    callerId: config.callerId,
  }),
): Server {
  const server = new Server(
    {
      name: "sw-postgres-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "describe_schema",
        description:
          "Describe the database schema: tables, columns with types, foreign keys, and row-count estimates. Respects the read allowlist in config.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "query",
        description:
          "Run a read-only SELECT against the database and return the rows. Runs on the readonly role, so mutating statements are refused by the database. Respects the read allowlist in config. Takes a `reason` string.",
        inputSchema: {
          type: "object",
          properties: {
            statement: { type: "string", description: "A single SELECT statement." },
            params: {
              type: "array",
              items: { type: ["string", "number", "boolean", "null"] },
              description: "Positional parameters for the statement ($1, $2, ...).",
            },
            limit: {
              type: "number",
              description: "Optional maximum number of rows to return.",
            },
            reason: { type: "string", description: "Why this statement is being run." },
          },
          required: ["statement", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "explain_plan",
        description:
          "Return the planner's estimated cost and row count for a candidate read statement, without executing it. A cheap pre-check to reject obviously expensive statements before running them. Takes a `reason` string.",
        inputSchema: {
          type: "object",
          properties: {
            statement: { type: "string", description: "A single read statement to estimate." },
            params: {
              type: "array",
              items: { type: ["string", "number", "boolean", "null"] },
              description: "Positional parameters for the statement ($1, $2, ...).",
            },
            reason: { type: "string", description: "Why this statement is being estimated." },
          },
          required: ["statement", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "delete_rows",
        description:
          "Preview a DELETE (two-phase). Runs the statement inside a transaction, returns the exact affected row count and a sample of affected rows, then rolls back. Nothing is changed until execute_plan is called with the returned plan_token. Requires a WHERE clause unless confirm_full_table is true.",
        inputSchema: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Table to delete from, e.g. \"customers\" or \"public.customers\".",
            },
            where: {
              type: "string",
              description: "SQL conditions for the WHERE clause (without the word WHERE).",
            },
            params: {
              type: "array",
              items: {},
              description: "Parameter values referenced by $1, $2, ... in where.",
            },
            confirm_full_table: {
              type: "boolean",
              description: "Allow DELETE with no WHERE clause (deletes the whole table).",
            },
            reason: {
              type: "string",
              description: "Why the agent is performing this write. Recorded for audit.",
            },
          },
          required: ["table", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "insert_rows",
        description:
          "Preview an INSERT (two-phase). Runs the statement inside a transaction, returns the exact row count and a sample of inserted rows via RETURNING, then rolls back. Nothing is changed until execute_plan is called with the returned plan_token. Note: a rolled-back preview still advances any serial/identity sequence the table's columns default from — Postgres sequences are not transactional, so previewing an insert leaves a permanent gap in that column's values even though no row was actually written.",
        inputSchema: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Table to insert into, e.g. \"customers\" or \"public.customers\".",
            },
            columns: {
              type: "array",
              items: { type: "string" },
              description: "Column names to insert into, e.g. [\"email\", \"active\"].",
            },
            rows: {
              type: "array",
              items: { type: "array", items: {} },
              description: "One array of values per row, positional against `columns` and in the same order, e.g. [[\"a@example.com\", true]].",
            },
            reason: {
              type: "string",
              description: "Why the agent is performing this write. Recorded for audit.",
            },
          },
          required: ["table", "columns", "rows", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "update_rows",
        description:
          "Preview an UPDATE (two-phase). Runs the statement inside a transaction, returns the exact affected row count and a sample of affected rows (post-update) via RETURNING, then rolls back. Nothing is changed until execute_plan is called with the returned plan_token. Requires a WHERE clause unless confirm_full_table is true (the same guard delete_rows uses).",
        inputSchema: {
          type: "object",
          properties: {
            table: {
              type: "string",
              description: "Table to update, e.g. \"customers\" or \"public.customers\".",
            },
            set: {
              type: "object",
              additionalProperties: {},
              description: "Column -> new value to SET, e.g. { \"active\": false }.",
            },
            where: {
              type: "string",
              description: "SQL conditions for the WHERE clause (without the word WHERE).",
            },
            params: {
              type: "array",
              items: {},
              description: "Parameter values referenced by $1, $2, ... in where.",
            },
            confirm_full_table: {
              type: "boolean",
              description: "Allow UPDATE with no WHERE clause (updates the whole table).",
            },
            reason: {
              type: "string",
              description: "Why the agent is performing this write. Recorded for audit.",
            },
          },
          required: ["table", "set", "reason"],
          additionalProperties: false,
        },
      },
      {
        name: "execute_plan",
        description:
          "Execute a previously previewed write. Pass the exact plan_token, statement, and params from the preview (delete_rows, insert_rows, or update_rows). The token is single-use, expires, refuses any statement that does not match the preview, refuses to commit if the affected row set changed since the preview, and — if the preview's affected-row count was above write.approvalRequiredAboveRows — refuses until a human approves it through an out-of-band approval surface (not available through this MCP tool set).",
        inputSchema: {
          type: "object",
          properties: {
            plan_token: {
              type: "string",
              description: "The token returned by the preview (delete_rows).",
            },
            statement: {
              type: "string",
              description: "The exact statement from the preview response.",
            },
            params: {
              type: "array",
              items: {},
              description: "The exact params from the preview response.",
            },
          },
          required: ["plan_token", "statement"],
          additionalProperties: false,
        },
      },
      // Deliberately no `approve_plan` tool here: approval must come from an
      // independently authenticated human principal, not from the same
      // agent session that requested the gated write (see DECISIONS.md).
      // `TwoPhaseWrite.approvePlan()` still exists in src/writeCore.ts as an
      // internal method for the future localhost human-approval surface
      // (#7) to call directly — it is intentionally not reachable through
      // this MCP tool surface.
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};

    if (name === "describe_schema") {
      const parsed = z.object({}).passthrough().safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const tables = await describeSchema(pools.readonlyPool, config);
        return text(JSON.stringify({ tables }, null, 2));
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "query") {
      const parsed = queryArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await runQuery(pools.readonlyPool, parsed.data, config);
        return text(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "explain_plan") {
      const parsed = explainArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await explainPlan(pools.readonlyPool, parsed.data, config);
        return text(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "delete_rows") {
      const parsed = deleteRowsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const preview = await previewDeleteRows(write, config, parsed.data);
        return previewResponse(preview, config.write.approvalRequiredAboveRows);
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "insert_rows") {
      const parsed = insertRowsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const preview = await previewInsertRows(write, config, parsed.data);
        return previewResponse(preview, config.write.approvalRequiredAboveRows);
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "update_rows") {
      const parsed = updateRowsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const preview = await previewUpdateRows(write, config, parsed.data);
        return previewResponse(preview, config.write.approvalRequiredAboveRows);
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "execute_plan") {
      const parsed = executePlanSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await write.execute(
          parsed.data.plan_token,
          parsed.data.statement,
          parsed.data.params ?? [],
        );
        return text(
          JSON.stringify(
            { status: "executed", affected_rows: result.affectedRows },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorBody(err);
      }
    }

    return errorBody(
      new ToolFailure(
        "UNKNOWN_TOOL",
        `Unknown tool: ${name}`,
        "List available tools and retry with a known tool name.",
      ),
    );
  });

  return server;
}

/**
 * `write` is optional here too, for the same reason as `createServer`'s own
 * default: `index.ts`'s `main()` constructs one `TwoPhaseWrite` explicitly
 * and shares it with the localhost approval server (src/approvalServer.ts)
 * so an approval/rejection there is visible to `execute_plan` in this same
 * process. Tests that only need the MCP surface can omit it and get the
 * same default `createServer` would build on its own.
 */
export async function startServer(
  pools: Pools,
  config: AppConfig,
  write?: TwoPhaseWrite,
): Promise<void> {
  const server = createServer(pools, config, write);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
