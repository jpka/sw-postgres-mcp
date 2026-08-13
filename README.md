# sw-postgres-mcp

Safe-write Postgres MCP server — an agent can read and modify a database without being able to cause an unrecoverable accident.

## Quick start

```bash
docker compose up -d
npm install
npm test
npm run build
```

Point Claude Desktop at the server (see `config.example.json` and Claude Desktop section below).

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
- `callerId` — identity recorded as `caller_id` on every audit log row (default `"unknown"`). Overridable with `SW_CALLER_ID`. See [Audit log](#audit-log).
- Environment variables `DATABASE_URL_READONLY` / `DATABASE_URL_WRITER` override the file.

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
        "DATABASE_URL_READONLY": "postgres://readonly:readonly_password@localhost:5432/mcp_test",
        "DATABASE_URL_WRITER": "postgres://writer:writer_password@localhost:5432/mcp_test"
      }
    }
  }
}
```

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

Integration tests verify against a live Postgres: role separation, readonly cannot write, `describe_schema` fields, allowlist filtering, and the demo-database seeder's row-count shape (`tests/seedDemo.test.ts` actually runs `npm run seed:demo` and queries the results back).

## Tools

- `describe_schema` — tables, columns with types, foreign keys, row-count estimates (respects read allowlist).
- `query` — run a read-only `SELECT` and return `{ columns, rows, row_count }`. Runs on the readonly role, so a mutating statement is refused by the database regardless of what the SQL says. Enforces a single statement per call and the read allowlist. Optional `limit` and `params`.
- `explain_plan` — run `EXPLAIN (FORMAT JSON)` for a candidate read statement and return the planner's estimated `cost` and `rows` without executing it. A cheap pre-check before running something potentially expensive.
- `delete_rows` — **two-phase delete**. Runs the statement inside a transaction, returns the exact affected row count plus a sample of affected rows, then rolls back. The response includes a `plan_token`, the exact `statement`, and `params` — and a `status` of `previewed` or `awaiting_approval` (see [Approval threshold and hard row cap](#approval-threshold-and-hard-row-cap) below).
- `execute_plan` — commits a previously previewed write. Pass back the `plan_token`, `statement`, and `params` from the preview response. Refused if the plan is still `awaiting_approval`.

There is deliberately no `approve_plan` (or any other approval) tool in this list. Approving an `awaiting_approval` plan is **not** exposed to the agent — see [Approval threshold and hard row cap](#approval-threshold-and-hard-row-cap) below for why and how it's meant to be wired up instead.

Every tool takes a `reason` string (recorded in the audit log — see below) and returns errors as structured `{ code, message, hint }` — never a raw Postgres exception or a multi-statement batch.

### Two-phase writes

The agent must commit to a preview before it can execute:

1. `delete_rows` runs the statement in a transaction, captures the exact affected row count and a sample of affected rows via `RETURNING`, then **rolls back**. Nothing has changed in the database.
2. `execute_plan` replays the identical statement and commits — but only if the token is valid, unexpired, unused, bound to the exact statement + params from the preview, the affected row set still matches the preview, and (see below) the plan is not still awaiting approval.

A `DELETE` without a `WHERE` clause is refused unless `confirm_full_table: true` is passed. Every write runs through the `writer` pool; the `readonly` pool is never used for a mutation.

### Approval threshold and hard row cap

The preview's **exact** rollback-preview affected-row count (never an `EXPLAIN` estimate — `write.approvalRequiredAboveRows` and `write.hardMaxRows` are only ever compared against the real, rolled-back count) decides what the same tool call does next:

| exact affected rows | outcome |
| --- | --- |
| `<= approvalRequiredAboveRows` (default 100) | unchanged: `status: "previewed"`, token works via `execute_plan` right away |
| `> approvalRequiredAboveRows`, `<= hardMaxRows` | `status: "awaiting_approval"` — the token and sample rows are returned, but `execute_plan` refuses the token (`AWAITING_APPROVAL`) until the plan has been approved out-of-band (see below) |
| `> hardMaxRows` (default 10,000) | refused outright — no `plan_token` is issued, `delete_rows` itself returns a structured `HARD_MAX_ROWS_EXCEEDED` error. This is a wall, not a gate: there is no approval path, and the agent is expected to rewrite the statement to affect fewer rows, not ask again |

**The approval mechanism this ticket (#6) builds** — for ticket #7 (the human-facing localhost approval UI) to build on: a plan token issued by a preview carries an internal `requiresApproval` / `approved` flag alongside the existing fingerprint/expiry/single-use state already in `TwoPhaseWrite`'s in-memory token store (`src/writeCore.ts`). `TwoPhaseWrite.approvePlan(planToken, approvedBy)` flips `approved` to `true` and writes an `approved` audit row. **It is deliberately NOT exposed as an MCP tool** — the agent-facing tool surface has no `approve_plan` (or any other approval) entry, because the same agent that requested a gated write must not be able to approve its own plan; see `DECISIONS.md`. There is deliberately no separate approvals database table — the plan token is already the right-sized unit `execute_plan` is scoped to, and it lives exactly where the rest of the two-phase-write state (fingerprint, expiry, used-once) already lives. Ticket #7 is expected to call `TwoPhaseWrite.approvePlan()` directly from its own (non-agent) surface — plus build a symmetric `reject`, which #6 does not — rather than duplicate this logic.

## Audit log

Every preview, approval, execution, and refusal the two-phase write core handles writes one row to `mcp_audit.log`, in the `mcp_audit` schema:

| column | meaning |
| --- | --- |
| `id`, `ts` | row id and timestamp |
| `tool` | which MCP tool drove the write (e.g. `delete_rows`) |
| `reason` | the caller-supplied `reason` string |
| `statement` | the exact SQL statement (schema/table already validated against the allowlist); empty for `approve_plan` rows (`tool` is set to the literal string `"approve_plan"`, never the original write tool, for these), which reference a plan by `plan_token` rather than restating its statement |
| `params_redacted` | a **shape**, not the literal values — `{ type, length }` per parameter, so an operator can see how many params were passed and roughly what kind, but never a customer's email, a token, or any other literal value that was part of the statement |
| `preview_rows` | the affected row count captured at preview time (the exact rollback-preview count, never an `EXPLAIN` estimate) |
| `actual_rows` | the affected row count actually committed at execute time (`null` until execution succeeds) |
| `plan_token`, `approved_by` | ties a `previewed`/`awaiting_approval` row to its later `approved`/`executed`/`failed` row; `approved_by` is set on the `approved` row (from `TwoPhaseWrite.approvePlan()`'s `approvedBy` argument, default `"unknown"`) |
| `status` | `previewed` \| `awaiting_approval` \| `approved` \| `executed` \| `rejected` \| `hard_cap_refused` \| `failed` — see [Approval threshold and hard row cap](#approval-threshold-and-hard-row-cap) for `awaiting_approval` and `hard_cap_refused`; `rejected` is reserved for ticket #7's human rejection flow (not written by anything in this ticket) |
| `duration_ms` | wall-clock time the database round trip took |
| `caller_id` | identifies the server instance/deployment (`config.callerId`, env `SW_CALLER_ID`, default `"unknown"`) — there is no per-request end-user auth in v1, so this attributes to the deployment, not an individual person |

Writing the audit row never blocks or masks the outcome of the write it describes: a failed audit insert (e.g. a transient connection blip) is logged to stderr and swallowed, never thrown, so a lost audit row can't be confused with a database write that actually failed.

**The append-only guarantee is enforced by Postgres, not by application code.** `docker/init/02-audit-log.sql` (the committed migration, applied to both the disposable Docker test database and any other target Postgres) grants the `writer` role `INSERT` — and only `INSERT` — on `mcp_audit.log`, then explicitly `REVOKE`s `UPDATE`, `DELETE`, and `TRUNCATE` from it:

```sql
GRANT INSERT ON mcp_audit.log TO writer;
REVOKE UPDATE, DELETE, TRUNCATE ON mcp_audit.log FROM writer;
```

No bug in this server, and no SQL an agent could construct through the `writer` role, can rewrite or erase a row once it lands — Postgres refuses the `UPDATE`/`DELETE` outright with `permission denied`. This is asserted by a real test against Postgres (`tests/auditLog.test.ts`), not just documented. `readonly` gets `SELECT` only, so an operator can read the trail without being able to write to it.
