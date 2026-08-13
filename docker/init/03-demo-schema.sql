-- Demo e-commerce schema (issue #10: seeded demo database generator).
--
-- Idempotent: every statement is safe to re-run against a database that
-- already has this schema. Runs automatically for the disposable Docker
-- Postgres (docker-entrypoint-initdb.d picks up every *.sql file in this
-- directory in name order, after 01-roles.sql provisions the readonly/writer
-- roles). For a plain local Postgres, npm run seed:demo applies this same
-- file before seeding, so no manual migration step is required either way.

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  country TEXT NOT NULL,
  -- 'test_tenant' marks the small, narrowly-queryable demo tenant living
  -- inside the larger inactive population (see README "Demo database").
  segment TEXT NOT NULL DEFAULT 'standard' CHECK (segment IN ('standard', 'test_tenant')),
  created_at TIMESTAMPTZ NOT NULL,
  -- Last successful login. NULL would mean "never logged in"; the demo
  -- generator always populates it. A date before 2025 marks the account
  -- inactive for demo purposes.
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded')
  ),
  created_at TIMESTAMPTZ NOT NULL,
  total_amount NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0)
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products (id),
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_customers_last_login ON customers (last_login);
CREATE INDEX IF NOT EXISTS idx_customers_segment ON customers (segment);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);

-- Grant access to the readonly/writer roles when they exist. The disposable
-- Docker Postgres always has them (provisioned by 01-roles.sql); a plain
-- local Postgres run through DATABASE_URL likely won't, so these grants are
-- best-effort and skipped rather than failing the migration.
--
-- Each GRANT is also wrapped in its own exception handler: on the disposable
-- Docker Postgres this migration is applied twice -- once as the `postgres`
-- superuser via docker-entrypoint-initdb.d (table owner, grants succeed),
-- and again every time `npm run seed:demo` runs, connected as `writer`
-- (not the table owner, no GRANT OPTION). That second run would otherwise
-- fail with "must be owner of table" even though writer already has the
-- privileges (granted on the first pass, or via 01-roles.sql's default
-- privileges) -- insufficient_privilege here just means "nothing to do".
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly') THEN
    BEGIN
      GRANT SELECT ON customers, products, orders, order_items TO readonly;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'writer') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON customers, products, orders, order_items TO writer;
      -- UPDATE (not just USAGE/SELECT) so writer can call setval() to
      -- resync a sequence after the demo seeder inserts explicit ids --
      -- TRUNCATE ... RESTART IDENTITY itself needs sequence *ownership*,
      -- which writer deliberately doesn't have, so the seeder uses setval()
      -- instead (see scripts/seed-demo.ts).
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO writer;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END
$$;
