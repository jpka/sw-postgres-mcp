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
import { ToolFailure } from "./tools/errors.js";

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

function text(content: string) {
  return { content: [{ type: "text", text: content }] as const };
}

function errorBody(err: unknown) {
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