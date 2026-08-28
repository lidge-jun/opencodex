import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCodexCliUpdateInspectionArgv } from "../src/update/codex-cli-update-launch-policy.mjs";

describe("Codex CLI updater launcher policy", () => {
  test("covers the whole exact namespace including malformed actions", () => {
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "codex-cli-update", "check"])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "codex-cli-update", "bad"])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv([
      "node", "ocx", "--ocx-internal-launch-proof=bad", "system", "codex-cli-update", "check",
    ])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv([
      "node", "ocx", "--ocx-internal-launch-proof=bad", "system", "codex-cli-update", "bad",
    ])).toBe(true);
    expect(isCodexCliUpdateInspectionArgv(["node", "ocx", "system", "update"])).toBe(false);
  });

  test("launcher skips boot repair and lazy Bun installation for this namespace", () => {
    const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
    expect(source).toContain("!codexCliUpdateInspection && isNodeModulesInstall()");
    expect(source).toContain("resolveBun({ allowInstall: !codexCliUpdateInspection })");
    expect(source).toContain("if (allowInstall && existsSync(installJs))");
  });
});
