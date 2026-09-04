# Build Plan: Safe-Write Postgres MCP Server

**Goal:** a published, installable MCP server that lets an agent read *and* modify a Postgres database without being able to cause an unrecoverable accident. The differentiator is the safety layer, not the tool coverage.

**Effort:** 5–6 working days.
**Deliverable set:** public repo (MIT/Apache), npm package, live demo DB, 4-minute Loom, README with threat model.

---

## 1. Why this design

The threat model is *not* SQL injection. The agent writes the SQL; it's a trusted-but-fallible author. The real risk is a **well-formed statement with catastrophic scope** — `DELETE FROM users WHERE active = false` when 40k rows match, or an `UPDATE` with a forgotten `WHERE`.

So the core mechanic is: **make the agent commit to a preview before it can execute.**

Two-phase write:
1. Agent calls a mutating tool → server runs it inside a transaction, captures the *exact* affected row count and a sample of affected rows via `RETURNING`, then **rolls back**. Returns a preview plus a signed `plan_token`.
2. Agent calls `execute_plan(plan_token)` → server replays the identical statement and commits, but only if the token is valid, unexpired, and (above threshold) approved.

This matters because `EXPLAIN` only gives the planner's *estimate*. Rolling back a real execution gives you the true number. `EXPLAIN` is still useful as a cheap pre-check to reject obviously expensive statements before you run them at all.

The agent cannot fabricate approval, because the token is server-issued and bound to the exact statement hash.

---

## 2. Tool surface (7 tools)

| Tool | Type | Notes |
|---|---|---|
| `describe_schema` | read | Tables, columns, types, FKs, row-count estimates. Respects allowlist. |
| `query` | read | SELECT only. Enforced by a read-only DB role, not by parsing. |
| `explain_plan` | read | Cost + estimated rows for a candidate statement. |
| `insert_rows` | write | Two-phase. |
| `update_rows` | write | Two-phase. Rejects statements with no `WHERE`. |
| `delete_rows` | write | Two-phase. Rejects statements with no `WHERE`. |
| `run_migration` | write | Two-phase, DDL allowed, always requires approval regardless of threshold. |

Plus one meta-tool: `execute_plan(plan_token)`.

**Design notes:**
- Every tool takes an explicit `reason` string. It goes in the audit log and it forces the model to articulate intent — which is also great demo footage.
- Return structured errors (`{code, message, hint}`), not raw Postgres exceptions. Agents recover far better from a hint like "add a WHERE clause or pass `confirm_full_table: true`" than from a stack trace.
- Reject multi-statement input everywhere. One statement per call.

---

## 3. Safety layer

**Role separation.** Two connection pools: a `readonly` Postgres role for `query`/`describe_schema`/`explain_plan`, and a `writer` role for mutations. This is enforcement at the database, so a bug in your SQL parsing can't turn a read tool into a write tool. Do not try to enforce read-only by regex.

**Allowlists.** Config file declares which schemas/tables are readable and which are writable, separately. Default deny on write.

**Thresholds.** Config sets `approval_required_above_rows` (default 100) and `hard_max_rows` (default 10,000 — refuse outright, no approval path). Migrations always require approval.

**Approval flow.** Above threshold, the server requests human confirmation before executing. Check how the current MCP spec handles this — elicitation / sampling support has been moving fast, and if there's now a sanctioned pattern for human-in-the-loop, build on it rather than inventing your own; that alignment is itself a selling point in the README. Fallback if not: the tool returns `status: "awaiting_approval"` with the plan token, and approval happens out-of-band via a tiny local web UI on localhost. The fallback is worth building anyway — it makes the demo legible on camera.

**Guards.**
- `statement_timeout` set per connection.
- Refuse `UPDATE`/`DELETE` without `WHERE` unless `confirm_full_table: true` is explicitly passed.
- Plan tokens expire (60s default) and are single-use.
- Token binds to a hash of the normalized statement + params; a changed statement invalidates it.

**Audit log.** Separate schema `mcp_audit`, one append-only table:

```
id, ts, tool, reason, statement, params_redacted,
preview_rows, actual_rows, plan_token, approved_by,
status (previewed|approved|executed|rejected|failed),
duration_ms, caller_id
```

Make it genuinely append-only: `REVOKE UPDATE, DELETE ON mcp_audit.log FROM writer`. Insert-only grant. Say this in the README — reviewers notice.

---

## 4. Day-by-day

