import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import { READONLY_URL, WRITER_URL, SUPERUSER_URL, withSuperuser, waitForDb } from "./helpers.js";

describe("dual-role pools", () => {
  beforeAll(async () => {
    await waitForDb(SUPERUSER_URL);
  });

  it("readonly and writer connect as distinct Postgres roles", async () => {
    const ro = new pg.Pool({ connectionString: READONLY_URL });
    const wr = new pg.Pool({ connectionString: WRITER_URL });
    try {
      const roUser = await ro.query("SELECT current_user AS u");
      const wrUser = await wr.query("SELECT current_user AS u");
      expect(roUser.rows[0].u).toBe("readonly");
      expect(wrUser.rows[0].u).toBe("writer");
      expect(roUser.rows[0].u).not.toBe(wrUser.rows[0].u);
    } finally {
      await ro.end();
      await wr.end();
    }
  });

  it("readonly role provably cannot write (refused by Postgres)", async () => {
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS _test_readonly_guard`);
      await c.query(`CREATE TABLE _test_readonly_guard (id int primary key)`);
      // Grants are covered by default privileges, but ensure readonly has select
      await c.query(`GRANT SELECT ON _test_readonly_guard TO readonly`);
    });

    const roPool = new pg.Pool({ connectionString: READONLY_URL });
    try {
      await expect(
        roPool.query(`INSERT INTO _test_readonly_guard (id) VALUES (1)`),
      ).rejects.toThrow(/permission denied|not allowed|insufficient_privilege/i);
    } finally {
      await roPool.end();
      await withSuperuser(async (c) => {
        await c.query(`DROP TABLE IF EXISTS _test_readonly_guard`);
      });
    }
  });

  it("writer role can write", async () => {
    await withSuperuser(async (c) => {
      await c.query(`DROP TABLE IF EXISTS _test_writer_can_write`);
      await c.query(`CREATE TABLE _test_writer_can_write (id int primary key)`);
    });
    const wrPool = new pg.Pool({ connectionString: WRITER_URL });
    try {
      await expect(
        wrPool.query(`INSERT INTO _test_writer_can_write (id) VALUES (1)`),
      ).resolves.toBeDefined();
      const r = await wrPool.query(`SELECT count(*)::int AS c FROM _test_writer_can_write`);
      expect(r.rows[0].c).toBe(1);
    } finally {
      await wrPool.end();
      await withSuperuser(async (c) => {
        await c.query(`DROP TABLE IF EXISTS _test_writer_can_write`);
      });
    }
  });
});
