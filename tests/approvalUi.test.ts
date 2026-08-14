import { randomUUID } from "node:crypto";
import http from "node:http";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { createPools } from "../src/db.js";
import { DEFAULT_WRITE_CONFIG, type AppConfig } from "../src/config.js";
import { TwoPhaseWrite } from "../src/writeCore.js";
import { startApprovalServer, type ApprovalServerHandle } from "../src/approvalServer.js";
import {
  READONLY_URL,
  WRITER_URL,
  SUPERUSER_URL,
  waitForDb,
  withSuperuser,
} from "./helpers.js";

const TABLE = "_appr_ui_rows";
// Small threshold so a handful of rows trips awaiting_approval, matching the
// pattern tests/approvalThreshold.test.ts uses for the same reason.
const APPROVAL_REQUIRED_ABOVE_ROWS = 3;
const HARD_MAX_ROWS = 500;

async function resetTable(rowCount = 20): Promise<void> {
  await withSuperuser(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await c.query(`CREATE TABLE ${TABLE} (id serial primary key, val int not null)`);
    await c.query(
      `INSERT INTO ${TABLE} (val) SELECT g FROM generate_series(1, $1) AS g`,
      [rowCount],
    );
  });
}

async function countRows(): Promise<number> {
  return withSuperuser(async (c) => {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return r.rows[0].n;
  });
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): { isError: boolean; body: Record<string, unknown> } {
  const text = result.content[0].text;
  return { isError: result.isError ?? false, body: JSON.parse(text) };
}

/** Rows written for one test's unique `reason`, oldest first. */
async function auditRowsForReason(reason: string): Promise<Record<string, unknown>[]> {
  return withSuperuser(async (c) => {
    const r = await c.query(
      `SELECT * FROM mcp_audit.log WHERE reason = $1 ORDER BY id ASC`,
      [reason],
    );
    return r.rows;
  });
}

/**
 * Waits for an HTTP-driven approve/reject decision's audit row to land. The
 * core approval server sends its HTTP response before awaiting the `onDecision`
 * audit hook, so the audit write for the *last* decision can still be in
 * flight when this test's next assertion runs. Polls (bounded) until
 * `expectedCount` rows exist, then returns them; rows are keyed by monotonic
 * `id`, so the sequence is final once the count is reached.
 */
async function waitForAuditRows(
  reason: string,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = await auditRowsForReason(reason);
  while (rows.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rows = await auditRowsForReason(reason);
  }
  return rows;
}

/**
 * Sends a raw HTTP request with full control over headers — including ones
 * the Fetch spec forbids scripts from setting (`Host` in particular), which
 * is exactly what's needed to exercise the CSRF-hardening request-provenance
 * checks below. Node's `fetch()` silently overwrites a `Host` header with
 * the URL's own authority, so it can't be used for that case.
 */
