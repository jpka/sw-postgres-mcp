import type http from "node:http";
import {
  createApprovalServer as createCoreApprovalServer,
  startApprovalServer as startCoreApprovalServer,
  type ApprovalServerHandle,
  type PendingPlan as CorePendingPlan,
  type RenderablePlan,
} from "safe-write-mcp-core";
import type { SqlPayload, TwoPhaseWrite } from "./writeCore.js";
import type { ApprovalServerConfig } from "./config.js";

export type { ApprovalServerHandle };

const PAGE_TITLE = "sw-postgres-mcp — approval queue";

/**
 * The localhost approval HTTP server itself — loopback-only binding, the
 * CSRF/request-provenance gates, the JSON content-type gate, the body-size
 * cap, the plan-card page — is owned by `safe-write-mcp-core`'s
 * `createApprovalServer`/`startApprovalServer`. This file is the host
 * adapter: it shapes how a SQL plan card is displayed (`renderPlan`) and
 * wires every human decision back into `TwoPhaseWrite`'s audit trail
 * (`onDecision`). Approve/reject still deliberately bypass the MCP tool
 * surface — the core server calls `PlanStore.approve()`/`reject()` on the
 * same store instance `execute_plan` consumes from, in-process (see
 * DECISIONS.md and src/writeCore.ts).
 */

/**
 * The core has no idea what a SQL payload is, so the host tells it what a
 * human reviewer needs to see on a card: the exact statement and params the
 * preview ran, the DDL target when known (run_migration, ticket #9), and the
 * sample rows the preview captured.
 */
function renderPlan(plan: CorePendingPlan<SqlPayload>): RenderablePlan {
  const target = typeof plan.extra.target === "string" ? plan.extra.target : null;
  const sampleRows = Array.isArray(plan.extra.sampleRows) ? plan.extra.sampleRows : [];
  const details: Array<{ label: string; value: string }> = [
    { label: "Statement", value: plan.payload.statement },
    { label: "Params", value: JSON.stringify(plan.payload.params) },
  ];
  if (target !== null) {
    details.push({ label: "Target", value: target });
  }
  details.push({
    label: `Sample of affected rows (first ${sampleRows.length})`,
    value: JSON.stringify(sampleRows, null, 2),
  });
  return { title: plan.tool, details };
}

export function createApprovalServer(write: TwoPhaseWrite): http.Server {
  return createCoreApprovalServer<SqlPayload>(write.planStore, {
    title: PAGE_TITLE,
    renderPlan,
    onDecision: (decision) => write.recordApprovalDecision(decision),
  });
}

/**
 * Starts the localhost approval HTTP server bound to `127.0.0.1` only —
 * never `0.0.0.0`, enforced by the core — and separate from the MCP stdio
 * transport. Meant to be started alongside it (see src/index.ts), sharing
 * the same plan store so an approval here is visible to the `execute_plan`
 * MCP tool running in the same process (plan tokens are in-memory and
 * process-scoped — see DECISIONS.md).
 */
export async function startApprovalServer(
  write: TwoPhaseWrite,
  config: ApprovalServerConfig,
): Promise<ApprovalServerHandle> {
  return startCoreApprovalServer<SqlPayload>(write.planStore, {
    port: config.port,
    title: PAGE_TITLE,
    renderPlan,
    onDecision: (decision) => write.recordApprovalDecision(decision),
  });
}
