import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TwoPhaseWrite, PendingPlan } from "./writeCore.js";
import { WriteError } from "./writeCore.js";
import type { ApprovalServerConfig } from "./config.js";

/**
 * Loopback only, always — never configurable, never 0.0.0.0. This is the
 * whole security boundary the localhost approval UI depends on: it calls
 * `TwoPhaseWrite.approvePlan()`/`rejectPlan()` directly (not through the MCP
 * tool surface), so it must be unreachable from anywhere but the machine the
 * server runs on. See DECISIONS.md and src/config.ts (ApprovalServerConfig).
 */
const LOOPBACK_HOST = "127.0.0.1";

const MAX_BODY_BYTES = 64 * 1024;

export interface ApprovalServerHandle {
  server: http.Server;
  /** Actual bound port — resolved even when config.port is 0 (OS-assigned, used by tests). */
  port: number;
  host: string;
  close(): Promise<void>;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        // A malformed body is not a reason to fail the whole action — treat
        // it the same as no body (e.g. approvedBy/reason just come back
        // null/default) rather than a 400 for what is, worst case, a UI bug.
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function statusForErrorCode(code: string): number {
  switch (code) {
    case "UNKNOWN_TOKEN":
      return 404;
    case "EXPIRED_TOKEN":
      return 410; // Gone
    case "USED_TOKEN":
    case "PLAN_REJECTED":
      return 409; // Conflict
    default:
      return 400;
  }
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Loopback binding alone does not stop CSRF: any page open in a browser on
 * the same machine can still reach `http://127.0.0.1:<port>/...`, because
 * loopback-bound sockets are still same-machine-reachable by any local
 * process, browser tab included. What distinguishes "the human loaded this
 * approval page and clicked a button" from "an unrelated webpage silently
 * hit this endpoint in the background" is request provenance: the Host the
 * browser thinks it's talking to, the Origin the request came from (when
 * present), and the browser-set Sec-Fetch-Site hint.
 *
 * `Host` is checked against `req.socket.localPort` (the actual bound port
 * for that connection) rather than `config.port`, since `config.port` can be
 * `0` ("pick any free port", used by tests) and the real answer is only
 * known after `listen()`.
 *
 * `Origin` and `Sec-Fetch-Site` are only enforced when present: non-browser
 * clients (curl, the test suite, MCP-adjacent tooling hitting these routes
 * directly) never send them, and that's a normal, legitimate way to reach
 * this server — only a *mismatched* value is evidence of a cross-origin
 * request.
 *
 * `Sec-Fetch-Site` may legitimately be `same-origin` (a fetch from the page
 * itself) or `none` (direct user navigation: typing the URL in the address
 * bar, a bookmark, a link opened from outside the browser) — only `cross-site`
 * (or `same-site` from a sibling origin) is evidence of a background request
 * planted by another page.
 */
function checkRequestProvenance(req: http.IncomingMessage): string | null {
  const expectedHost = `${LOOPBACK_HOST}:${req.socket.localPort}`;
  const hostHeader = req.headers.host;
  if (hostHeader !== expectedHost) {
    return `Host header must be "${expectedHost}", got ${hostHeader ? `"${hostHeader}"` : "(none)"}`;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== `http://${expectedHost}`) {
    return `Origin header "${origin}" does not match this server's origin`;
  }

  const secFetchSite = req.headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return `Sec-Fetch-Site "${secFetchSite}" is not same-origin or none`;
  }

  return null;
}

