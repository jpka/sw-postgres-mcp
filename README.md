# sw-postgres-mcp

Safe-write Postgres MCP server — an agent can read and modify a database without being able to cause an unrecoverable accident. The differentiator is the safety layer, not the tool coverage: 8 MCP tools, 3 of them read-only, 4 write tools that only ever *preview* a change, and one `execute_plan` that commits a previewed change and nothing else.

## Architecture

```text
 Claude (agent)
      │  MCP stdio (tools/call)
      ▼
 sw-postgres-mcp
 │
 ├─ describe_schema / query / explain_plan ──► readonly pool ──► Postgres "readonly" role (SELECT only)
 │
 ├─ delete_rows / insert_rows / update_rows / run_migration
 │     │
 │     ▼
 │  TwoPhaseWrite.preview()
 │     BEGIN → run the real statement → ROLLBACK
 │     DML (delete_rows/insert_rows/update_rows): capture exact RETURNING count + sample
 │     DDL (run_migration): no RETURNING to capture — reports 0 affected rows, a `target`
 │                           table/schema extracted from the statement text, and always
 │                           goes to "awaiting_approval" regardless of that row count
 │     └─► plan_token = sha256(statement + params)   ("statementFingerprint")
 │           ├─ affected_rows ≤ approvalRequiredAboveRows  → status: "previewed"
 │           ├─ affected_rows >  approvalRequiredAboveRows → status: "awaiting_approval"
 │           └─ affected_rows >  hardMaxRows               → refused outright, no token issued
 │           (run_migration ignores both thresholds — every DDL preview is "awaiting_approval")
 │
 ├─ execute_plan(plan_token, statement, params) ──► writer pool ──► Postgres "writer" role (DML + DDL)
 │     re-derives the fingerprint from what was passed back and refuses on any mismatch
 │     (STATEMENT_MISMATCH) or an affected-row-set that changed since preview (ROWSET_CHANGED)
 │
 └─ every preview / approval / execution / rejection / refusal ──► mcp_audit.log
                                                                     (INSERT-only grant;
                                                                      UPDATE/DELETE/TRUNCATE revoked
                                                                      — see "Audit log" below)

 an "awaiting_approval" plan surfaces at:
 localhost approval UI — http://127.0.0.1:4319/  (bound to 127.0.0.1, human-only)
   approve() / reject() are called directly on the shared TwoPhaseWrite instance —
   never exposed as an MCP tool the agent itself can reach
```