**Day 1 — Skeleton and reads.**
Scaffold the TypeScript MCP server. Wire two connection pools with distinct roles. Ship `describe_schema`, `query`, `explain_plan`. Get it appearing and working in Claude Desktop before writing anything else — resolving the config/transport friction early avoids it derailing you later.

**Day 2 — Two-phase write core.**
Implement the preview→token→execute machinery generically, then wire `update_rows` and `delete_rows` through it. This is the heart of the project; give it the whole day. Get the transaction/rollback semantics exactly right, including nested-transaction and connection-reuse edge cases.

**Day 3 — Safety layer.**
Thresholds, allowlists, no-WHERE guard, token expiry and binding, structured errors, statement timeout. Add `insert_rows` and `run_migration` (cheap once the core exists).

**Day 4 — Audit log and approval UI.**
Audit schema plus insert-only grants. Minimal localhost approval page: pending plan, statement, preview count, sample rows, approve/reject buttons. Plain HTML is fine — resist the urge to make it a React app.

**Day 5 — Demo data and tests.**
Seed a synthetic e-commerce DB (~200k rows across customers/orders/order_items/products) with a generator script committed to the repo so anyone can reproduce it. Write integration tests against a throwaway Postgres in Docker: the safety cases are the tests that matter (threshold trip, expired token, mutated statement, no-WHERE rejection, hard-max refusal, audit row written on every path).

**Day 6 — Packaging and proof.**
README with architecture diagram and threat model. Publish to npm. Submit to an MCP registry. Record the Loom.

---

## 5. Demo script (record this exactly) — 0.4.0

> This is the 0.4.0 version of the script. Same 4-minute story as 0.3.0, but
> narrate the 0.4.0 guarantee explicitly — every approval-server route now
> requires the per-session bearer token — so the recording proves the upgrade
> rather than hiding it. `safe-write-mcp-core` is now `^0.4.0`
> (see `src/writeCore.ts`). Open the approval UI at the full URL the server
> prints once on stderr (`http://127.0.0.1:4319/?token=<token>`); the page's
> own Approve/Reject buttons already carry the token.

1. **Show the DB (20s).** `docker compose up && npm run seed:demo` — 200k rows
   (50k customers / 2k products / 60k orders / ~96k order_items), 40k inactive
   customers (`last_login < 2025-01-01`), one 8-customer test tenant fully inside
   the inactive set. Mention `write.approvalRequiredAboveRows=100`,
   `write.hardMaxRows=10000`, and `write.journalPath` (env `SW_JOURNAL_PATH`) — the
   fsync'd JSONL journal that makes the next beat recoverable.

2. **Ask Claude (15s):** *"Clean up the test accounts that haven't logged in
   since 2024."*

3. **First preview — the gate fires (40s).** Agent calls `delete_rows`
   (`where: "last_login < $1"`). Server does `BEGIN → DELETE … RETURNING * →`
   captures exact `affected_rows` + 10 `sample_rows` + `rows_digest` (md5 over
   `row_to_json` ordered), `ROLLBACK`, then `PlanStore.create(payload, {tool,
   reason, previewCount: 40112, dataDigest: null, extra:{target,sampleRows,
   rowsDigest}})` — `dataDigest` stays `null` in 0.3.0 so `beginExecute` doesn't
   fail closed before the current digest is known; the digest lives in
   `extra.rowsDigest` for the manual `ROWSET_CHANGED` check. Response:
   **40,112 rows**, `status:"awaiting_approval"` (threshold is real `ROLLBACK`
   count, not `EXPLAIN`), with the 10-row sample. Note the journal line
   (`previewed`→`awaiting_approval`) is fsync'd to `SW_JOURNAL_PATH` if set.

4. **Reject in the localhost UI (40s).** Open the full URL from the server's
   startup line (`http://127.0.0.1:4319/?token=<token>` — loopback-only,
   `127.0.0.1` — never `0.0.0.0`; 0.4.0 requires the per-session bearer token
   on every route, sent as `Authorization: Bearer <token>` or the `?token=`
   fallback the pasted URL already carries). `GET /api/plans` now returns the host-redacted
   `render` view (0.3.0 `exposeRawPayload:false` by default; this server opts back
   in with `exposeRawPayload:true` so `payload` stays visible for the demo). Click
   **Reject** with reason "too broad". The UI calls `POST /api/plans/:token/reject`
   → `PlanStore.reject()` writes the tombstone (outlives expiry), emits `rejected`.
   The agent's blocked `execute_plan` — which did `beginExecute()` → saw
   `AWAITING_APPROVAL` → `waitForApprovalOutcome()` polling `listPending()` — now
   re-runs `beginExecute()` and surfaces a structured `PLAN_REJECTED` (core
   `PLAN_REJECTED` → host `PLAN_REJECTED`) with the human's reason. Show the
   agent adapting: it narrows to the test tenant (`segment = 'test_tenant'`).