/** Case-insensitive, ignores a trailing `; charset=...` parameter. */
function hasJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function renderPlanCard(plan: PendingPlan): string {
  const msUntilExpiry = plan.expiresAt - Date.now();
  const secondsLeft = Math.max(0, Math.round(msUntilExpiry / 1000));
  const token = encodeURIComponent(plan.planToken);
  return `
    <article class="plan" data-token="${escapeHtml(plan.planToken)}">
      <header>
        <span class="badge">${plan.previewRows} row${plan.previewRows === 1 ? "" : "s"}</span>
        <span class="expiry">expires in ~${secondsLeft}s</span>
      </header>
      <dl>
        <dt>Tool</dt>
        <dd>${escapeHtml(plan.tool)}</dd>
        <dt>Statement</dt>
        <dd><pre>${escapeHtml(plan.statement)}</pre></dd>
        <dt>Params</dt>
        <dd><pre>${escapeHtml(JSON.stringify(plan.params))}</pre></dd>
        ${plan.target ? `<dt>Target</dt>\n        <dd>${escapeHtml(plan.target)}</dd>` : ""}
        <dt>Reason given by agent</dt>
        <dd>${plan.reason ? escapeHtml(plan.reason) : "<em>(none given)</em>"}</dd>
        <dt>Sample of affected rows (first ${plan.sampleRows.length})</dt>
        <dd><pre>${escapeHtml(JSON.stringify(plan.sampleRows, null, 2))}</pre></dd>
      </dl>
      <form class="actions" data-token="${escapeHtml(plan.planToken)}">
        <input type="text" name="actor" placeholder="Your name (optional)" />
        <input type="text" name="reason" placeholder="Rejection reason (optional)" />
        <button type="button" class="approve" data-action="approve" data-token-uri="${token}">Approve</button>
        <button type="button" class="reject" data-action="reject" data-token-uri="${token}">Reject</button>
      </form>
    </article>`;
}

function renderPage(plans: PendingPlan[]): string {
  const cards = plans.length > 0
    ? plans.map(renderPlanCard).join("\n")
    : `<p class="empty">No plans are currently awaiting approval.</p>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>sw-postgres-mcp — approval queue</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; line-height: 1.4; }
  h1 { font-size: 1.4rem; }
  .sub { opacity: 0.7; margin-top: -0.5rem; }
  .plan { border: 1px solid #8888; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .plan header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .badge { font-weight: 700; background: #e0a30022; color: #b36b00; padding: 0.15rem 0.6rem; border-radius: 999px; }
  .expiry { opacity: 0.6; font-size: 0.85rem; }
  dt { font-weight: 600; margin-top: 0.6rem; }
  dd { margin: 0.15rem 0 0; }
  pre { background: #8881; padding: 0.5rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .actions input { flex: 1; min-width: 10rem; padding: 0.35rem 0.5rem; }
  button { padding: 0.4rem 1rem; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; }
  button.approve { background: #1a7f37; color: white; }
  button.reject { background: #b3261e; color: white; }
  button:disabled { opacity: 0.5; cursor: default; }
  .empty { opacity: 0.7; font-style: italic; }
  #status { margin: 0.5rem 0; min-height: 1.2rem; }
</style>
</head>
<body>
  <h1>Pending write approvals</h1>
  <p class="sub">Localhost-only. Approve unlocks <code>execute_plan</code> for that token; reject permanently kills it.</p>
  <p><button type="button" onclick="location.reload()">Refresh</button></p>
  <div id="status"></div>
  <div id="plans">
    ${cards}
  </div>
  <script>
    document.getElementById("plans").addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const tokenUri = btn.getAttribute("data-token-uri");
      const form = btn.closest("form");
      const actor = form.querySelector('input[name="actor"]').value.trim();
      const reasonText = form.querySelector('input[name="reason"]').value.trim();
      const statusEl = document.getElementById("status");
      const allButtons = form.querySelectorAll("button");
      allButtons.forEach((b) => (b.disabled = true));
      statusEl.textContent = action === "approve" ? "Approving..." : "Rejecting...";
      try {
        const body = action === "approve"
          ? { approvedBy: actor || undefined }
          : { rejectedBy: actor || undefined, reason: reasonText || undefined };
        const resp = await fetch("/api/plans/" + tokenUri + "/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await resp.json();
        if (!resp.ok || json.ok === false) {
          statusEl.textContent = "Failed: " + (json.message || json.code || resp.status);
          allButtons.forEach((b) => (b.disabled = false));
          return;
        }
        statusEl.textContent = action === "approve" ? "Approved." : "Rejected.";
        setTimeout(() => location.reload(), 400);
      } catch (err) {
        statusEl.textContent = "Request failed: " + err;
        allButtons.forEach((b) => (b.disabled = false));
      }
    });
  </script>
</body>
</html>`;
}

