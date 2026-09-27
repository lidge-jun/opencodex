import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bounded from "../../src/codex/inject/bounded-config-reader";
import { collectProjectCodexConfigWarnings, discoverProjectCodexConfigPaths, formatProjectCodexConfigWarningsForConsole, isGlobalOpencodexRoutingActive } from "../../src/codex/project-config-warnings";
import { removeTreeWithRetry } from "../helpers/remove-tree";

for (const kind of ["present", "absent", "unreadable"] as const) {
  test(`project warnings read exactly one global ${kind} snapshot`, () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-warning-snapshot-"));
    const global = join(root, "global.toml");
    const project = join(root, "project");
    mkdirSync(join(project, ".codex"), { recursive: true });
    const projectConfig = join(project, ".codex", "config.toml");
    writeFileSync(projectConfig, 'model_provider = "external"\n');
    const text = 'model_provider = "opencodex"\n';
    writeFileSync(global, text);
    const read = spyOn(bounded, "readBoundedCodexConfig").mockImplementation(() => {
      if (kind === "unreadable") throw new Error("fixture read failure");
      return kind === "absent" ? null : text;
    });
    try {
      const warnings = collectProjectCodexConfigWarnings({ cwd: project, codexConfigPath: global });
      expect(read).toHaveBeenCalledTimes(1);
      expect(warnings.some(w => w.code === "global_config_unreadable")).toBe(kind === "unreadable");
      expect(warnings.some(w => w.path === projectConfig)).toBe(kind !== "absent");
    } finally { read.mockRestore(); removeTreeWithRetry(root); }
  });
}

test("explicit absent snapshots never become fresh global reads", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-warning-absent-"));
  const global = join(root, "global.toml");
  writeFileSync(global, 'model_provider = "opencodex"\n');
  const read = spyOn(bounded, "readBoundedCodexConfig").mockImplementation(() => { throw new Error("unexpected reread"); });
  try {
    expect(isGlobalOpencodexRoutingActive(global, null)).toBe(false);
    expect(discoverProjectCodexConfigPaths({ cwd: root, codexConfigPath: global, maxWalkParents: 1, globalContent: null })).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); removeTreeWithRetry(root); }
});

test("console diagnostics do not describe an unreadable global config as a project bypass", () => {
  const global = { path: "/fixture/global/config.toml", code: "global_config_unreadable" as const,
    detail: "unreadable", message: "Global ownership could not be determined" };
  const project = { path: "/fixture/project/.codex/config.toml", code: "model_provider_root" as const,
    detail: "external", message: "Project selects an external provider" };
  for (const warnings of [[global], [global, project]]) {
    const lines = formatProjectCodexConfigWarningsForConsole(warnings);
    expect(lines[0]).toBe("⚠️  Codex configuration warnings:");
    expect(lines.join("\n")).toContain("readable regular file");
  }
  expect(formatProjectCodexConfigWarningsForConsole([project])[0])
    .toBe("⚠️  Project Codex config bypasses OpenCodex:");
  expect(formatProjectCodexConfigWarningsForConsole([])).toEqual([]);
});
