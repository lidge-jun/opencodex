import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * bin/ocx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");

describe("ocx.mjs npm launcher (source invariants)", () => {
  test("npm spawns go through a shell on Windows (Node ≥18.20 EINVALs shell-less .cmd spawns)", () => {
    const spawnSites = source.match(/spawnSync\(npm,[\s\S]*?\}\)/g) ?? [];
    expect(spawnSites.length).toBe(2);
    for (const site of spawnSites) {
      expect(site).toContain("shell: winShell");
    }
    expect(source).toContain('const winShell = process.platform === "win32";');
  });

  test("--tag is allowlisted before reaching shell-joined spawn args", () => {
    expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
    expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
  });
});
