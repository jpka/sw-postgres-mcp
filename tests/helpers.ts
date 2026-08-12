import pg from "pg";

export const READONLY_URL =
  process.env.DATABASE_URL_READONLY ??
  "postgres://readonly:readonly_password@localhost:5432/mcp_test";
export const WRITER_URL =
  process.env.DATABASE_URL_WRITER ??
  "postgres://writer:writer_password@localhost:5432/mcp_test";
export const SUPERUSER_URL =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_SUPERUSER_URL ??
  "postgres://postgres:postgres@localhost:5432/mcp_test";

export function makePool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 2 });
}

export async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: SUPERUSER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function waitForDb(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try {
        await client.end();
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`DB not ready at ${url} after ${timeoutMs}ms`);
}