function rawRequest(
  url: string,
  options: http.RequestOptions & { body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString("utf-8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("localhost approval UI (#7)", () => {
  let client: Client;
  let serverPools: ReturnType<typeof createPools>;
  let write: TwoPhaseWrite;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetTable();

    const config: AppConfig = {
      database: {
        readonlyConnectionString: READONLY_URL,
        writerConnectionString: WRITER_URL,
      },
      allowlist: {
        read: { schemas: ["public"] },
        write: { tables: [`public.${TABLE}`] },
      },
      write: {
        ...DEFAULT_WRITE_CONFIG,
        approvalRequiredAboveRows: APPROVAL_REQUIRED_ABOVE_ROWS,
        hardMaxRows: HARD_MAX_ROWS,
      },
      approvalServer: { enabled: true, port: 0 },
    };

    serverPools = createPools(config);
    write = new TwoPhaseWrite({
      pool: serverPools.writerPool,
      planTtlMs: config.write.planTtlMs,
      statementTimeoutMs: config.write.statementTimeoutMs,
      approvalRequiredAboveRows: config.write.approvalRequiredAboveRows,
      hardMaxRows: config.write.hardMaxRows,
      callerId: config.callerId,
    });
    const server = createServer(serverPools, config, write);

    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Port 0 asks the OS for a free ephemeral port so this suite can run
    // concurrently with others (and with a real deployment on the default
    // 4319) without colliding.
    approval = await startApprovalServer(write, config.approvalServer);
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await client?.close();
    await approval?.close().catch(() => {});
    await serverPools?.readonlyPool.end().catch(() => {});
    await serverPools?.writerPool.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    });
  });

  beforeEach(async () => {
    await resetTable();
  });

  it("AC4: the approval server binds to 127.0.0.1 only, never 0.0.0.0", () => {
    expect(approval.host).toBe("127.0.0.1");
    const address = approval.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    const info = address as import("node:net").AddressInfo;
    expect(info.address).toBe("127.0.0.1");
    expect(info.family).toMatch(/^(IPv4|4)$/);
  });

  it("AC1: a pending plan appears on GET /api/plans with statement, reason, exact count, and sample rows", async () => {
    const reason = `ui-list-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 5", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    const resp = await fetch(`${baseUrl}/api/plans`);
    expect(resp.status).toBe(200);
    const { plans } = (await resp.json()) as { plans: Array<Record<string, unknown>> };
    const mine = plans.find((p) => p.plan_token === body.plan_token);
    expect(mine).toBeDefined();
    // The core's generalized plan JSON nests the host payload and carries the
    // host-rendered card fields under `render` (see safe-write-mcp-core's
    // approval server): statement/params under `payload`, the exact count as
    // `preview_count`, and the sample rows as a renderPlan detail.
    const payload = mine!.payload as { statement: string; params: unknown[] };
    expect(payload.statement).toBe(body.statement);
    expect(mine!.reason).toBe(reason);
    expect(mine!.preview_count).toBe(5);
    const render = mine!.render as { title: string; details: Array<{ label: string; value: string }> };
    const sample = render.details.find((d) => d.label.startsWith("Sample of affected rows"));
    expect(sample).toBeDefined();
    expect(JSON.parse(sample!.value)).toHaveLength(5);
    expect(JSON.parse(sample!.value)).toEqual(body.sample_rows);

    // The same page (server-rendered HTML) also reflects it, without needing
    // any client-side JS to see the statement and reason.
    const pageResp = await fetch(`${baseUrl}/`);
    expect(pageResp.status).toBe(200);
    const html = await pageResp.text();
    expect(html).toContain(reason);
    expect(html).toContain("5 affected");
  });

  it("AC2 + AC5: approving via the HTTP endpoint unlocks execute_plan and writes an approved audit row", async () => {
    const reason = `ui-approve-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 4", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    // execute_plan BLOCKS while the plan awaits approval, so the approve
    // below (which lands while this call is in flight) is what unblocks it.
    const execPromise = client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    // Give the server time to consume, see AWAITING_APPROVAL, and enter its
    // wait loop before the human decision lands.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const approveResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvedBy: "reviewer@example.com" }),
      },
    );
    expect(approveResp.status).toBe(200);
    const approveJson = (await approveResp.json()) as { ok: boolean };
    expect(approveJson.ok).toBe(true);

    // Approved plan drops off the pending list.
    const listAfter = (await (await fetch(`${baseUrl}/api/plans`)).json()) as {
      plans: Array<Record<string, unknown>>;
    };
    expect(listAfter.plans.find((p) => p.plan_token === body.plan_token)).toBeUndefined();

    const exec = await execPromise;
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(false);
    expect(execParsed.body.status).toBe("executed");
    expect(execParsed.body.affected_rows).toBe(4);
    expect(await countRows()).toBe(16);

    // The approve's audit row and the execute's final audit row are written
    // concurrently (the HTTP response returns before the onDecision audit
    // hook fires), so compare statuses as an unordered set.
    const rows = await waitForAuditRows(reason, 3);
    const statuses = rows.map((r) => r.status);
    expect(statuses.sort()).toEqual(["approved", "awaiting_approval", "executed"].sort());
    expect(rows.find((r) => r.status === "approved")!.approved_by).toBe("reviewer@example.com");
    expect(rows.find((r) => r.status === "approved")!.plan_token).toBe(body.plan_token);
  });

  it("AC3 + AC5: rejecting via the HTTP endpoint permanently kills the token and writes a rejected audit row", async () => {
    const reason = `ui-reject-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 4", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    const rejectResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejectedBy: "reviewer@example.com", reason: "too broad, narrow the WHERE clause" }),
      },
    );
    expect(rejectResp.status).toBe(200);
    expect(((await rejectResp.json()) as { ok: boolean }).ok).toBe(true);

    // execute_plan against the rejected token fails with a structured,
    // distinguishable error/status — not a generic failure, not
    // AWAITING_APPROVAL, not EXPIRED_TOKEN.
    const exec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(true);
    expect(execParsed.body.code).toBe("PLAN_REJECTED");
    expect(execParsed.body.code).not.toBe("AWAITING_APPROVAL");
    expect(execParsed.body.code).not.toBe("EXPIRED_TOKEN");
    expect(execParsed.body.message as string).toMatch(/too broad, narrow the WHERE clause/);
    expect(await countRows()).toBe(20);

    // Approving after rejecting does not un-kill it.
    const approveAfterReject = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(approveAfterReject.status).toBe(409);
    const approveAfterRejectJson = (await approveAfterReject.json()) as { ok: boolean; code: string };
    expect(approveAfterRejectJson.ok).toBe(false);
    expect(approveAfterRejectJson.code).toBe("PLAN_REJECTED");

    const stillExec = await client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    expect(parseToolResult(stillExec as never).body.code).toBe("PLAN_REJECTED");

    // Rejecting twice is harmless, not an error, and does not change the outcome.
    const secondReject = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/reject`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(secondReject.status).toBe(200);
    expect(((await secondReject.json()) as { ok: boolean }).ok).toBe(true);

    const rows = await waitForAuditRows(reason, 6);
    expect(rows.map((r) => r.status)).toEqual([
      "awaiting_approval",
      "rejected",
      "failed", // execute_plan against the rejected token
      "failed", // approve-after-reject attempt
      "failed", // execute_plan against the rejected token, again
      "rejected", // reject twice — idempotent, still audited
    ]);
    expect(rows[1].approved_by).toBe("reviewer@example.com");
    expect(rows[1].plan_token).toBe(body.plan_token);
    expect(await countRows()).toBe(20);
  });

  it("AC3b: rejecting via the HTTP endpoint while execute_plan is awaiting surfaces PLAN_REJECTED on that in-flight call", async () => {
    const reason = `ui-reject-inflight-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 4", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("awaiting_approval");

    // execute_plan BLOCKS while the plan awaits approval, so the reject below
    // (which lands while this call is in flight) is what unblocks it — and
    // the PLAN_REJECTED error surfaces on this very call, not on a later retry.
    const execPromise = client.callTool({
      name: "execute_plan",
      arguments: { plan_token: body.plan_token, statement: body.statement, params: body.params },
    });
    // Give the server time to consume, see AWAITING_APPROVAL, and enter its
    // wait loop before the human decision lands.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rejectResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(body.plan_token as string)}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rejectedBy: "reviewer@example.com",
          reason: "too broad, narrow the WHERE clause",
        }),
      },
    );
    expect(rejectResp.status).toBe(200);
    expect(((await rejectResp.json()) as { ok: boolean }).ok).toBe(true);

    const exec = await execPromise;
    const execParsed = parseToolResult(exec as never);
    expect(execParsed.isError).toBe(true);
    expect(execParsed.body.code).toBe("PLAN_REJECTED");
    expect(execParsed.body.code).not.toBe("AWAITING_APPROVAL");
    expect(execParsed.body.message as string).toMatch(/too broad, narrow the WHERE clause/);
    expect(await countRows()).toBe(20);

    // The rejection's audit row and the execute's failed audit row are
    // written concurrently, so compare statuses as an unordered set.
    const rows = await waitForAuditRows(reason, 3);
    const statuses = rows.map((r) => r.status);
    expect(statuses.sort()).toEqual(["awaiting_approval", "rejected", "failed"].sort());
    expect(rows.find((r) => r.status === "rejected")!.approved_by).toBe("reviewer@example.com");
  });

  it("rejecting a plan the agent never previewed (unknown token) is a structured 404, not a crash", async () => {
    const resp = await fetch(`${baseUrl}/api/plans/not-a-real-token/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("UNKNOWN_TOKEN");
  });

  it("a plan at or below the approval threshold never appears on the pending list (nothing to approve)", async () => {
    const reason = `ui-not-pending-${randomUUID()}`;
    const preview = await client.callTool({
      name: "delete_rows",
      arguments: { table: TABLE, where: "id <= 2", reason },
    });
    const { body } = parseToolResult(preview as never);
    expect(body.status).toBe("previewed");

    const { plans } = (await (await fetch(`${baseUrl}/api/plans`)).json()) as {
      plans: Array<Record<string, unknown>>;
    };
    expect(plans.find((p) => p.plan_token === body.plan_token)).toBeUndefined();
  });
});

