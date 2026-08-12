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

## 5. Demo script (record this exactly)

1. Show the DB: 200k rows, 40k inactive test accounts.
2. Ask Claude: *"Clean up the test accounts that haven't logged in since 2024."*
3. Agent calls `delete_rows`. Server previews: **40,112 rows**, above threshold → `awaiting_approval`, with a sample of ten affected rows.
4. Show the approval UI. **Reject it.** Agent receives the rejection and adapts — narrows to a single test tenant.
5. Re-preview: 312 rows. Approve. Executes.
6. Show the audit log: both the rejected plan and the executed one, with the agent's stated reason on each.
7. Show the hard cap: attempt something over 10,000 rows and get a flat refusal with no approval path offered.

The rejected-then-adapted beat is the whole demo. Anyone can film a happy path.

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

---

## 8. Gig packaging (after the build)

- **Starter $350** — read-only server against your database, 3 days.
- **Standard $500** — safe-write with approval gating and audit log, 5 days.
- **Advanced $2,500** — multi-tenant, hosted deployment, custom tool set, monitoring, 10 days.

Lead the listing with the rejected-deletion demo video. It sells the safety layer faster than any copy.
