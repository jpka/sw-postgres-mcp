import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  isTableReadable,
  isTableWritable,
  DEFAULT_WRITE_CONFIG,
} from "../src/config.js";
import type { AllowlistConfig } from "../src/config.js";

describe("allowlist config", () => {
  it("defaults to deny on write when write allowlist is empty", () => {
    const allowlist: AllowlistConfig = {
      read: { schemas: ["public"] },
      write: { schemas: [], tables: [] },
    };
    expect(isTableWritable("public", "users", allowlist)).toBe(false);
    expect(isTableWritable("public", "orders", allowlist)).toBe(false);
  });

  it("allows write when table is in write allowlist", () => {
    const allowlist: AllowlistConfig = {
      read: { schemas: ["public"] },
      write: { tables: ["public.users"] },
    };
    expect(isTableWritable("public", "users", allowlist)).toBe(true);
    expect(isTableWritable("public", "orders", allowlist)).toBe(false);
  });

  it("allows write when schema is in write allowlist", () => {
    const allowlist: AllowlistConfig = {
      read: { schemas: ["public"] },
      write: { schemas: ["public"] },
    };
    expect(isTableWritable("public", "users", allowlist)).toBe(true);
  });

  it("table allowlist is more specific than schema allowlist", () => {
    const allowlist: AllowlistConfig = {
      read: { tables: ["public.users"] },
      write: { tables: ["public.users"] },
    };
    expect(isTableReadable("public", "users", allowlist)).toBe(true);
    expect(isTableReadable("public", "orders", allowlist)).toBe(false);
  });

  it("empty read allowlist allows all (open by default for reads)", () => {
    const allowlist: AllowlistConfig = {
      read: { schemas: [], tables: [] },
      write: { schemas: [], tables: [] },
    };
    expect(isTableReadable("public", "any_table", allowlist)).toBe(true);
  });

  it("read allowlist filters correctly", () => {
    const allowlist: AllowlistConfig = {
      read: { schemas: ["public"] },
      write: { schemas: [], tables: [] },
    };
    expect(isTableReadable("public", "users", allowlist)).toBe(true);
    expect(isTableReadable("private", "users", allowlist)).toBe(false);
  });

  it("table absent from write allowlist is not writable", () => {
    const allowlist: AllowlistConfig = {
      read: { schemas: ["public"] },
      write: { schemas: ["public"], tables: [] },
    };
    // Even though schema public is allowed, a table-specific deny when tables list is empty means schema check governs.
    // Here write.schemas contains public so public.* is writable.
    expect(isTableWritable("public", "users", allowlist)).toBe(true);
    // But if write allowlist is tables-only, only listed tables are writable:
    const allowlist2: AllowlistConfig = {
      read: { schemas: ["public"] },
      write: { tables: ["public.users"] },
    };
    expect(isTableWritable("public", "orders", allowlist2)).toBe(false);
  });
});

function writeTempConfig(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "swpg-config-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      database: {
        readonlyConnectionString: "postgres://ro:ro@localhost/db",
        writerConnectionString: "postgres://rw:rw@localhost/db",
      },
      ...overrides,
    }),
  );
  return path;
}

describe("write timing config", () => {
  it("defaults planTtlMs and statementTimeoutMs when unset", () => {
    const config = loadConfig(writeTempConfig({}));
    expect(config.write).toEqual(DEFAULT_WRITE_CONFIG);
  });

  it("accepts positive integer overrides from the config file", () => {
    const config = loadConfig(
      writeTempConfig({ write: { planTtlMs: 5_000, statementTimeoutMs: 7_000 } }),
    );
    expect(config.write.planTtlMs).toBe(5_000);
    expect(config.write.statementTimeoutMs).toBe(7_000);
  });

  it("rejects zero or negative planTtlMs", () => {
    expect(() => loadConfig(writeTempConfig({ write: { planTtlMs: 0 } }))).toThrow(
      /planTtlMs/,
    );
    expect(() => loadConfig(writeTempConfig({ write: { planTtlMs: -1 } }))).toThrow(
      /planTtlMs/,
    );
  });

  it("rejects non-integer planTtlMs", () => {
    expect(() => loadConfig(writeTempConfig({ write: { planTtlMs: 1.5 } }))).toThrow(
      /planTtlMs/,
    );
    expect(() =>
      loadConfig(writeTempConfig({ write: { planTtlMs: "1.5" } })),
    ).toThrow(/planTtlMs/);
  });

  it("rejects zero or negative statementTimeoutMs", () => {
    expect(() =>
      loadConfig(writeTempConfig({ write: { statementTimeoutMs: 0 } })),
    ).toThrow(/statementTimeoutMs/);
    expect(() =>
      loadConfig(writeTempConfig({ write: { statementTimeoutMs: -100 } })),
    ).toThrow(/statementTimeoutMs/);
  });

  it("rejects non-positive values from environment overrides", () => {
    const prevTtl = process.env.SW_PLAN_TTL_MS;
    const prevRo = process.env.DATABASE_URL_READONLY;
    const prevWr = process.env.DATABASE_URL_WRITER;
    try {
      process.env.DATABASE_URL_READONLY = "postgres://ro:ro@localhost/db";
      process.env.DATABASE_URL_WRITER = "postgres://rw:rw@localhost/db";
      process.env.SW_PLAN_TTL_MS = "0";
      expect(() => loadConfig()).toThrow(/planTtlMs/);
      process.env.SW_PLAN_TTL_MS = "-5";
      expect(() => loadConfig()).toThrow(/planTtlMs/);
      process.env.SW_PLAN_TTL_MS = "1.5";
      expect(() => loadConfig()).toThrow(/planTtlMs/);
      process.env.SW_PLAN_TTL_MS = "12ms";
      expect(() => loadConfig()).toThrow(/planTtlMs/);
      delete process.env.SW_PLAN_TTL_MS;
      process.env.SW_STATEMENT_TIMEOUT_MS = "0";
      expect(() => loadConfig()).toThrow(/statementTimeoutMs/);
    } finally {
      if (prevTtl === undefined) delete process.env.SW_PLAN_TTL_MS;
      else process.env.SW_PLAN_TTL_MS = prevTtl;
      delete process.env.SW_STATEMENT_TIMEOUT_MS;
      if (prevRo === undefined) delete process.env.DATABASE_URL_READONLY;
      else process.env.DATABASE_URL_READONLY = prevRo;
      if (prevWr === undefined) process.env.DATABASE_URL_WRITER;
      else process.env.DATABASE_URL_WRITER = prevWr;
    }
  });

  it("accepts positive values from environment overrides", () => {
    const prevRo = process.env.DATABASE_URL_READONLY;
    const prevWr = process.env.DATABASE_URL_WRITER;
    try {
      process.env.DATABASE_URL_READONLY = "postgres://ro:ro@localhost/db";
      process.env.DATABASE_URL_WRITER = "postgres://rw:rw@localhost/db";
      process.env.SW_PLAN_TTL_MS = "12000";
      process.env.SW_STATEMENT_TIMEOUT_MS = "15000";
      const config = loadConfig();
      expect(config.write.planTtlMs).toBe(12_000);
      expect(config.write.statementTimeoutMs).toBe(15_000);
    } finally {
      delete process.env.SW_PLAN_TTL_MS;
      delete process.env.SW_STATEMENT_TIMEOUT_MS;
      if (prevRo === undefined) delete process.env.DATABASE_URL_READONLY;
      else process.env.DATABASE_URL_READONLY = prevRo;
      if (prevWr === undefined) process.env.DATABASE_URL_WRITER;
      else process.env.DATABASE_URL_WRITER = prevWr;
    }
  });
});