describe("localhost approval UI: expired plans (#7)", () => {
  let writerPool: pg.Pool;
  let write: TwoPhaseWrite;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetTable();
    writerPool = new pg.Pool({ connectionString: WRITER_URL, max: 2 });
    write = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 100,
      statementTimeoutMs: 10_000,
      approvalRequiredAboveRows: 2,
      hardMaxRows: 500,
    });
    approval = await startApprovalServer(write, { enabled: true, port: 0 });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
    await writerPool?.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    });
  });

  it("an expired plan disappears from the pending list rather than sitting there approvable", async () => {
    const preview = await write.preview(`DELETE FROM ${TABLE} WHERE id <= 5`, [], {
      tool: "delete_rows",
      reason: "expiry-check",
    });
    expect(preview.status).toBe("awaiting_approval");

    const before = (await (await fetch(`${baseUrl}/api/plans`)).json()) as {
      plans: Array<Record<string, unknown>>;
    };
    expect(before.plans.find((p) => p.plan_token === preview.planToken)).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = (await (await fetch(`${baseUrl}/api/plans`)).json()) as {
      plans: Array<Record<string, unknown>>;
    };
    expect(after.plans.find((p) => p.plan_token === preview.planToken)).toBeUndefined();

    const approveResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(preview.planToken)}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(approveResp.status).toBe(410);
    const approveJson = (await approveResp.json()) as { code: string };
    // The HTTP surface reports the core's generalized plan-lifecycle codes;
    // the agent-facing MCP tool surface still maps this to EXPIRED_TOKEN.
    expect(approveJson.code).toBe("PLAN_EXPIRED");
  });
});