function planToJson(plan: PendingPlan) {
  return {
    plan_token: plan.planToken,
    tool: plan.tool,
    reason: plan.reason,
    statement: plan.statement,
    params: plan.params,
    affected_rows: plan.previewRows,
    sample_rows: plan.sampleRows,
    target: plan.target,
    expires_at: plan.expiresAt,
    caller_id: plan.callerId,
  };
}

/**
 * Builds the localhost approval HTTP server's request handler. Every
 * approve/reject action calls `write.approvePlan()`/`write.rejectPlan()`
 * directly, in-process — this is the out-of-band, non-MCP-tool surface
 * those methods exist for (see DECISIONS.md and src/writeCore.ts). There is
 * deliberately no equivalent on the MCP tool surface in src/server.ts.
 */
export function createApprovalServer(write: TwoPhaseWrite): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(write, req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: "INTERNAL_ERROR", message: String(err) });
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(
  write: TwoPhaseWrite,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
  const path = url.pathname;

  // Applied to every route, including the read-only GET ones: a page that
  // can read /api/plans has already learned real row contents, and DNS
  // rebinding can point a hostile page's Host header at this origin, so
  // "read-only" GETs get the same provenance check as the mutating POSTs.
  const provenanceError = checkRequestProvenance(req);
  if (provenanceError) {
    sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: provenanceError });
    return;
  }

  if (method === "GET" && path === "/") {
    sendHtml(res, 200, renderPage(write.listPendingPlans()));
    return;
  }

  if (method === "GET" && path === "/api/plans") {
    sendJson(res, 200, { plans: write.listPendingPlans().map(planToJson) });
    return;
  }

  const actionMatch = /^\/api\/plans\/([^/]+)\/(approve|reject)$/.exec(path);
  if (method === "POST" && actionMatch) {
    // Browsers only preflight non-"simple" requests, so a Content-Type of
    // text/plain (or no Content-Type at all) is enough to let a cross-origin
    // page fire a real POST with no preflight for the browser to block. The
    // provenance check above already rejects a mismatched Origin, but this
    // is a second, independent gate: it also blocks a same-page <form> POST
    // (which browsers always send without any preflight, Origin included)
    // from masquerading as this JSON API.
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, {
        ok: false,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: 'Content-Type must be "application/json"',
      });
      return;
    }

    let planToken: string;
    try {
      planToken = decodeURIComponent(actionMatch[1]);
    } catch {
      // A malformed percent-escape in the token segment isn't a server
      // error — it just doesn't name a real route.
      sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: `No route for ${method} ${path}` });
      return;
    }
    const action = actionMatch[2];
    const body = await readJsonBody(req);

    try {
      if (action === "approve") {
        const approvedBy = stringField(body, "approvedBy");
        await write.approvePlan(planToken, approvedBy);
        sendJson(res, 200, { ok: true, plan_token: planToken, status: "approved", approved_by: approvedBy });
      } else {
        const rejectedBy = stringField(body, "rejectedBy");
        const reason = stringField(body, "reason");
        await write.rejectPlan(planToken, reason, rejectedBy);
        sendJson(res, 200, { ok: true, plan_token: planToken, status: "rejected", rejected_by: rejectedBy });
      }
    } catch (err) {
      if (err instanceof WriteError) {
        sendJson(res, statusForErrorCode(err.code), {
          ok: false,
          code: err.code,
          message: err.message,
          hint: err.hint ?? null,
        });
      } else {
        sendJson(res, 500, { ok: false, code: "INTERNAL_ERROR", message: String(err) });
      }
    }
    return;
  }

  sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: `No route for ${method} ${path}` });
}

/**
 * Starts the localhost approval HTTP server bound to `127.0.0.1` only —
 * never `0.0.0.0` — and separate from the MCP stdio transport. Meant to be
 * started alongside it (see src/index.ts), sharing the same `TwoPhaseWrite`
 * instance so an approval here is visible to the `execute_plan` MCP tool
 * running in the same process (plan tokens are in-memory and process-scoped
 * — see DECISIONS.md).
 */
export async function startApprovalServer(
  write: TwoPhaseWrite,
  config: ApprovalServerConfig,
): Promise<ApprovalServerHandle> {
  const server = createApprovalServer(write);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    host: LOOPBACK_HOST,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
