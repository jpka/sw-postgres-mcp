# DECISIONS

Each entry records a single architectural decision: the question, what the options
were, what we picked, and the reasoning a reviewer can check. Newest first.

---

## 2026-08-13 — Localhost approval UI: reject as a tombstone, pending-plan data stored on the token, one HTTP surface with no framework

**Ticket:** #7 (localhost approval UI with approve and reject). Builds directly on the
2026-08-13 / #6 entry below — same plan-token store, same "no separate approvals table"
reasoning, same "not an MCP tool" security boundary, now extended to a symmetric reject.

**Approach vs. #1's conclusion:** unchanged. #1 (see the 2026-08-12 entry below)
concluded the out-of-band localhost page is the primary approval mechanism because no
shipping client we target implements spec-native elicitation/MRTR yet. Nothing about
that client-support situation changed by this ticket, so this page is built exactly as
#1 anticipated — no divergence to record there.

### Where the pending-plan data (statement, sample rows) lives

`TokenEntry` (the in-memory record `TwoPhaseWrite.preview()` already creates per plan)
previously stored only a fingerprint hash and a rows digest hash of the statement/params
— enough to *verify* a later `execute_plan` call, but not enough to *display* the
statement or sample rows again later. The localhost page needs to render both without
re-running the preview (which would re-execute the statement inside a fresh
transaction). Two options: (a) add `statement`, `params`, and `sampleRows` directly onto
`TokenEntry`, or (b) stand up a second, parallel store keyed by `plan_token` just for
display data. (a) was picked — it is one more field group next to the
`requiresApproval`/`approved` flags the 2026-08-13/#6 entry below already put there,
governed by the same lifecycle (created at preview, alive until used/expired/rejected),
rather than a second data structure that could drift out of sync with the first. The
memory cost is bounded by the same TTL and prune() sweep that already bounds the token
store's size.

### Reject semantics: a permanent tombstone, not a deletion