5. **Re-preview → approve → two-step execute (45s).** `delete_rows` with the
   tenant predicate previews **312 rows** (`previewed`, immediately executable, or
   still `awaiting_approval` — approve if needed). This time click **Approve**.
   Call `execute_plan` with the exact `plan_token`/`statement`/`params`. Narrate
   the 0.3.0 handoff: `beginExecute()` puts the token `executing` (emits
   `executing`, journal `executing`, `listExecuting()` now shows it); the writer
   pool runs `BEGIN → DELETE … RETURNING * →` checks `!isInsert && rowsDigest
   !== stored rowsDigest → ROWSET_CHANGED` (mapped from core
   `DATA_DIGEST_MISMATCH`), `COMMIT`; only then `confirmExecuted()` marks
   `executed` and emits `executed`. `ALREADY_EXECUTING` / `NOT_EXECUTING` /
   `NO_RECONCILE` are the new distinguishable errors if you double-execute.

6. **Show the audit + crash safety (35s).** `SELECT * FROM mcp_audit.log ORDER BY ts`:
   the rejected plan (`rejected`) and the executed one (`executed`) with the
   agent's `reason` on each, plus the new `executing` event between
   `beginExecute` and `confirmExecuted`. Then kill the server mid-execute
   (`kill -9` or `docker stop` between `beginExecute` and `confirmExecuted`,
   or just show the `listExecuting()` output) and restart with the same
   `SW_JOURNAL_PATH`: `PlanStore.fromJournal(path,{reconcile})` replays the
   journal, `reconcile(token) → "done"|"not-done"|"unknown"` settles each
   `executing` token, and the UI again shows the recovered state. A lost token
   store without the journal would require a full re-preview.

7. **Hard-cap wall (15s).** Ask for `orders.status='cancelled'` (≈13,200 rows) →
   `delete_rows` previews, sees `>hardMaxRows`, audits `hard_cap_refused`,
   returns `HARD_MAX_ROWS_EXCEEDED` with no `plan_token` and no approval path.
   Note this is a wall, not a gate — `alwaysRequireApproval` (the `run_migration`
   path) would have gated, but the hard cap never does.

The rejected-then-adapted beat is still the whole demo. The 0.3.0 additions make
the safety claim precise on camera: exact `ROLLBACK` counts, `statementFingerprint`
binding, `ROWSET_CHANGED` (`DATA_DIGEST_MISMATCH`) detection, the `executing`
handoff that is never causally disconnected from the commit, and a journal that
survives a crash. The 0.4.0 addition closes the remaining localhost hole on
camera: loopback binding plus the Host/Origin/Sec-Fetch-Site provenance checks
stop a hostile browser page, but only the per-session bearer token stops a
different local process that simply sends the expected headers — show the
`?token=` URL from the startup line, and note that a token-less `curl` gets
`401 UNAUTHORIZED`.

---

## 6. Risks

- **Transaction semantics are the hard part.** Preview-and-rollback interacts badly with connection pooling if you're careless — the preview and the execute must not share an open transaction. Budget the full day.
- **Triggers and side effects.** A rollback undoes table writes but not external side effects fired by triggers (notifications, foreign writes via FDW). Document this limitation honestly in the README; naming a limitation reads as senior, hiding one reads as junior.
- **Sequence gaps.** Rolled-back inserts still consume sequence values. Harmless, but a sharp reviewer will spot it — mention it.
- **Spec drift.** Verify current MCP spec behaviour for elicitation/approval before Day 3, not after.
- **Scope creep.** No multi-tenancy, no auth beyond local config, no cloud deploy in v1. Those are the paid upgrade tiers, not the portfolio piece.

---

## 7. What to write down as you go

Keep a `DECISIONS.md` in the repo — why two-phase over `EXPLAIN`-only, why role separation over parsing, why tokens bind to statement hashes. Three or four short entries. It costs nothing during the build and it's the artifact that makes a reviewer conclude you think like an engineer rather than a tutorial-follower. It also becomes the blog post.
