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
import { previewDeleteRows } from "./tools/deleteRows.js";
import { TwoPhaseWrite, WriteError } from "./writeCore.js";

const deleteRowsSchema = z.object({
  table: z.string(),
  where: z.string().optional(),
  params: z.array(z.unknown()).optional(),
  confirm_full_table: z.boolean().optional(),
  reason: z.string().optional(),
});

const executePlanSchema = z.object({
  plan_token: z.string(),
  statement: z.string(),
  params: z.array(z.unknown()).optional(),
});

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
          "Execute a previously previewed write. Pass the exact plan_token, statement, and params from the delete_rows preview. The token is single-use, expires, and refuses any statement that does not match the preview.",
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

    if (name === "describe_schema") {
      const parsed = z
        .object({})
        .passthrough()
        .safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return invalidArgs(parsed.error.message);
      }

      try {
        const tables = await describeSchema(pools.readonlyPool, config);
        return textResult(JSON.stringify({ tables }, null, 2));
      } catch (err) {
        return failure(name, err);
      }
    }

    if (name === "delete_rows") {
      const parsed = deleteRowsSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return invalidArgs(parsed.error.message);
      }

      try {
        const preview = await previewDeleteRows(write, config, parsed.data);
        return textResult(
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
        return failure(name, err);
      }
    }

    if (name === "execute_plan") {
      const parsed = executePlanSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return invalidArgs(parsed.error.message);
      }

      try {
        const result = await write.execute(
          parsed.data.plan_token,
          parsed.data.statement,
          parsed.data.params ?? [],
        );
        return textResult(
          JSON.stringify(
            { status: "executed", affected_rows: result.affectedRows },
            null,
            2,
          ),
        );
      } catch (err) {
        return failure(name, err);
      }
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function invalidArgs(message: string) {
  return {
    content: [{ type: "text", text: `Invalid arguments: ${message}` }],
    isError: true,
  };
}

function failure(tool: string, err: unknown) {
  if (err instanceof WriteError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { code: err.code, message: err.message, hint: err.hint ?? null },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `${tool} failed: ${message}` }],
    isError: true,
  };
}

export async function startServer(pools: Pools, config: AppConfig): Promise<void> {
  const server = createServer(pools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
