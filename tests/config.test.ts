import { describe, it, expect } from "vitest";
import { isTableReadable, isTableWritable } from "../src/config.js";
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
