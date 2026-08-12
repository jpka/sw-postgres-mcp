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
        return {
          content: [
            { type: "text", text: `Invalid arguments: ${parsed.error.message}` },
          ],
          isError: true,
        };
      }

      try {
        const tables = await describeSchema(pools.readonlyPool, config);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tables }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `describe_schema failed: ${message}` }],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

export async function startServer(pools: Pools, config: AppConfig): Promise<void> {
  const server = createServer(pools, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
