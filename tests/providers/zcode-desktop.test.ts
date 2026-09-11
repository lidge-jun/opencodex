import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopStatus, disconnectDesktop, loadDesktopSettings, resolveDesktopRuntime, validateDesktopWorkspace } from "../../src/adapters/zcode/desktop";
import { readZcodeModels } from "../../src/adapters/zcode/settings";

import { resolveDesktopNode } from "../../src/adapters/zcode/desktop-node";

const { normalizeDesktopConfig, desktopModelCatalog } = createRequire(import.meta.url)("../../src/adapters/zcode/desktop-bootstrap.cjs");
let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-test-"));
  previousHome = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = join(root, "proxy");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});
const provider = () => ({ enabled: true, name: "Z.AI", kind: "anthropic", options: {
  baseURL: "https://api.z.ai/api/anthropic", apiKey: "fixture-private-value", apiKeyRequired: true,
}, models: { model: { name: "Model", limit: { context: 10000 } } } });

describe("managed ZCode Desktop", () => {
  test("normalizes only configured official Z.AI profiles, not custom/direct proxy routes", () => {
    const config = normalizeDesktopConfig({ provider: {
      "builtin:zai-coding-plan": provider(),
      "builtin:zai-empty": { ...provider(), options: { ...provider().options, apiKey: "" } },
      "builtin:zai-disabled": { ...provider(), enabled: false },
      "builtin:zai-local": { ...provider(), options: { baseURL: "https://localhost/v1" } },
      "builtin:zai-alias": { ...provider(), options: { baseURL: "https://api.z.ai.evil.invalid/v1" } },
      custom: provider(), opencodex: provider(),
    } });
    expect(Object.keys(config.provider)).toEqual(["builtin:zai-coding-plan"]);
    const catalog = desktopModelCatalog(config);
    expect(catalog).toEqual([{ id: "builtin:zai-coding-plan/model", providerId: "builtin:zai-coding-plan", modelId: "model", label: "Z.AI / Model", contextWindow: 10000 }]);
    expect(JSON.stringify(catalog)).not.toContain("fixture-private-value");
    expect(JSON.stringify(catalog)).not.toContain("apiKey");
  });
  test("runtime selection requires a Desktop resources layout, not arbitrary commands", () => {
    expect(() => resolveDesktopRuntime("node -e malicious")).toThrow("desktop_missing");
    const glm = join(root, "app/resources/glm"); mkdirSync(glm, { recursive: true });
    writeFileSync(join(glm, "zcode.cjs"), "");
    expect(() => resolveDesktopRuntime(join(root, "app"))).toThrow("desktop_missing");
    writeFileSync(join(root, "app/resources/app.asar"), "fixture");
    expect(resolveDesktopRuntime(join(root, "app"))).toBe(join(glm, "zcode.cjs"));
  });
  test("workspace rejects system roots and secret stores, follows aliases before checking", () => {
    expect(() => validateDesktopWorkspace("/")).toThrow("workspace_invalid");
    expect(() => validateDesktopWorkspace("relative")).toThrow("workspace_invalid");
    mkdirSync(process.env.OPENCODEX_HOME!, { recursive: true });
    expect(() => validateDesktopWorkspace(process.env.OPENCODEX_HOME!)).toThrow("workspace_invalid");
    const project = join(root, "project"); mkdirSync(project);
    expect(validateDesktopWorkspace(project)).toBe(project);
    if (process.platform !== "win32") {
      symlinkSync(process.env.OPENCODEX_HOME!, join(root, "alias"));
      expect(() => validateDesktopWorkspace(join(root, "alias"))).toThrow("workspace_invalid");
    }
  });
  test("disconnect persists revocation instead of falling back to operator env", async () => {
    expect(loadDesktopSettings()).toBeUndefined();
    await disconnectDesktop();
    const path = join(process.env.OPENCODEX_HOME!, "zcode-desktop/connection.json");
    expect(JSON.parse(readFileSync(path, "utf8")).connected).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => loadDesktopSettings()).toThrow("disconnected");
  });
  test("managed model discovery reads only the public cache, not Desktop credentials", () => {
    const result = readZcodeModels({ command: [], home: root, workspace: "/workspace", settingsPath: "/does/not/exist",
      scope: "desktop:test", desktopModels: [{ id: "builtin:zai/model", providerId: "builtin:zai", modelId: "model", label: "Model" }] });
    expect(result[0]?.id).toBe("builtin:zai/model");
    expect(result[0]?.runtimeModel).toEqual({});
  });
});

test("Node selection skips an incompatible nvm prefix and fails safely", () => {
  const oldPath = process.env.PATH;
  const old = join(root, "old/bin"), modern = join(root, "modern/bin");
  mkdirSync(old, { recursive: true }); mkdirSync(modern, { recursive: true });
  // Executable fixtures exercise selection independently of host Node installations.
  writeFileSync(join(old, "node"), "#!/bin/sh\necho private-vendor-diagnostic >&2\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(modern, "node"), "#!/bin/sh\nprintf compatible\n", { mode: 0o755 });
  try {
    expect(resolveDesktopNode(old + ":" + modern)).toBe(join(modern, "node"));
    expect(() => resolveDesktopNode(old)).toThrow("node_incompatible");
    expect(() => resolveDesktopNode(join(root, "absent"))).toThrow("node_missing");
    expect(() => resolveDesktopNode(".")).toThrow("node_missing");
    const bwrap = Bun.which("bwrap");
    if (bwrap) {
      symlinkSync(bwrap, join(old, "bwrap"));
      process.env.PATH = old;
      expect(desktopStatus().issue).toBe("node_incompatible");
    }
    writeFileSync(join(modern, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(() => resolveDesktopNode(modern)).toThrow("node_incompatible");
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
});
