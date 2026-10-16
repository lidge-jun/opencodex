import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRuntimeClampStatePath, persistEffortClamp, type EffortClampDiagnostic } from "../../src/codex/runtime";
import { clampCatalogModelsToCodexSupport } from "../../src/codex/catalog/effort";
import { resetBundledCatalogCacheForTests } from "../../src/codex/catalog/bundled";
import { resetCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
const home = () => { const root = mkdtempSync(join(tmpdir(), "ocx-clamp-notice-")); roots.push(root); return root; };
const diagnostic = (): EffortClampDiagnostic => ({ runtimePath: "/fixture/codex", runtimeVersion: "0.162.1",
  removedEfforts: ["minimal", "xhigh"], affectedModels: ["fixture/a", "fixture/b"] });
afterEach(() => {
  resetBundledCatalogCacheForTests();
  resetCodexRuntimeResolveCacheForTests();
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

test("unchanged clamp sets preserve file bytes, inode and timestamp across observations", () => {
  const configDir = home();
  persistEffortClamp(diagnostic(), { configDir, now: () => 1_800_000_000_000 });
  const path = codexRuntimeClampStatePath(configDir);
  const before = readFileSync(path, "utf8"), stat = statSync(path);
  const reordered = { ...diagnostic(), removedEfforts: ["xhigh", "minimal", "minimal"], affectedModels: ["fixture/b", "fixture/a"] };
  persistEffortClamp(reordered, { configDir, now: () => 1_800_000_001_000 });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(statSync(path).ino).toBe(stat.ino);
  expect(statSync(path).mtimeMs).toBe(stat.mtimeMs);
});

test.each(["runtimePath", "runtimeVersion", "removedEfforts", "affectedModels"] as const)(
  "a changed %s observation is persisted", field => {
    const configDir = home();
    const first = diagnostic();
    persistEffortClamp(first, { configDir, now: () => 1_800_000_000_000 });
    const next = { ...first, [field]: Array.isArray(first[field]) ? ["changed"] : "changed" } as EffortClampDiagnostic;
    persistEffortClamp(next, { configDir, now: () => 1_800_000_001_000 });
    const saved = JSON.parse(readFileSync(codexRuntimeClampStatePath(configDir), "utf8"));
    expect(saved[field]).toEqual(next[field]);
    expect(saved.updatedAt).toBe("2027-01-15T08:00:01.000Z");
  },
);

test("catalog clamp warns only on changes, preserves callbacks and can clear then warn again", () => {
  const configDir = home();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  let callbacks = 0;
  const deps = { configDir, platform: "linux" as const, env: { CODEX_CLI_PATH: "/fixture/codex", PATH: "" },
    existsSync: (path: string) => path === "/fixture/codex",
    execFileSync: (_file: string, args: readonly string[]) => args.includes("--version") ? "codex-cli 0.162.1" : JSON.stringify({ models: [{
      slug: "gpt-5.5", base_instructions: "fixture", default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    }] }),
    onEffortClamp: () => { callbacks++; },
  };
  const models = () => [{ slug: "fixture/a", default_reasoning_level: "minimal",
    supported_reasoning_levels: [{ effort: "minimal" }, { effort: "low" }, { effort: "high" }] }];
  const notices = () => warn.mock.calls.filter(call => String(call[0]).includes("Removed unsupported reasoning efforts"));
  try {
    clampCatalogModelsToCodexSupport(models(), deps);
    expect(notices()).toHaveLength(1);
    clampCatalogModelsToCodexSupport(models(), deps);
    expect(notices()).toHaveLength(1);
    expect(callbacks).toBe(2);
    expect(warn.mock.calls.some(call => String(call[0]).includes("Run ocx doctor"))).toBe(false);
    clampCatalogModelsToCodexSupport([], deps);
    clampCatalogModelsToCodexSupport(models(), deps);
    expect(notices()).toHaveLength(2);
  } finally { warn.mockRestore(); stderr.mockRestore(); }
});
