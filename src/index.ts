#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createPools, assertRolesDistinct } from "./db.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pools = createPools(config);

  // Verify distinct roles on startup. Same-role misconfiguration is fatal (would
  // give the readonly pool writer privileges); connectivity failures are non-fatal
  // so `npm run build` and offline checks still work.
  try {
    await assertRolesDistinct(pools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("must use distinct roles")) {
      console.error(`[sw-postgres-mcp] distinct-role check failed: ${msg}`);
      await pools.readonlyPool.end().catch(() => {});
      await pools.writerPool.end().catch(() => {});
      throw err;
    }
    console.error(`[sw-postgres-mcp] role check warning (connectivity?): ${msg}`);
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
