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
import { ToolFailure } from "./tools/errors.js";
import { TwoPhaseWrite, WriteError } from "./writeCore.js";

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

const executePlanSchema = z.object({
  plan_token: z.string(),
  statement: z.string(),
  params: z.array(z.unknown()).optional(),
});

function text(content: string) {
  return { content: [{ type: "text", text: content }] as const };
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

export function createServer(pools: Pools, config: AppConfig): Server {
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

  const write = new TwoPhaseWrite({
    pool: pools.writerPool,
    planTtlMs: config.write.planTtlMs,
    statementTimeoutMs: config.write.statementTimeoutMs,
    callerId: config.callerId,
  });

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
        name: "execute_plan",
        description:
          "Execute a previously previewed write. Pass the exact plan_token, statement, and params from the delete_rows preview. The token is single-use, expires, refuses any statement that does not match the preview, and refuses to commit if the affected row set changed since the preview.",
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
        return text(
          JSON.stringify(
            {
              status: "previewed",
              plan_token: preview.planToken,
              statement: preview.statement,
              params: preview.params,
              affected_rows: preview.affectedRows,
              sample_rows: preview.sampleRows,
            },
            null,
            2,
          ),
        );
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

export async function startServer(pools: Pools, config: AppConfig): Promise<void> {
  const server = createServer(pools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
