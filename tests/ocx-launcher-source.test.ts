import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * bin/ocx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");

describe("ocx.mjs npm launcher (source invariants)", () => {
  test("Windows npm spawns use the trusted absolute invocation without shell lookup", () => {
    expect(source).toContain("const latestInvocation = npmInvocation(");
    expect(source).toContain("const installInvocation = npmInvocation(");
    expect(source).toContain("spawnSync(latestInvocation.file, latestInvocation.args");
    expect(source).toContain("spawnSync(installInvocation.file, installInvocation.args");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain('"npm.cmd"');
  });

  test("--tag is allowlisted before reaching package-manager arguments", () => {
    expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
    expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
  });
});
