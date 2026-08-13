-- Extends mcp_audit.log's status enum for the approval-threshold / hard-cap
-- workflow (ticket #6, built on top of 02-audit-log.sql from ticket #5).
--
-- Two new outcomes now land in the audit trail alongside the original
-- previewed | approved | executed | rejected | failed:
--
--   awaiting_approval  a preview whose exact rollback-preview affected-row
--                      count exceeded write.approvalRequiredAboveRows. The
--                      token exists but execute_plan refuses it until
--                      approved (see src/writeCore.ts TwoPhaseWrite.preview).
--   hard_cap_refused   a preview whose count exceeded the separate, higher
--                      write.hardMaxRows. No token is issued at all — this
--                      is a flat refusal, not a gate (see
--                      TwoPhaseWrite.preview's hardMaxRows check).
--
-- `approved` already existed in the original enum (ticket #5 anticipated
-- it) and is reused here as-is: TwoPhaseWrite.approvePlan writes it when a
-- plan token is approved (currently the only caller is the internal
-- approvePlan method / the approve_plan MCP tool in src/server.ts — ticket
-- #7 builds the human-facing localhost UI on top of that same method).
--
-- Like 02-audit-log.sql, this file runs on first container start
-- (docker-entrypoint-initdb.d) for the disposable Docker test database. It
-- is also the committed migration for any other Postgres this server points
-- at — run it once, after 01-roles.sql and 02-audit-log.sql, as a superuser
-- or the owner of mcp_audit.log.

ALTER TABLE mcp_audit.log DROP CONSTRAINT IF EXISTS log_status_check;
ALTER TABLE mcp_audit.log
  ADD CONSTRAINT log_status_check
  CHECK (status IN (
    'previewed',
    'awaiting_approval',
    'approved',
    'executed',
    'rejected',
    'hard_cap_refused',
    'failed'
  ));
