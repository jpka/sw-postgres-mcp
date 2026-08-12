import pg from "pg";
import type { AppConfig } from "./config.js";

export interface Pools {
  readonlyPool: pg.Pool;
  writerPool: pg.Pool;
}

export function createPools(config: AppConfig): Pools {
  const readonlyPool = new pg.Pool({
    connectionString: config.database.readonlyConnectionString,
    max: 5,
    statement_timeout: 10_000,
  });

  const writerPool = new pg.Pool({
    connectionString: config.database.writerConnectionString,
    max: 5,
    statement_timeout: 10_000,
  });

  return { readonlyPool, writerPool };
}

export async function closePools(pools: Pools): Promise<void> {
  await Promise.all([pools.readonlyPool.end(), pools.writerPool.end()]);
}

export async function assertRolesDistinct(pools: Pools): Promise<void> {
  const ro = await pools.readonlyPool.query("SELECT current_user AS user");
  const wr = await pools.writerPool.query("SELECT current_user AS user");
  if (ro.rows[0].user === wr.rows[0].user) {
    throw new Error(
      `Readonly and writer pools must use distinct roles, both are ${ro.rows[0].user}`,
    );
  }
}
