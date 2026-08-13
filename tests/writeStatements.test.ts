import { describe, it, expect } from "vitest";
import {
  parseQualifiedName,
  quoteIdentifier,
  requireWhereOrConfirm,
} from "../src/tools/writeStatements.js";
import { WriteError } from "../src/writeCore.js";

describe("requireWhereOrConfirm — the no-WHERE guard shared by delete_rows and update_rows (#8)", () => {
  it("refuses an empty WHERE with NO_WHERE_CLAUSE unless confirmFullTable is true", () => {
    expect(() =>
      requireWhereOrConfirm({
        where: undefined,
        confirmFullTable: undefined,
        statementVerb: "DELETE",
        actionGerund: "deleting",
      }),
    ).toThrow(WriteError);

    try {
      requireWhereOrConfirm({
        where: "  ",
        confirmFullTable: false,
        statementVerb: "UPDATE",
        actionGerund: "updating",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteError);
      expect((err as WriteError).code).toBe("NO_WHERE_CLAUSE");
      expect((err as WriteError).message).toBe("UPDATE requires a WHERE clause.");
      expect((err as WriteError).hint).toContain("confirm_full_table: true");
      expect((err as WriteError).hint).toContain("updating the whole table");
    }
  });

  it("the DELETE and UPDATE error messages differ only by the verb/gerund passed in — same underlying logic", () => {
    const deleteErr = (() => {
      try {
        requireWhereOrConfirm({ statementVerb: "DELETE", actionGerund: "deleting" });
      } catch (err) {
        return err as WriteError;
      }
      throw new Error("expected throw");
    })();
    const updateErr = (() => {
      try {
        requireWhereOrConfirm({ statementVerb: "UPDATE", actionGerund: "updating" });
      } catch (err) {
        return err as WriteError;
      }
      throw new Error("expected throw");
    })();

    expect(deleteErr.code).toBe(updateErr.code);
    expect(deleteErr.message).toBe("DELETE requires a WHERE clause.");
    expect(updateErr.message).toBe("UPDATE requires a WHERE clause.");
  });

  it("allows an empty WHERE when confirmFullTable is true", () => {
    const result = requireWhereOrConfirm({
      where: "",
      confirmFullTable: true,
      statementVerb: "UPDATE",
      actionGerund: "updating",
    });
    expect(result).toBe("");
  });

  it("a syntactically present WHERE clause counts even if it is an always-true tautology (no tautology detection)", () => {
    const result = requireWhereOrConfirm({
      where: "1=1",
      confirmFullTable: false,
      statementVerb: "UPDATE",
      actionGerund: "updating",
    });
    expect(result).toBe("1=1");
  });

  it("trims whitespace around a present WHERE clause", () => {
    const result = requireWhereOrConfirm({
      where: "  id = 1  ",
      statementVerb: "DELETE",
      actionGerund: "deleting",
    });
    expect(result).toBe("id = 1");
  });
});

describe("parseQualifiedName / quoteIdentifier — shared identifier helpers", () => {
  it("defaults to the public schema for an unqualified table name", () => {
    expect(parseQualifiedName("customers")).toEqual({ schema: "public", table: "customers" });
  });

  it("splits a schema-qualified name", () => {
    expect(parseQualifiedName("sales.customers")).toEqual({ schema: "sales", table: "customers" });
  });

  it("rejects a name with more than one dot", () => {
    expect(() => parseQualifiedName("a.b.c")).toThrow(WriteError);
  });

  it("quotes and escapes embedded double quotes", () => {
    expect(quoteIdentifier("simple")).toBe('"simple"');
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
  });
});
