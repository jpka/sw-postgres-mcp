#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createPools, assertRolesDistinct } from "./db.js";
import { startServer } from "./server.js";
import { TwoPhaseWrite } from "./writeCore.js";
import { startApprovalServer, type ApprovalServerHandle } from "./approvalServer.js";

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

  // Constructed once and shared between the MCP stdio server and the
  // localhost approval HTTP server below, so an approve/reject there is
  // visible to execute_plan here — both run against the same in-memory plan
  // token store (see DECISIONS.md: approval is scoped to the process that
  // issued the preview).
  const write = new TwoPhaseWrite({
    pool: pools.writerPool,
    planTtlMs: config.write.planTtlMs,
    statementTimeoutMs: config.write.statementTimeoutMs,
    approvalRequiredAboveRows: config.write.approvalRequiredAboveRows,
    hardMaxRows: config.write.hardMaxRows,
    callerId: config.callerId,
    approvalAvailable: config.approvalServer?.enabled ?? true,
  });

  let approvalServer: ApprovalServerHandle | undefined;
  if (config.approvalServer.enabled) {
    // Mirrors the distinct-role check above: a failure here (e.g. the
    // configured port is already in use) is fatal, and must not leak the two
    // pools already opened above before rethrowing.
    try {
      approvalServer = await startApprovalServer(write, config.approvalServer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sw-postgres-mcp] approval server failed to start: ${msg}`);
      await pools.readonlyPool.end().catch(() => {});
      await pools.writerPool.end().catch(() => {});
      throw err;
    }
    console.error(
      `[sw-postgres-mcp] localhost approval UI listening on http://${approvalServer.host}:${approvalServer.port}`,
    );
  }

  const onExit = async () => {
    await approvalServer?.close().catch(() => {});
    await pools.readonlyPool.end().catch(() => {});
    await pools.writerPool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  await startServer(pools, config, write);
}

main().catch((err) => {
  console.error("[sw-postgres-mcp] fatal:", err);
  process.exit(1);
});
