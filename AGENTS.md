# sw-postgres-mcp

A safe-write Postgres MCP server: an agent can read *and* modify a database without being able to cause an unrecoverable accident. The differentiator is the safety layer, not the tool coverage.

See [mcp-postgres-build-plan.md](./mcp-postgres-build-plan.md) for the full build plan.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
