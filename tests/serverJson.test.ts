import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, path), "utf-8"));
}

interface EnvVar {
  name: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: string;
}

interface ManifestPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport: { type: string };
  environmentVariables?: EnvVar[];
}

interface Manifest {
  $schema?: string;
  name: string;
  description: string;
  version: string;
  packages?: ManifestPackage[];
}

const serverJson = readJson("server.json") as Manifest;
const packageJson = readJson("package.json") as {
  name: string;
  version: string;
  mcpName?: string;
};

describe("server.json (MCP registry manifest)", () => {
  it("carries the registry schema pointer", () => {
    expect(serverJson.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
  });

  it("has a valid reverse-DNS name matching package.json's mcpName", () => {
    expect(serverJson.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(packageJson.mcpName).toBeDefined();
    expect(serverJson.name).toBe(packageJson.mcpName);
    expect(packageJson.mcpName).toMatch(/^io\.github\.jpka\//);
  });

  it("version matches the npm package version", () => {
    expect(serverJson.version).toBe(packageJson.version);
  });

  it("declares exactly one npm stdio package pointing at the npm name", () => {
    expect(serverJson.packages).toHaveLength(1);
    const pkg = serverJson.packages![0];
    expect(pkg.registryType).toBe("npm");
    expect(pkg.identifier).toBe(packageJson.name);
    expect(pkg.transport.type).toBe("stdio");
    expect(pkg.version).toBe(packageJson.version);
  });

  it("declares the two required database connection vars as secrets", () => {
    const pkg = serverJson.packages![0];
    const env = pkg.environmentVariables ?? [];
    const names = env.map((e) => e.name);
    expect(names).toContain("DATABASE_URL_READONLY");
    expect(names).toContain("DATABASE_URL_WRITER");
    for (const v of env) {
      if (v.name === "DATABASE_URL_READONLY" || v.name === "DATABASE_URL_WRITER") {
        expect(v.isRequired).toBe(true);
        expect(v.isSecret).toBe(true);
      }
    }
  });

  it("description is non-empty and within the schema's 100-char limit", () => {
    expect(serverJson.description.length).toBeGreaterThan(0);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
});
