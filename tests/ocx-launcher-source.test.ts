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
    const npmCallSites = [
      ...source.matchAll(/spawnSync\(npm,[\s\S]*?\}\)/g),
      ...source.matchAll(/runProcessTreeCommand\(npm,[\s\S]*?\}\)/g),
    ].map(match => match[0]);
    expect(npmCallSites).toHaveLength(2);
    for (const callSite of npmCallSites) expect(callSite).toContain("shell: winShell");
    expect(source).toContain('const winShell = process.platform === "win32";');
  });

  test("unsafe installer cleanup never restarts the tray, while confirmed interruption does", () => {
    const cleanupFailure = source.slice(
      source.indexOf("if (!res.treeExited)"),
      source.indexOf("if (res.interruptedSignal)"),
    );
    const interruption = source.slice(
      source.indexOf("if (res.interruptedSignal)"),
      source.indexOf("if (res.status === 0)"),
    );
    expect(cleanupFailure).not.toContain('runTrayLifecycle(launcher, "start")');
    expect(interruption).toContain('runTrayLifecycle(launcher, "start")');
    expect(interruption).toContain("process.exit(exitCode)");
    expect(source).toContain("res.error.message");
  });

  test("--tag is allowlisted before reaching shell-joined spawn args", () => {
    expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
    expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
  });
});