describe("localhost approval UI is reachable over plain HTTP without any MCP client connected (#7 AC6)", () => {
  let writerPool: pg.Pool;
  let write: TwoPhaseWrite;
  let approval: ApprovalServerHandle;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    writerPool = new pg.Pool({ connectionString: WRITER_URL, max: 1 });
    // No MCP Server, no MCP Client, no InMemoryTransport anywhere in this
    // describe block — only a TwoPhaseWrite instance and the approval HTTP
    // server built directly on top of it.
    write = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
    });
    approval = await startApprovalServer(write, { enabled: true, port: 0 });
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
    await writerPool?.end().catch(() => {});
  });

  it("GET / and GET /api/plans succeed with plain fetch(), with no MCP client ever having connected", async () => {
    const baseUrl = `http://${approval.host}:${approval.port}`;
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);

    const api = await fetch(`${baseUrl}/api/plans`);
    expect(api.status).toBe(200);
    const json = (await api.json()) as { plans: unknown[] };
    expect(json.plans).toEqual([]);
  });

  it("an unknown route returns a structured 404", async () => {
    const baseUrl = `http://${approval.host}:${approval.port}`;
    const resp = await fetch(`${baseUrl}/nope`);
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("NOT_FOUND");
  });
});

describe("localhost approval UI: CSRF / request-provenance hardening", () => {
  let writerPool: pg.Pool;
  let write: TwoPhaseWrite;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
    await resetTable();
    writerPool = new pg.Pool({ connectionString: WRITER_URL, max: 2 });
    write = new TwoPhaseWrite({
      pool: writerPool,
      planTtlMs: 60_000,
      statementTimeoutMs: 10_000,
      approvalRequiredAboveRows: 2,
      hardMaxRows: 500,
    });
    approval = await startApprovalServer(write, { enabled: true, port: 0 });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
    await writerPool?.end().catch(() => {});
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    });
  });

  it("rejects a request with a Host header that doesn't match the actual bound port", async () => {
    const result = await rawRequest(`${baseUrl}/api/plans`, {
      method: "GET",
      headers: { Host: "evil.example.com" },
    });
    expect(result.status).toBe(403);
    const json = JSON.parse(result.body) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("FORBIDDEN");
  });

  it("rejects a request with an Origin header that doesn't match this server's origin", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { Origin: "http://evil.example.com" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("FORBIDDEN");
  });

  it("rejects a request with Sec-Fetch-Site: cross-site", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("FORBIDDEN");
  });

  it("rejects a POST to an approve/reject route whose Content-Type isn't application/json", async () => {
    const preview = await write.preview(`DELETE FROM ${TABLE} WHERE id <= 5`, [], {
      tool: "delete_rows",
      reason: `csrf-content-type-${randomUUID()}`,
    });
    expect(preview.status).toBe("awaiting_approval");
    // A CORS "simple request" Content-Type — this is exactly the shape a
    // cross-origin page could send with fetch() or a <form> POST without the
    // browser ever issuing a preflight request.
    const resp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(preview.planToken)}/approve`,
      { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" },
    );
    expect(resp.status).toBe(415);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    // The plan is untouched — still approvable the legitimate way.
    const list = (await (await fetch(`${baseUrl}/api/plans`)).json()) as {
      plans: Array<Record<string, unknown>>;
    };
    expect(list.plans.find((p) => p.plan_token === preview.planToken)).toBeDefined();
  });

  it("rejects a POST with no Content-Type at all", async () => {
    const preview = await write.preview(`DELETE FROM ${TABLE} WHERE id <= 1`, [], {
      tool: "delete_rows",
      reason: `csrf-no-content-type-${randomUUID()}`,
    });
    const result = await rawRequest(
      `${baseUrl}/api/plans/${encodeURIComponent(preview.planToken)}/approve`,
      { method: "POST", body: "{}" },
    );
    expect(result.status).toBe(415);
    const json = JSON.parse(result.body) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("still serves legitimate requests: matching Host, no Origin, correct Content-Type", async () => {
    const getResp = await fetch(`${baseUrl}/api/plans`);
    expect(getResp.status).toBe(200);

    const preview = await write.preview(`DELETE FROM ${TABLE} WHERE id <= 1`, [], {
      tool: "delete_rows",
      reason: `csrf-legit-${randomUUID()}`,
    });
    const approveResp = await fetch(
      `${baseUrl}/api/plans/${encodeURIComponent(preview.planToken)}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(approveResp.status).toBe(200);
    expect(((await approveResp.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("still serves a legitimate request whose Origin matches this server's own origin", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { Origin: baseUrl },
    });
    expect(resp.status).toBe(200);
  });

  it("still serves a legitimate request with Sec-Fetch-Site: same-origin", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(resp.status).toBe(200);
  });

  it("still serves a direct address-bar navigation with Sec-Fetch-Site: none", async () => {
    const resp = await fetch(`${baseUrl}/api/plans`, {
      headers: { "Sec-Fetch-Site": "none" },
    });
    expect(resp.status).toBe(200);
  });

  it("sets Cache-Control: no-store on both JSON and HTML responses", async () => {
    const jsonResp = await fetch(`${baseUrl}/api/plans`);
    expect(jsonResp.headers.get("cache-control")).toBe("no-store");

    const htmlResp = await fetch(`${baseUrl}/`);
    expect(htmlResp.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404, not 500, for a malformed percent-escape in the plan-token path segment", async () => {
    const resp = await fetch(`${baseUrl}/api/plans/%E0%A4%A/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("NOT_FOUND");
  });
});
