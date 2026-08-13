-- mcp_audit: an append-only audit trail. Every preview, execution, rejection
-- and failure the server handles leaves one row here, so an operator can
-- query a single table and reconstruct exactly what an agent tried, why it
-- said it was doing it, and what actually happened.
--
-- This file runs on first container start (docker-entrypoint-initdb.d), same
-- as 01-roles.sql, so the disposable Docker test database gets this schema
-- automatically. It is also the committed migration for any other Postgres
-- this server points at — run it once, as a superuser or the owner of the
-- `readonly`/`writer` roles, after 01-roles.sql.

CREATE SCHEMA IF NOT EXISTS mcp_audit;

CREATE TABLE IF NOT EXISTS mcp_audit.log (
  id               BIGSERIAL PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  tool             TEXT NOT NULL,
  reason           TEXT,
  statement        TEXT NOT NULL,
  params_redacted  JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview_rows     INTEGER,
  actual_rows      INTEGER,
  plan_token       TEXT,
  approved_by      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('previewed', 'approved', 'executed', 'rejected', 'failed')),
  duration_ms      INTEGER,
  caller_id        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS log_plan_token_idx ON mcp_audit.log (plan_token) WHERE plan_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS log_ts_idx ON mcp_audit.log (ts);

-- Append-only, enforced at the database — not a convention the application
-- code politely follows. `writer` is the only role the server ever uses to
-- touch this table, and it gets exactly the grants below: it may INSERT (and
-- use the id sequence an INSERT needs), and nothing else. UPDATE, DELETE and
-- TRUNCATE are explicitly revoked, so no bug in this server, and no SQL an
-- agent could ever construct through the writer role, can rewrite or erase a
-- row once it lands. This mirrors how read-only is enforced for the
-- `readonly` role in 01-roles.sql: by a grant the role does not have, not by
-- code choosing to behave.
GRANT USAGE ON SCHEMA mcp_audit TO writer;
GRANT INSERT ON mcp_audit.log TO writer;
GRANT USAGE ON SEQUENCE mcp_audit.log_id_seq TO writer;
REVOKE UPDATE, DELETE, TRUNCATE ON mcp_audit.log FROM writer;

-- readonly may read the trail (an operator inspecting history needs no
-- write capability at all) but never gets INSERT/UPDATE/DELETE on it.
GRANT USAGE ON SCHEMA mcp_audit TO readonly;
GRANT SELECT ON mcp_audit.log TO readonly;
