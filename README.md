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

`docker compose up` starts a disposable Postgres (postgres:16-alpine) with both roles provisioned via `docker/init/01-roles.sql`. No manual setup required for tests or local dev.

## Tests

```bash
docker compose up -d --wait
npm test
```

Integration tests verify against a live Postgres: role separation, readonly cannot write, `describe_schema` fields, and allowlist filtering.

## Tools

- `describe_schema` — tables, columns with types, foreign keys, row-count estimates (respects read allowlist).
- `query` — run a read-only `SELECT` and return `{ columns, rows, row_count }`. Runs on the readonly role, so a mutating statement is refused by the database regardless of what the SQL says. Enforces a single statement per call and the read allowlist. Optional `limit` and `params`.
- `explain_plan` — run `EXPLAIN (FORMAT JSON)` for a candidate read statement and return the planner's estimated `cost` and `rows` without executing it. A cheap pre-check before running something potentially expensive.
- `delete_rows` — **two-phase delete**. Runs the statement inside a transaction, returns the exact affected row count plus a sample of affected rows, then rolls back. The response includes a `plan_token`, the exact `statement`, and `params`.
- `execute_plan` — commits a previously previewed write. Pass back the `plan_token`, `statement`, and `params` from the preview response.

Every tool takes a `reason` string (recorded in the audit log in a later slice) and returns errors as structured `{ code, message, hint }` — never a raw Postgres exception or a multi-statement batch.

### Two-phase writes

The agent must commit to a preview before it can execute:

1. `delete_rows` runs the statement in a transaction, captures the exact affected row count and a sample of affected rows via `RETURNING`, then **rolls back**. Nothing has changed in the database.
2. `execute_plan` replays the identical statement and commits — but only if the token is valid, unexpired, unused, bound to the exact statement + params from the preview, and the affected row set still matches the preview.

A `DELETE` without a `WHERE` clause is refused unless `confirm_full_table: true` is passed. Every write runs through the `writer` pool; the `readonly` pool is never used for a mutation.
