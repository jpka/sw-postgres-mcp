#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createPools, assertRolesDistinct } from "./db.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pools = createPools(config);

  // Verify distinct roles on startup. Any validation failure is fatal so a
  // same-role misconfiguration cannot be masked by a transient connectivity error
  // and later serve requests through a nominal readonly pool with writer privileges.
  try {
    await assertRolesDistinct(pools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sw-postgres-mcp] distinct-role check failed: ${msg}`);
    await pools.readonlyPool.end().catch(() => {});
    await pools.writerPool.end().catch(() => {});
    throw err;
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