Two Postgres connection pools, each authenticated as a distinct role (see [Threat model](#threat-model) below): `readonly` for `describe_schema`/`query`/`explain_plan`, `writer` for the four write-preview tools and `execute_plan`. All 4 write tools — `delete_rows`, `insert_rows`, `update_rows`, `run_migration` — share one core, `TwoPhaseWrite` (`src/writeCore.ts`): every one of them previews inside a transaction that always rolls back, then requires a separate `execute_plan` call with the exact plan token to actually commit. There is no 5th write tool and no tool that skips the preview step — `execute_plan` is the only thing in this server that commits anything, and it only ever replays a statement that was already previewed. See [Tools](#tools) below for what each tool takes and returns, and [Two-phase writes](#two-phase-writes) for the mechanics.

## Threat model

The risk here is **not SQL injection.** `delete_rows`, `insert_rows`, and `update_rows` take structured arguments — `table`, `where` + parameterized `params`, a `set` object — and every value in those structured inputs goes through `$n` placeholders, never string concatenation (see `update_rows`'s note on this in [Tools](#tools)). `run_migration` is different: DDL can't be parameterized the way DML values can, so it sends its raw agent-supplied statement directly to Postgres, the same way `query`/`explain_plan` already handle raw SQL — its safety comes not from parameterization but from always requiring human approval regardless of row count (see [Tools](#tools)), never from an `$n`-placeholder guarantee it doesn't have. The agent is the *author* of the SQL it sends, and it's a trusted-but-fallible author: it isn't trying to escape a quote, but it can absolutely produce a syntactically perfect, well-formed statement whose *scope* is the problem — `DELETE FROM users WHERE active = false` when 40,000 rows happen to match, or an `UPDATE` that silently drops its `WHERE` clause because the agent forgot one. That is the failure mode this project is built to survive, and three mechanisms carry the weight:

**1. Preview-and-rollback, not `EXPLAIN`.** `EXPLAIN` only ever gives the Postgres planner's *estimate* of how many rows a statement will touch, derived from table statistics that can be stale (especially right after a bulk load, before `ANALYZE` has run) or simply wrong for a correlated predicate the planner can't model well. An approval gate built on an estimate is a gate an agent (or ordinary data skew) can defeat by accident, not just by malice — a statement whose *true* affected-row count is 40,000 could still sail under a threshold if the planner guessed 80. So every write tool here instead runs the real statement inside `BEGIN … ROLLBACK`: the row count in the preview is the exact count a real execution just produced, not a projection. `EXPLAIN` still has a job — the standalone `explain_plan` tool offers it as a cheap, side-effect-free pre-check an agent can call before ever attempting a two-phase write — but it is never what the approval thresholds compare against.

**2. Role separation, not parsing.** `readonly` and `writer` are two distinct Postgres roles with distinct grants (`docker/init/01-roles.sql`): `readonly` has `SELECT` only (and `CREATE` explicitly revoked on its schema); `writer` has `SELECT, INSERT, UPDATE, DELETE`, gated further by this project's own write allowlist. A mutating statement submitted through the `readonly` pool is refused by Postgres itself with `permission denied` — verified against a live database in `tests/roles.test.ts`, not just asserted in code. The alternative — parsing or regex-matching SQL text to decide "is this a write?" — was deliberately not made the safety boundary: a parser can always be fooled by a form it wasn't written to catch (a CTE-wrapped `WITH x AS (DELETE FROM ... RETURNING *) SELECT * FROM x`, a mutating function call, a quoting edge case), and getting that wrong is a security hole, not a cosmetic bug. `query`/`explain_plan` do still reject non-`SELECT` statements and enforce the read allowlist by extracting table references from the statement text (`src/tools/sqlGuard.ts`) — but that is explicitly a second, defense-in-depth layer on top of the role grant, not the property itself. See `DECISIONS.md` for the full reasoning, including why a gap in that text-based allowlist parsing (which needed several hardening passes for quoted/Unicode-escaped identifiers) is a bounded allowlist-bypass risk rather than a "read tool executed a write" risk.

**3. Plan tokens bind to a statement-hash fingerprint.** A plan token by itself — a random, opaque ID — would only prove "some preview happened at some point." It says nothing about *which* statement was previewed, which means a token alone can't stop a bait-and-switch: swap in a wider `WHERE` clause, a different table, extra rows, and hand the same-looking token to `execute_plan`. So every token is bound to `statementFingerprint(statement, params)` — a SHA-256 hash of the trimmed statement text plus the JSON-serialized parameter list — computed at preview time and re-derived from whatever `execute_plan` is actually called with; any mismatch is refused as `STATEMENT_MISMATCH` before anything runs. This is what makes a human's approval in the [localhost approval UI](#localhost-approval-ui) mean something: they're approving the *exact* statement and params they were shown, not a token that could later be replayed against different SQL. (A second, independent check — the rows-affected digest — separately catches the case where the *same* statement now matches a different row set because of concurrent activity; see [Two-phase writes](#two-phase-writes) below.)

See [Limitations](#limitations) for what this model deliberately does not cover, and `DECISIONS.md` for the full write-up of each of these three decisions plus the approval-mechanism spike (#1).

## Quick start

```bash
docker compose up -d
npm install
npm test
npm run build
```

Point Claude Desktop at the server (see `config.example.json` and Claude Desktop section below). `node dist/index.js` also starts a [localhost approval UI](#localhost-approval-ui) at `http://127.0.0.1:4319/` alongside it.

## Configuration

Copy `config.example.json` to `config.json` (or set `SW_POSTGRES_CONFIG` to a custom path):

```json
{
  "database": {
    "readonlyConnectionString": "postgres://readonly:readonly_password@localhost:5432/mcp_test",
    "writerConnectionString": "postgres://writer:writer_password@localhost:5432/mcp_test"
  },
  "allowlist": {
    "read": { "schemas": ["public"], "tables": [] },
    "write": { "schemas": [], "tables": [] }
  }
}
```

- `allowlist.read` — schemas/tables the agent may see via `describe_schema`/`query`. If empty, all tables are readable. If `tables` is non-empty, only those fully-qualified tables are listed.
- `allowlist.write` — schemas/tables the agent may mutate. **Defaults to deny**: if both `schemas` and `tables` are empty, nothing is writable. Add entries explicitly.
- `write.planTtlMs` — how long a `plan_token` stays valid (default `60000`). Overridable with `SW_PLAN_TTL_MS`.
- `write.statementTimeoutMs` — per-connection `statement_timeout` for write executions (default `10000`). Overridable with `SW_STATEMENT_TIMEOUT_MS`.
- `write.approvalRequiredAboveRows` — a preview whose **exact** rollback-preview affected-row count is at or below this returns a token `execute_plan` will honour immediately, same as today. Above it, the preview instead returns `status: "awaiting_approval"` and the token is refused by `execute_plan` until a human approves it out-of-band (see [Approval threshold and hard row cap](#approval-threshold-and-hard-row-cap) below — approval is deliberately not an agent-facing MCP tool). Default `100`. Overridable with `SW_APPROVAL_REQUIRED_ABOVE_ROWS`.
- `write.hardMaxRows` — a second, higher, separate threshold. A preview whose exact affected-row count exceeds this is refused outright: no token is issued at all, and there is no approval path — the response is a flat structured error (`HARD_MAX_ROWS_EXCEEDED`), not something to escalate past. Default `10000`. Overridable with `SW_HARD_MAX_ROWS`. Must be `>= write.approvalRequiredAboveRows`; `loadConfig` throws otherwise.
- `approvalServer.enabled` — whether the [localhost approval UI](#localhost-approval-ui) starts alongside the MCP server (default `true`). Overridable with `SW_APPROVAL_SERVER_ENABLED` (`"true"`/`"false"`).
- `approvalServer.port` — port the localhost approval UI listens on, bound to `127.0.0.1` only (default `4319`). Overridable with `SW_APPROVAL_SERVER_PORT`.
- `callerId` — identity recorded as `caller_id` on every audit log row (default `"unknown"`). Overridable with `SW_CALLER_ID`. See [Audit log](#audit-log).
- Environment variables `DATABASE_URL_READONLY` / `DATABASE_URL_WRITER` override the file.

The config is read **once at server startup** — a running server never re-reads `config.json`. After editing it, restart the MCP server (quit and reopen Claude Desktop / your MCP client), or the old config keeps being enforced. On startup the server logs to stderr which config file it loaded and the effective write allowlist; if no config file is found it warns loudly, because a missing file means an empty write allowlist (default deny — every write refused).

Two connection pools are created with distinct Postgres roles (`readonly` vs `writer`). Read-only is enforced by the database grants, not by parsing SQL — a bug in our code cannot turn a read tool into a write tool.

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sw-postgres-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/sw-postgres-mcp/dist/index.js"],
      "env": {
        "SW_POSTGRES_CONFIG": "/absolute/path/to/sw-postgres-mcp/config.json",
        "DATABASE_URL_READONLY": "postgres://readonly:readonly_password@localhost:5432/mcp_test",
        "DATABASE_URL_WRITER": "postgres://writer:writer_password@localhost:5432/mcp_test"
      }
    }
  }
}
```

`SW_POSTGRES_CONFIG` is set explicitly because MCP clients do not spawn the server with the project directory as the working directory, so the default `./config.json` lookup would silently miss it.

Restart Claude Desktop. Ask "what's in this database?" — `describe_schema` returns tables, columns with types, foreign keys, and row-count estimates for exactly the allowlisted schemas/tables.

## Docker

`docker compose up` starts a disposable Postgres (postgres:16-alpine) with both roles provisioned via `docker/init/01-roles.sql`, the audit schema created via `docker/init/02-audit-log.sql`, and its `status` enum extended for the approval workflow via `docker/init/03-approval-workflow.sql`. No manual setup required for tests or local dev.

## Demo database

```bash
docker compose up -d --wait
npm run seed:demo
```

Seeds a synthetic e-commerce dataset (`customers`, `products`, `orders`, `order_items`, ~208k rows total) into an empty database, so there's realistic data to point `describe_schema` / `query` / the write tools at without a real production dataset lying around. The schema (`docker/init/03-demo-schema.sql`) is applied automatically for the disposable Docker Postgres; `npm run seed:demo` applies it itself for a plain local Postgres, so no manual migration step is required either way. Generation is deterministic — a seeded PRNG (mulberry32, not `Math.random()`), so the same `--seed` always produces the exact same rows:

```bash
npm run seed:demo -- --seed=7
npm run seed:demo -- --connection="postgres://user:pass@host:5432/db"
```

Connection resolution follows the same precedence as everywhere else in this project: `--connection` flag > `DATABASE_URL_WRITER` > `POSTGRES_WRITER_URL` > `DATABASE_URL` > the docker-compose writer default. Each run truncates and regenerates the four demo tables, so it's safe to re-run against a non-empty database.

Row-count shape (default seed):

| group | rows | notes |
| --- | --- | --- |
| `customers` | 50,000 | |
| `products` | 2,000 | |
| `orders` | 60,000 | |
| `order_items` | ~96,000 | 1-4 items/order |
| inactive customers (`last_login < 2025-01-01`) | 40,000 | ~80% of customers |
| test tenant (`customers.segment = 'test_tenant'`) | 8 customers / 320 orders | a small, narrowly-queryable tenant entirely inside the inactive population |
| `orders.status = 'cancelled'` | 13,200 | exceeds a 10,000-row hard cap, for exercising a hard-cap refusal |

## Tests

```bash
docker compose up -d --wait
npm test
```

Integration tests verify against a live Postgres: role separation, readonly cannot write, `describe_schema` fields, allowlist filtering, and the demo-database seeder's row-count shape (`tests/seedDemo.test.ts` actually runs `npm run seed:demo` and queries the results back). `tests/approvalUi.test.ts` starts the localhost approval HTTP server for real (on an OS-assigned port) and drives it with plain `fetch()` — no browser automation — covering the pending-plan listing, the approve/reject HTTP endpoints end-to-end (including unlocking and permanently killing `execute_plan`), the loopback-only bind, audit rows, expired-plan filtering, and that the surface works with no MCP client connected at all. `tests/insertRows.test.ts` and `tests/updateRows.test.ts` cover the same preview→token→execute discipline, the approval threshold/hard cap, the write allowlist, audit logging, SQL-injection-shaped inputs, and (for inserts) the sequence-gap behavior, for the two newer write tools; `tests/writeStatements.test.ts` unit-tests the no-`WHERE` guard the two DELETE/UPDATE tools share. `tests/runMigration.test.ts` drives `run_migration` through the same real localhost approval server (never `TwoPhaseWrite` called directly) to prove the row-count threshold is never consulted, a rejection reaches `execute_plan` as `PLAN_REJECTED`, multi-statement input and out-of-allowlist targets are refused before touching the database, and — against the live Postgres — that `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and `CREATE INDEX` all preview-then-roll-back and execute-then-commit correctly; it also unit-tests `src/tools/ddlTarget.ts`'s statement-target extraction directly.

### Safety case

Every test file above proves its own ticket's guard works for the one tool that ticket introduced it on. `tests/safetyCase.test.ts` instead runs a fixed matrix of safety properties — threshold trip, hard-cap refusal, expired/reused/mutated/rejected tokens, allowlist enforcement, the readonly role, audit-trail completeness, audit immutability, and preview-leaves-no-trace — against *every* write tool each property applies to, via shared `it.each`-driven helpers rather than per-tool copies, specifically to catch a guard that was wired into one tool but silently missed on another. One block runs the threshold/hard-cap rows against a dataset generated by the same deterministic generator `npm run seed:demo` uses (issue #10), so the guards are demonstrated at realistic seeded-data volumes, not just small synthetic counts.

## Tools

- `describe_schema` — tables, columns with types, foreign keys, row-count estimates (respects read allowlist).
- `query` — run a read-only `SELECT` and return `{ columns, rows, row_count }`. Runs on the readonly role, so a mutating statement is refused by the database regardless of what the SQL says. Enforces a single statement per call and the read allowlist. Optional `limit` and `params`.
- `explain_plan` — run `EXPLAIN (FORMAT JSON)` for a candidate read statement and return the planner's estimated `cost` and `rows` without executing it. A cheap pre-check before running something potentially expensive.
- `delete_rows` — **two-phase delete**. Runs the statement inside a transaction, returns the exact affected row count plus a sample of affected rows, then rolls back. The response includes a `plan_token`, the exact `statement`, and `params` — and a `status` of `previewed` or `awaiting_approval` (see [Approval threshold and hard row cap](#approval-threshold-and-hard-row-cap) below). Refuses a statement with no `WHERE` clause unless `confirm_full_table: true` is passed.
- `insert_rows` — **two-phase insert**. Takes `table`, `columns` (an array of column names), and `rows` (an array of value-arrays, one per row, positional against `columns`), plus `reason`. Runs the `INSERT ... VALUES (...), (...) RETURNING *` inside a transaction, returns the exact row count and a sample of the rows it would insert, then rolls back. See [Sequence values and rolled-back inserts](#sequence-values-and-rolled-back-inserts) below for a side effect worth knowing about. Example:
  ```json
  {
    "table": "customers",
    "columns": ["email", "active"],
    "rows": [
      ["a@example.com", true],
      ["b@example.com", false]
    ],
    "reason": "seeding two test accounts"
  }
  ```
- `update_rows` — **two-phase update**. Takes `table`, `set` (a `{ "column": value, ... }` object of what to change), `where` + `params` (parameterized WHERE conditions, same convention as `delete_rows`), `confirm_full_table`, and `reason`. Runs the `UPDATE ... SET ... WHERE ... RETURNING *` inside a transaction, returns the exact affected row count and a post-update sample, then rolls back. Refuses a statement with no `WHERE` clause unless `confirm_full_table: true` is passed — the exact same guard `delete_rows` uses (`src/tools/writeStatements.ts`), not a reimplementation. Example:
  ```json
  {
    "table": "customers",
    "set": { "active": false },
    "where": "last_login < $1",
    "params": ["2025-01-01"],
    "reason": "deactivating accounts inactive since before 2025"
  }
  ```
  Column names in `set` are always quoted identifiers and values are always `$n` parameters — never string-concatenated into the statement — so a crafted column name or value cannot inject SQL; a malformed column name simply fails as an unknown column.
- `run_migration` — **two-phase DDL**. Takes `statement` (a single `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, or `CREATE [UNIQUE] INDEX ... ON <table>` statement) and `reason`. Runs it inside a transaction — Postgres DDL is transactional, so this rolls back cleanly — then rolls back. **Always requires human approval**: every `run_migration` preview comes back `status: "awaiting_approval"`, unconditionally — `write.approvalRequiredAboveRows`/`hardMaxRows` are never consulted for this tool, no matter how small or row-count-free the migration looks (see [Migrations always require approval](#migrations-always-require-approval) below). Since DDL has no `RETURNING`-based row count to show, the response's `affected_rows`/`sample_rows` are always `0`/`[]` — not a faked count — and a `target` field (the schema-qualified table/index the statement extracted, e.g. `"public.customers"`) is included instead, so a human has something concrete to judge. Multi-statement input (e.g. two semicolon-separated `CREATE TABLE`s) is rejected before ever reaching the database. Example:
  ```json
  {
    "statement": "ALTER TABLE customers ADD COLUMN loyalty_tier text",
    "reason": "adding a column the new loyalty feature needs"
  }
  ```
- `execute_plan` — commits a previously previewed write. Pass back the `plan_token`, `statement`, and `params` from the preview response (`delete_rows`, `insert_rows`, `update_rows`, or `run_migration`). Refused (`AWAITING_APPROVAL`) if the plan is still awaiting approval, or (`PLAN_REJECTED`) if a human rejected it via the [localhost approval UI](#localhost-approval-ui).

There is deliberately no `approve_plan` or `reject_plan` (or any other approval) tool in this list. Approving or rejecting an `awaiting_approval` plan is **not** exposed to the agent — see [Localhost approval UI](#localhost-approval-ui) below for why and how it's meant to be used instead.

Every tool takes a `reason` string (recorded in the audit log — see below) and returns errors as structured `{ code, message, hint }` — never a raw Postgres exception or a multi-statement batch.

### Two-phase writes

`delete_rows`, `insert_rows`, `update_rows`, and `run_migration` all go through the exact same core (`TwoPhaseWrite` in `src/writeCore.ts`) — the agent must commit to a preview before it can execute:

1. The tool runs the statement in a transaction, captures the exact affected/inserted row count and a sample of affected rows via `RETURNING` (for `run_migration`, see below — DDL has no `RETURNING` to capture), then **rolls back**. Nothing has changed in the database.
2. `execute_plan` replays the identical statement and commits — but only if the token is valid, unexpired, unused, and bound to the exact statement + params from the preview. For `delete_rows`/`update_rows`, it also refuses to commit if the *matched* row set changed since the preview (`ROWSET_CHANGED`) — and (see below) the plan must not still be awaiting approval.

A `DELETE`/`UPDATE` without a `WHERE` clause is refused unless `confirm_full_table: true` is passed — one guard, shared by both tools (`src/tools/writeStatements.ts`), not two copies that could drift. `INSERT` has no `WHERE` clause, so this guard doesn't apply to `insert_rows`. Every write runs through the `writer` pool; the `readonly` pool is never used for a mutation.

The `ROWSET_CHANGED` check is deliberately skipped for `insert_rows`: that check exists to catch "the rows a WHERE clause matches changed between preview and execute," which has no equivalent for INSERT — there's no pre-existing row set to match. `insert_rows` still gets everything else the core provides (the exact statementFingerprint binding, single-use/expiring tokens, the approval threshold and hard cap, and full audit logging); see `DECISIONS.md` for why comparing RETURNING digests across an INSERT's preview and execute would otherwise refuse the write on every single call against a table with a server-generated column.

`run_migration`'s DDL statements skip the same check for the same underlying reason (no pre-existing matched row set), but for a stronger reason still: DDL doesn't support a `RETURNING` clause at all, so there's no digest — or affected-row count, or sample rows — to compute in the first place. `run_migration` runs the raw statement inside the preview's `BEGIN`/`ROLLBACK` (Postgres DDL is transactional, so a `CREATE TABLE`/`ALTER TABLE` preview rolls back exactly like a DELETE/UPDATE preview does) and reports `affected_rows: 0`, `sample_rows: []` — not a stand-in for a real count, just the accurate answer for a statement with no rows to return — plus a `target` field naming the schema-qualified table/index it extracted from the statement, so a human approving it has something concrete to judge instead. See [Migrations always require approval](#migrations-always-require-approval) below and `DECISIONS.md`.

### Sequence values and rolled-back inserts

Because `insert_rows`'s preview is a real `INSERT ... RETURNING *` that then **rolls back**, any `serial`/`identity`/other sequence-backed default on the target table's columns still advances — Postgres sequences are not transactional, so a rollback does not return a consumed sequence value. This means:

- Previewing an insert (even one you never execute) permanently uses up one or more values from that column's sequence.
- The `id` (or similar) shown in the preview's `sample_rows` is illustrative, not a promise — the row actually committed by `execute_plan` will very likely get a *different* sequence-generated value, since the preview's own rollback already consumed the one shown.
- This shows up as gaps in serial columns over time (e.g. ids `1, 2, 5, 6` instead of `1, 2, 3, 4`) purely from previews, whether or not they were ever executed. This is harmless — Postgres sequences have never guaranteed gap-free values, even without this tool — but worth knowing about before treating a serial column as a dense counter.

### Approval threshold and hard row cap

The preview's **exact** rollback-preview affected-row count (never an `EXPLAIN` estimate — `write.approvalRequiredAboveRows` and `write.hardMaxRows` are only ever compared against the real, rolled-back count) decides what the same tool call does next:

| exact affected rows | outcome |
| --- | --- |
| `<= approvalRequiredAboveRows` (default 100) | unchanged: `status: "previewed"`, token works via `execute_plan` right away |
| `> approvalRequiredAboveRows`, `<= hardMaxRows` | `status: "awaiting_approval"` — the token and sample rows are returned, but `execute_plan` refuses the token (`AWAITING_APPROVAL`) until the plan has been approved out-of-band (see below) |
| `> hardMaxRows` (default 10,000) | refused outright — no `plan_token` is issued, `delete_rows` itself returns a structured `HARD_MAX_ROWS_EXCEEDED` error. This is a wall, not a gate: there is no approval path, and the agent is expected to rewrite the statement to affect fewer rows, not ask again |

**The approval mechanism (#6)** a plan token issued by a preview carries an internal `requiresApproval` / `approved` / `rejected` flag alongside the existing fingerprint/expiry/single-use state in the in-memory plan store (`safe-write-mcp-core`'s `PlanStore`, held by `TwoPhaseWrite` in `src/writeCore.ts`). Approving flips `approved` to `true` and writes an `approved` audit row; rejecting sets `rejected` permanently and writes a `rejected` audit row (`TwoPhaseWrite.approvePlan()`/`rejectPlan()` are the programmatic entry points). **Neither is exposed as an MCP tool** — the agent-facing tool surface has no `approve_plan`/`reject_plan` (or any other approval) entry, because the same agent that requested a gated write must not be able to approve its own plan; see `DECISIONS.md`. There is deliberately no separate approvals database table — the plan token is already the right-sized unit `execute_plan` is scoped to, and it lives exactly where the rest of the two-phase-write state (fingerprint, expiry, used-once) already lives. The [localhost approval UI](#localhost-approval-ui) (#7) is the only approval surface: it acts on the same store directly, from its own (non-agent) HTTP surface.

### Migrations always require approval

`run_migration` (#9) does **not** use the table above. The row-count thresholds are never consulted for it, at all — every `run_migration` preview comes back `status: "awaiting_approval"` unconditionally, even for a migration whose `affected_rows` is `0` and would be nowhere near `approvalRequiredAboveRows`. This is deliberate: a migration that touches zero rows (adding a column, dropping a table with no rows in it, creating an index) can still be the single most destructive thing this server does — the row count DELETE/UPDATE/INSERT use as a proxy for "how much is at stake" doesn't mean anything for schema changes, so it is never treated as one.

Mechanically, `src/tools/runMigration.ts` passes `alwaysRequireApproval: true` on every call to `TwoPhaseWrite.preview()` — a `WriteMeta` field `preview()` OR's into the same `requiresApproval` decision the row-count threshold makes for the other tools (`src/writeCore.ts`). This is hardcoded in the tool module's own code, not read from `run_migration`'s arguments: there is no field in its MCP `inputSchema` (`src/server.ts`) that reaches it, so the calling agent has no parameter that weakens or bypasses it, and no `write.approvalRequiredAboveRows`/`hardMaxRows` misconfiguration can accidentally let a migration through — the flag doesn't consult either setting in the first place. From there, `run_migration` gets every other approval-mechanism guarantee for free, the same way `delete_rows`/`insert_rows`/`update_rows` do: the [localhost approval UI](#localhost-approval-ui) is the only way to approve or reject it, a rejection permanently kills the token with a structured `PLAN_REJECTED` error on the next `execute_plan` attempt, and every preview/approval/execution/rejection is audited with the agent's `reason`.

`run_migration` also enforces the write allowlist before ever calling `preview()`: the statement's target table (or, for `DROP TABLE`, every table it names) is extracted from the statement text and checked with the exact same `isTableWritable` logic the data write tools use — see `src/tools/ddlTarget.ts` and `DECISIONS.md` for which DDL forms are supported and why `DROP INDEX` currently isn't.

## Localhost approval UI

A small, plain-HTML page — no React, no build step — for a human to see what an agent wants to do above the approval threshold and say yes or no. It runs as its own local-only HTTP server (`src/approvalServer.ts`), separate from the MCP stdio transport, started alongside it by `src/index.ts` and bound to `127.0.0.1` only (never `0.0.0.0` — see `DECISIONS.md`). It shares the same in-memory `TwoPhaseWrite` instance as the MCP server, so an approval or rejection here is immediately visible to `execute_plan` on the MCP connection.

- **Access:** open `http://127.0.0.1:4319/` (or whatever `approvalServer.port` is configured to) in a browser on the machine the server runs on. It is unreachable from any other machine — there is no host/bind-address config option, on purpose.
- **What it shows:** every plan currently `awaiting_approval` — the tool, the exact statement, the agent's stated `reason`, the exact rollback-preview affected-row count, a sample of the affected rows (`sample_rows` from the preview), and — when the preview extracted one (currently only `run_migration`) — a `target` naming the schema-qualified table/index the statement acts on, which is what a human reviews a DDL migration by in place of a row count. An expired plan disappears from this list rather than sitting there approvable. A machine-readable equivalent is at `GET /api/plans` (JSON), reachable with plain `fetch()`/`curl` — no browser or MCP client required, which is also how the acceptance tests in `tests/approvalUi.test.ts` and `tests/runMigration.test.ts` exercise it.
- **Approve** (`POST /api/plans/:token/approve`, optional `{ approvedBy }` body) approves the plan directly on the in-memory plan store, in-process — not through any MCP tool. `execute_plan` on that token succeeds immediately afterward.
- **Reject** (`POST /api/plans/:token/reject`, optional `{ rejectedBy, reason }` body) permanently kills the token on the store. It can never be approved or executed afterward, even by a later "approve" click or a second "reject" click (both are safely idempotent — no-ops beyond re-auditing). The agent's next `execute_plan` call against that token gets a structured, distinguishable `PLAN_REJECTED` error (not `AWAITING_APPROVAL`, not `EXPIRED_TOKEN`, not a generic failure) whose message includes the human's rejection reason when one was given, so the agent has something concrete to act on — narrow the statement and re-preview, rather than just retrying blindly.
- **Audit:** every approve and reject writes one row to `mcp_audit.log` (`status: "approved"` / `"rejected"`, `approved_by` set from `approvedBy`/`rejectedBy`, default `"unknown"`), the same table and column the MCP-driven previews/executions already write to.
- **Security boundary:** approving/rejecting is only reachable through this HTTP surface, never through an MCP tool the connected agent can call — the same self-approval hole ticket #6 fixed for `approve_plan` applies equally to `reject_plan`, so neither is on the MCP tool list in `src/server.ts`.

## Audit log

Every preview, approval, execution, and refusal the two-phase write core handles writes one row to `mcp_audit.log`, in the `mcp_audit` schema:

| column | meaning |
| --- | --- |
| `id`, `ts` | row id and timestamp |
| `tool` | which MCP tool drove the write (e.g. `delete_rows`) |
| `reason` | the caller-supplied `reason` string |
| `statement` | the exact SQL statement (schema/table already validated against the allowlist); empty for `approve_plan`/`reject_plan` rows (`tool` is set to that literal string, never the original write tool, for these), which reference a plan by `plan_token` rather than restating its statement |
| `params_redacted` | a **shape**, not the literal values — `{ type, length }` per parameter, so an operator can see how many params were passed and roughly what kind, but never a customer's email, a token, or any other literal value that was part of the statement |
| `preview_rows` | the affected row count captured at preview time (the exact rollback-preview count, never an `EXPLAIN` estimate) |
| `actual_rows` | the affected row count actually committed at execute time (`null` until execution succeeds) |
| `plan_token`, `approved_by` | ties a `previewed`/`awaiting_approval` row to its later `approved`/`rejected`/`executed`/`failed` row; `approved_by` is set on the `approved` row (from the `approvedBy` given to `TwoPhaseWrite.approvePlan()` or the approval UI's approve endpoint) and, reused for the same "who actioned this token" purpose, on the `rejected` row (from the `rejectedBy` given to `rejectPlan()` or the reject endpoint) — default `"unknown"` for either when no identity was given |
| `status` | `previewed` \| `awaiting_approval` \| `approved` \| `executed` \| `rejected` \| `hard_cap_refused` \| `failed` — see [Approval threshold and hard row cap](#approval-threshold-and-hard-row-cap) for `awaiting_approval` and `hard_cap_refused`, and [Localhost approval UI](#localhost-approval-ui) for `approved`/`rejected` |
| `duration_ms` | wall-clock time the database round trip took |
| `caller_id` | identifies the server instance/deployment (`config.callerId`, env `SW_CALLER_ID`, default `"unknown"`) — there is no per-request end-user auth in v1, so this attributes to the deployment, not an individual person |

Writing the audit row never blocks or masks the outcome of the write it describes: a failed audit insert (e.g. a transient connection blip) is logged to stderr and swallowed, never thrown, so a lost audit row can't be confused with a database write that actually failed.

**The append-only guarantee is enforced by Postgres, not by application code.** `docker/init/02-audit-log.sql` (the committed migration, applied to both the disposable Docker test database and any other target Postgres) grants the `writer` role `INSERT` — and only `INSERT` — on `mcp_audit.log`, then explicitly `REVOKE`s `UPDATE`, `DELETE`, and `TRUNCATE` from it:

```sql
GRANT INSERT ON mcp_audit.log TO writer;
REVOKE UPDATE, DELETE, TRUNCATE ON mcp_audit.log FROM writer;
```

No bug in this server, and no SQL an agent could construct through the `writer` role, can rewrite or erase a row once it lands — Postgres refuses the `UPDATE`/`DELETE` outright with `permission denied`. This is asserted by a real test against Postgres (`tests/auditLog.test.ts`), not just documented. `readonly` gets `SELECT` only, so an operator can read the trail without being able to write to it.

## Limitations

Stated plainly, not hidden:

- **A rollback undoes table writes, not external side effects.** A `delete_rows`/`insert_rows`/`update_rows`/`run_migration` preview really does roll back — but if a `BEFORE`/`AFTER` trigger on the affected table fires a `NOTIFY`, calls an external service, or writes through a foreign data wrapper (FDW) to another database, that side effect already happened and is **not** undone by the preview's `ROLLBACK`. Postgres transactions only ever guarantee the transactional table state comes back; they cannot retract a message already sent to something outside the database. If a table an agent can write to has such a trigger, treat the preview step itself as side-effecting, not as free.
- **Rolled-back inserts (and previewed DDL) still consume sequence values.** Postgres sequences are not transactional, so a rolled-back `insert_rows` preview — or a rolled-back `CREATE TABLE ... GENERATED ... AS IDENTITY`-style DDL preview — permanently advances any `serial`/`identity` sequence the affected columns default from. This shows up as gaps in serial columns purely from previews, whether or not they were ever executed. Harmless (Postgres sequences never guaranteed gap-free values to begin with) but worth knowing about; see [Sequence values and rolled-back inserts](#sequence-values-and-rolled-back-inserts) above.
- **The audit log's append-only guarantee is a property of the `writer` role's grants, not of this server's code**, and it only holds for connections that go through that role. `docker/init/02-audit-log.sql` grants `writer` `INSERT` only on `mcp_audit.log` and revokes `UPDATE`/`DELETE`/`TRUNCATE` — see [Audit log](#audit-log) above — but a **superuser connection is outside this model entirely**: a Postgres superuser, the table's owner, or any role holding (or grantable) `UPDATE`/`DELETE`/`TRUNCATE` on `mcp_audit.log` — via table ownership, direct grant, or `ALTER`/`GRANT` rights over the `writer` role itself — can rewrite or erase audit rows regardless of what `writer`'s own grants say. The guarantee is "this server, using the credentials it was configured with, cannot tamper with its own audit trail" — not "the audit trail is tamper-proof against whoever administers the database."
- **No multi-tenancy.** One server process talks to one Postgres database with one pair of `readonly`/`writer` roles and one allowlist. There is no per-tenant credential scoping or per-tenant audit partitioning; running this for multiple tenants means running multiple server instances with separate config.
- **No auth beyond local config.** There is no per-request end-user authentication — `caller_id` (see [Audit log](#audit-log)) identifies the deployment/config, not an individual person behind an MCP session. Anyone who can talk to this server's stdio transport (or, for approvals, reach `127.0.0.1` on the machine it runs on) can use it as whatever role it's configured with.
- **No cloud deployment support in v1.** The localhost approval UI is bound to `127.0.0.1` on purpose (see [Localhost approval UI](#localhost-approval-ui)) and is not reachable from another machine — there is no remote-approval story, no TLS termination, no multi-user approval routing. This is designed to run next to the agent on one machine, not as a hosted service.
- **Plan-token and approval state is in-memory and process-scoped.** `TwoPhaseWrite`'s token store has no persistence beyond the audit log — a server restart loses every pending `awaiting_approval` plan (it has to be re-previewed from scratch) and every plan's approval state. Only the *history* of what was previewed/approved/executed survives a restart, in `mcp_audit.log`; the live "can `execute_plan` accept this token right now" state does not. See `DECISIONS.md` (#6) for why this was a deliberate choice, not an oversight.
- **`run_migration`'s allowlist enforcement doesn't cover every DDL form.** `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and `CREATE [UNIQUE] INDEX ... ON <table>` are supported; a bare `DROP INDEX <name>` is refused outright (`UNSUPPORTED`) rather than allowlist-checked, because the table an index belongs to can't be determined from that statement's text alone. See `DECISIONS.md` (#9).
- **Single-statement, single-database.** Every tool refuses multi-statement input and there is no cross-statement/cross-table transaction spanning multiple tool calls — each `delete_rows`/`insert_rows`/`update_rows`/`run_migration` call is its own independent preview/execute pair. There's no way to preview two related writes (e.g. an `UPDATE` plus a dependent `INSERT`) and approve them as one atomic unit.

## Publishing to the MCP Registry

`server.json` is the committed manifest for the official [MCP Registry](https://registry.modelcontextprotocol.io). `tests/serverJson.test.ts` checks it carries the registry schema URL and the key manifest properties (reverse-DNS name, version, npm package entry, `stdio` transport, required env vars), and keeps it in sync with `package.json` — its `name` must equal the `mcpName` field in `package.json`, which is the npm ownership-verification marker the registry checks on publish.

Publishing is a CLI flow (not a GitHub PR) and requires the npm package to already exist:

1. Publish to npm: `npm run build && npm publish` (see issue #24).
2. Install the publisher: `brew install mcp-publisher`, or download the release binary from [`modelcontextprotocol/registry`](https://github.com/modelcontextprotocol/registry/releases).
3. Authenticate: `mcp-publisher login github` (device flow).
4. Publish: `mcp-publisher publish` — reads `server.json` and registers the server.

The manifest's `name` (`io.github.jpka/sw-postgres-mcp`) is namespaced under the GitHub account, so GitHub authentication is sufficient — no DNS challenge. The `DATABASE_URL_READONLY` / `DATABASE_URL_WRITER` environment variables it declares are the same connection strings the [Configuration](#configuration) section describes.

## License

[MIT](./LICENSE)
