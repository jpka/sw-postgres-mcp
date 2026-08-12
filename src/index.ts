#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createPools, assertRolesDistinct } from "./db.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pools = createPools(config);

  // Verify distinct roles on startup (warn but don't crash if DB unavailable during build)
  try {
    await assertRolesDistinct(pools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sw-postgres-mcp] role check failed: ${msg}`);
    // Continue; the error will surface on tool calls
  }

  const onExit = async () => {
    await pools.readonlyPool.end().catch(() => {});
    await pools.writerPool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  await startServer(pools, config);
}

main().catch((err) => {
  console.error("[sw-postgres-mcp] fatal:", err);
  process.exit(1);
});
