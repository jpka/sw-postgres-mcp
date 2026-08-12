-- Provision two distinct roles for safe-write enforcement.
-- Read-only is enforced by the database, never by parsing SQL.
-- This file runs on first container start (docker-entrypoint-initdb.d).

-- Create roles (idempotent for rebuilds)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly') THEN
    CREATE ROLE readonly WITH LOGIN PASSWORD 'readonly_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'writer') THEN
    CREATE ROLE writer WITH LOGIN PASSWORD 'writer_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Ensure the application database exists (POSTGRES_DB is mcp_test via compose)
-- Grants are applied to the current database.
GRANT CONNECT ON DATABASE mcp_test TO readonly, writer;

-- Public schema usage
GRANT USAGE ON SCHEMA public TO readonly, writer;

-- Readonly: SELECT only, on existing and future tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;

-- Writer: full DML on existing and future tables + sequences
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO writer;

-- Revoke create so readonly cannot create objects (defense in depth)
REVOKE CREATE ON SCHEMA public FROM readonly;
-- Writer also should not create schema objects without explicit migration approval;
-- keep CREATE revoked by default and grant only where needed via migrations.
-- For Day 1 we allow writer to create tables via tests, so grant CREATE to writer:
GRANT CREATE ON SCHEMA public TO writer;