"Permanently kills the token" (the ticket's own words) could mean either (a) delete the
entry outright, so a later `execute_plan`/`approvePlan` call reports `UNKNOWN_TOKEN`, or
(b) keep the entry with a `rejected` flag set, so those calls report a distinct
`PLAN_REJECTED` instead. (b) was picked, for the acceptance criterion that matters most
here: *"The agent receives a rejection as a structured error distinguishable from a
timeout, an expiry, or a hard-cap refusal."* `UNKNOWN_TOKEN` already means "never issued
or long gone" for three unrelated reasons (typo, stale token, server restart) — collapsing
"a human looked at this and said no" into that same bucket would make the one outcome
this ticket exists to make legible indistinguishable from an agent's-own bug. So:

- `TokenStore.reject()` sets `entry.rejected = true` and (once) an optional
  `rejectionReason`; it never deletes the entry.
- `prune()` (which normally sweeps used/expired entries) explicitly skips rejected
  entries, so a rejected token cannot silently age out into `UNKNOWN_TOKEN` before an
  agent's retried `execute_plan` call reaches it.
- Both `consume()` (backing `execute_plan`) and `approve()` check `entry.rejected` first
  — ahead of used/expired/fingerprint checks — so rejection wins regardless of what else
  is true about the call. This is also what makes "approving after rejecting" and
  "rejecting twice" both safe: approve() on a rejected entry fails with `PLAN_REJECTED`
  (never flips `approved`), and reject() on an already-rejected entry succeeds again
  idempotently without changing anything.
- The cost is that a rejected token's memory is never reclaimed by TTL alone — bounded
  in practice (rejections are a human-paced, low-volume path; see #6's entry below on
  bounding tombstone-style state by the same lifecycle as everything else), and
  acceptable for a v1 whose plan-token store is already fully in-memory and
  process-scoped with no persistence story beyond the audit log.

### `approved_by` reused for "who rejected", no new migration

The audit schema (`docker/init/02-audit-log.sql`) has one actor-identity column,
`approved_by`, sized for `TwoPhaseWrite.approvePlan()`'s `approvedBy` argument.
`rejectPlan()`'s `rejectedBy` argument is written into that same column rather than
adding a `rejected_by` column that would sit next to it doing the identical job — the
column already means "who actioned this token," not narrowly "who approved this token,"
and a second column with the same shape and purpose would only exist to satisfy a naming
mismatch, not a real distinction. `docker/init/03-approval-workflow.sql` (ticket #6)
already extended `mcp_audit.log.status`'s `CHECK` constraint to include `rejected`
in anticipation of this ticket, so no new migration was needed for #7 at all.

### One local HTTP server, `node:http`, no new dependency

The page is server-rendered plain HTML with a small inline `<script>` doing two
`fetch()` calls (approve/reject) and reloading — the ticket explicitly asks to resist
making this a React app ("a form with two buttons"). Built on Node's built-in `http`
module rather than adding Express or similar: the whole surface is four routes (`GET /`,
`GET /api/plans`, `POST /api/plans/:token/approve`, `POST /api/plans/:token/reject`), and
the project has otherwise stayed dependency-light (`pg`, `zod`, the MCP SDK). The JSON
API (`GET /api/plans` and the two POST actions) exists as a first-class surface, not an
implementation detail behind the HTML — it is what `tests/approvalUi.test.ts` drives
directly with plain `fetch()`, matching the ticket's own guidance that no browser
automation is needed to verify this.

The server binds to `127.0.0.1` unconditionally — `src/approvalServer.ts` hardcodes the
host, and `config.approvalServer` (src/config.ts) only exposes `enabled`/`port`, no host
override — so there is no configuration path that could accidentally expose it on
`0.0.0.0`. `src/index.ts` constructs one `TwoPhaseWrite` instance and shares it between
`startServer` (the MCP stdio transport) and `startApprovalServer`, so an approval or
rejection is visible to `execute_plan` in the same process without any new
inter-process channel.

---

## 2026-08-13 — Approval mechanism's shape: a flag on the plan token, no separate approvals table

**Ticket:** #6 (approval threshold, hard row cap, `awaiting_approval`). Read by: #7
(localhost approval UI), which is expected to build its "approve" / "reject" buttons
on top of what's described here rather than invent its own storage.

**Question:** #6 needs *some* concrete way for a plan to go from "awaiting approval" to
"approved" — #7 explicitly "unlocks `execute_plan`" on top of it, but #7's actual UI is
out of scope here. What is the smallest mechanism that is still a real, documented
contract #7 can build on, rather than a placeholder #7 has to redesign?

### What #6 builds

- Two new `write` config thresholds, both compared against the **exact** rollback-preview
  row count (`TwoPhaseWrite.preview`'s `affectedRows`), never an `EXPLAIN` estimate:
  `approvalRequiredAboveRows` (default 100) and `hardMaxRows` (default 10,000, must be
  `>= approvalRequiredAboveRows`).
- A plan token's in-memory record (`TokenEntry` in `src/writeCore.ts`, alongside the
  fingerprint/expiry/used-once state ticket #4 already put there) gained two fields:
  `requiresApproval` (set once, at preview time, from the threshold check above) and
  `approved` (`true` immediately if `!requiresApproval`; otherwise flipped by approval).
  `execute_plan` refuses with `AWAITING_APPROVAL` while `requiresApproval && !approved`.
- `TwoPhaseWrite.approvePlan(planToken, approvedBy)` is the entire approval mechanism:
  it looks up the token, flips `approved = true`, and writes an `approved` audit row
  (`tool` set explicitly to `"approve_plan"`; `approved_by` = the caller-supplied
  identity, default `"unknown"`). It does not consume the token — `execute_plan` still
  runs its own statement/fingerprint/expiry/rowset checks afterward, unchanged. It is
  idempotent (approving twice, or approving a token that never required approval, both
  just succeed).
- **Deliberately NOT exposed as an MCP tool.** `approve_plan` is a real, callable,
  internal/programmatic method — not a stub — so it can be exercised by tests and (once
  #7 exists) by a human, but it is not on the agent-facing MCP server's tool list. The
  whole point of `awaiting_approval` is a human-in-the-loop gate; if the same MCP
  connection an agent uses to request a gated write could also call `approve_plan`, the
  gate would be theater — the requesting agent could preview a write, "approve" its own
  plan with a self-reported `approved_by`, and execute it, with nothing to stop it. So
  `approvePlan` is exported from `TwoPhaseWrite` for #7's out-of-band localhost approval
  page (see the 2026-08-12 entry below) to call directly, and is exercised in tests the
  same way — never through the MCP tool-dispatch layer.
- A row over `hardMaxRows` never reaches any of the above: no token is created at all
  (`HARD_MAX_ROWS_EXCEEDED`, audited as `hard_cap_refused`). There is nothing for an
  approval mechanism to act on in that case by design — the ticket's "wall, not a gate."

### What #6 deliberately does not build

- **No `reject_plan` / no `rejected` audit status wired up.** `mcp_audit.log.status`
  already had `rejected` in its enum (anticipated by #5), and this ticket's migration
  (`docker/init/03-approval-workflow.sql`) leaves it in place, but nothing in #6 writes
  it. Rejection is #7's acceptance criteria (permanently invalidate the token; refuse
  even a correct statement afterward) and #7's to build, most likely as
  `TwoPhaseWrite.rejectPlan` alongside `approvePlan`, deleting the token from the store
  outright rather than approving it.
- **No standalone approvals table.** The plan token is already the unit `execute_plan`
  is scoped to, and it already lives somewhere ticket #4 built for exactly this kind of
  short-lived, single-use state — an in-memory `TokenStore` inside one running
  `TwoPhaseWrite` instance. Approval state is one more flag on that same record, not a
  new subsystem. This does mean approval is scoped to the process that issued the
  preview (same as the token's expiry and single-use guarantee already were) — a plan
  previewed against one server instance cannot be approved from another. That was
  already true of every other property of a plan token before this ticket; #7's
  same-process localhost page does not change it.
- **No listing/query API for pending plans.** #7 needs "list what's awaiting approval"
  for its page. #6 does not add a `list_pending_plans`-shaped tool; the `TokenStore` has
  no enumeration method today. #7 will need to add one (e.g. an accessor on `TokenStore`
  exposing entries with `requiresApproval && !approved && !used && !expired`, or reading
  `mcp_audit.log` for the most recent `awaiting_approval` row per un-superseded
  `plan_token`) — either is compatible with what's here.

### Why this shape, not a database-backed approvals table

A DB table would survive a server restart and be inspectable directly with `query`
without a bespoke listing tool — real advantages. It was not chosen because the plan
token itself does not survive a server restart either (the whole two-phase-write core is
in-memory and TTL'd), so a persisted approval record would outlive the thing it approves
by design, which is more confusing than convenient: an operator could "approve" a token
that has already silently expired. Keeping approval state exactly as durable as the plan
it approves — no more, no less — was judged the more honest contract. The audit log
already gives durability for the *history* of what was approved and by whom; it is just
not the thing `execute_plan` checks live.

### For #7

Two front-ends over one mechanism, same framing as the 2026-08-12 entry below:
`TwoPhaseWrite.approvePlan()` (this ticket) is the whole "approve" button's backend
already — #7's localhost page calls it directly (it is not, and must not become, an MCP
tool the agent itself can reach). #7 mainly needs to add (a) a way to list pending
(`awaiting_approval`, unexpired, unused) plans, and (b) a symmetric `rejectPlan` that
deletes the token instead of approving it and returns a rejection `execute_plan` can
distinguish from `AWAITING_APPROVAL` / `EXPIRED_TOKEN` / `USED_TOKEN` (its own new
`WriteErrorCode`, e.g. `PLAN_REJECTED`) — likewise called directly by #7's page, not
exposed as `reject_plan` on the MCP server.

---

## 2026-08-12 — Approval route: out-of-band localhost UI; spec-native elicitation deferred to client support

**Ticket:** #1 (spike: how the current MCP spec handles human-in-the-loop approval).

**Question:** When a write is above the approval threshold, how does a human sign off?

### What the current spec supports

Version checked: **2026-07-28** (published 2026-07-28, the current revision). Date checked: 2026-08-12.

- A first-class server-to-user confirmation channel has existed since **2025-06-18**:
  `elicitation`, form mode — the server sends `elicitation/create` mid-`tools/call` with a
  restricted JSON Schema, the client renders it, and the user answers with
  `accept` / `decline` / `cancel`. (Added via PR #382.)
- **2025-11-25** extended it: URL mode for out-of-band interactions that must not pass
  through the client (OAuth consent, payments), plus richer enums and schema defaults.
- **2026-07-28** replaced the stream-based server→client requests with **Multi Round-Trip
  Requests (MRTR, SEP-2322)**: a `tools/call` handler returns
  `resultType: "input_required"` with an `inputRequests` map and an optional opaque
  `requestState`; the client gathers the answers and retries the original call with
  `inputResponses` and the echoed `requestState`. No held-open stream. The Tier-1 SDKs
  (TypeScript, Python, Go, C#) ship 2026-07-28 support. A related requirement (SEP-2260)
  makes a server prompt only while it is actively processing a client request — no
  unsolicited prompts.

So the spec-native route exists, is sanctioned, and is designed for exactly this use case
(server / clients SHOULD present confirmation prompts for sensitive operations).

### The concrete client support situation — why we are not building on it yet

Per the spike's own rule — *"a pattern no shipping client implements is not usable yet"* —
for our target client, elicitation is that pattern today:

- **Claude Code CLI:** elicitation shipped since v2.1.76, per the MCP client capability
  matrix (spec PR #2398, merged 2026-03-14).
- **Claude Desktop app (our target):** elicitation is **not** listed in the capability
  matrix (only Roots). A server's `elicitation/create` is not surfaced; Desktop returns
  an immediate `cancel` (anthropics/claude-code#56243), which an approval flow cannot
  distinguish from a user rejecting.
- **Claude.ai:** not shipped; the feature request remains open
  (anthropics/claude-ai-mcp#153).

Anthropic's 2026-07-28 rollout announcement also frames client support as rolling out,
not shipped.

### Decision

The approval flow takes the **out-of-band localhost page** route (Ticket #7) as its
primary mechanism. This is a deliberate, documented fallback — the route the build plan
anticipated — not a gap. Two reasons, in order:

1. **Client reality:** the target client (Claude Desktop) implements no spec-native
   approval channel today, so a spec-native-only design would be inert in the demo.
2. **Demo legibility:** the plan's proof beat is *reject the plan, watch the agent
   adapt*. Rendering that in our own localhost page showcases the refusal; a client
   chrome might swallow it.

### Designed so the spec-native route can be layered on later

The two-phase write core (preview → plan token → `execute_plan`) already mirrors the
spec's shape. When a client declares the `elicitation` capability — or negotiates
2026-07-28 MRTR — the server can express "awaiting approval" as an in-band elicitation
or an `input_required` result whose `requestState` is bound to the same plan token
(after the same preview/rollback). Approval becomes spec-native with no change to the
token, threshold, or audit logic. The localhost page and a future native surface are two
front-ends over one approval store.

### Sources (primary)

- 2026-07-28 spec, MRTR: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- 2026-07-28 spec, elicitation (form + URL): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- 2025-11-25 spec, elicitation: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- 2025-06-18 spec, elicitation (introduced): https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- 2025-06-18 changelog (elicitation added, PR #382): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/changelog.mdx
- 2025-11-25 changelog (URL mode SEP-1036/PR #887, defaults SEP-1034, enums SEP-1330): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/changelog.mdx
- Client capability matrix (Claude Code: elicitation; Desktop: roots only; Claude.ai: apps): https://github.com/modelcontextprotocol/specification/pull/2398
- 2026-07-28 release notes: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Claude Desktop surfaces elicitation as cancel, no Desktop support: https://github.com/anthropics/claude-code/issues/56243 and https://github.com/anthropics/claude-code/issues/41110
- Claude.ai elicitation not shipped: https://github.com/anthropics/claude-ai-mcp/issues/153