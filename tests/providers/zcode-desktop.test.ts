import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { desktopStatus, disconnectDesktop, loadDesktopSettings, resolveDesktopRuntime, validateDesktopWorkspace } from "../../src/adapters/zcode/desktop";
import { readZcodeModels } from "../../src/adapters/zcode/settings";

import { parseNativeOAuthEvent, nativeOAuthCommand } from "../../src/adapters/zcode/native-oauth";
import { resolveDesktopNode } from "../../src/adapters/zcode/desktop-node";

const { normalizeDesktopConfig, desktopModelCatalog } = createRequire(import.meta.url)("../../src/adapters/zcode/desktop-bootstrap.cjs");
let root: string;
let previousHome: string | undefined;
let previousSandbox: string | undefined;
beforeEach(() => {
  previousSandbox = process.env.OCX_ZCODE_SANDBOX; process.env.OCX_ZCODE_SANDBOX = "1";
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-test-"));
  previousHome = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = join(root, "proxy");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousSandbox === undefined) delete process.env.OCX_ZCODE_SANDBOX; else process.env.OCX_ZCODE_SANDBOX = previousSandbox;
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

test("native OAuth emits only bounded public events, never tokens or vendor errors", () => {
  expect(parseNativeOAuthEvent({ type: "authenticated", subjectHash: "a".repeat(64), accessToken: "fixture-private-token" }))
    .toEqual({ type: "authenticated", subjectHash: "a".repeat(64) });
  expect(parseNativeOAuthEvent({ type: "error", code: "private-profile-detail", stack: "secret" }))
    .toEqual({ type: "error", code: "native_oauth_failed" });
  expect(parseNativeOAuthEvent({ type: "authorization", url: "https://chat.z.ai/api/oauth/authorize?state=fixture" }))
    .toEqual({ type: "authorization", url: "https://chat.z.ai/api/oauth/authorize?state=fixture" });
  const credentialUrl = new URL("https://chat.z.ai/"); credentialUrl.username = "fixture";
  for (const url of ["http://chat.z.ai/", "https://chat.z.ai.evil.invalid/", credentialUrl.href, "not a url"]) {
    expect(() => parseNativeOAuthEvent({ type: "authorization", url })).toThrow("native_oauth_failed");
  }
  expect(() => parseNativeOAuthEvent({ type: "authenticated", subjectHash: "not-an-identity" })).toThrow("native_oauth_failed");
  expect(() => parseNativeOAuthEvent({ type: "tokens", accessToken: "secret" })).toThrow("native_oauth_failed");
});

test("native OAuth sandbox refuses the live HOME and symlink profiles", () => {
  if (process.platform !== "linux") return;
  expect(() => nativeOAuthCommand("/not/used", homedir(), "login")).toThrow("profile_invalid");
  const privateHome = join(root, "private");
  mkdirSync(privateHome, { mode: 0o700 });
  symlinkSync(privateHome, join(root, "profile-link"));
  expect(() => nativeOAuthCommand("/not/used", join(root, "profile-link"), "login")).toThrow("profile_invalid");
});


test("sandbox preflight executes a child and hides uid-map diagnostics", async () => {
  if (process.platform !== "linux") return;
  const { verifyDesktopSandbox } = await import("../../src/adapters/zcode/desktop-sandbox");
  const executable = join(root, "bwrap-probe");
  writeFileSync(executable, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n", { mode: 0o755 });
  expect(() => verifyDesktopSandbox(executable)).toThrow("sandbox_unavailable");
  // A failed probe is not cached: an operator correction can be retried immediately.
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  expect(() => verifyDesktopSandbox(executable)).not.toThrow();
  writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(() => verifyDesktopSandbox(executable)).toThrow("sandbox_unavailable");
});

test("host execution is the default; a workspace is not a filesystem boundary", async () => {
  const { desktopSandboxEnabled } = await import("../../src/adapters/zcode/desktop");
  delete process.env.OCX_ZCODE_SANDBOX;
  expect(desktopSandboxEnabled()).toBe(false);
  expect(validateDesktopWorkspace(homedir())).toBe(homedir());
  process.env.OCX_ZCODE_SANDBOX = "1";
  expect(desktopSandboxEnabled()).toBe(true);
  expect(() => validateDesktopWorkspace(homedir())).toThrow("workspace_invalid");
});

test("host bootstrap reads and writes outside workspace without touching the source profile", async () => {
  const { ZcodeClient } = await import("../../src/adapters/zcode/client");
  const { fileURLToPath } = await import("node:url");
  const home = join(root, "state"), workspace = join(root, "project");
  mkdirSync(join(home, ".zcode/cli/db"), { recursive: true });
  mkdirSync(workspace);
  const external = join(root, "outside-report.txt");
  writeFileSync(external, "report fixture");
  const config = join(root, "desktop-config.json");
  const original = JSON.stringify({ provider: { "builtin:zai-coding-plan": provider() } });
  writeFileSync(config, original);
  const runtime = join(root, "official-runtime-fixture.cjs");
  writeFileSync(runtime, `
    const fs=require("node:fs");
    require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
      const r=JSON.parse(line);
      const path=${JSON.stringify(external)};
      const value=fs.readFileSync(path,"utf8");
      fs.writeFileSync(path,value);
      process.stdout.write(JSON.stringify({id:r.id,result:{read:value,written:true,cwd:process.cwd()}})+"\\n");
    });
  `);
  const settings = { command: [resolveDesktopNode(), fileURLToPath(new URL("../../src/adapters/zcode/desktop-bootstrap.cjs", import.meta.url)),
    "--host", runtime, config, workspace], home, workspace, settingsPath: "", scope: "desktop:test-host" };
  // Repeated processes must not fail on an existing config, or overwrite Desktop's file.
  for (let i = 0; i < 2; i++) {
    const client = new ZcodeClient(settings);
    try {
      const models = await client.request("opencodex/desktopModels", {}, 3000);
      expect(models.models).toHaveLength(1);
      const state = await client.request("workspace/readState", {}, 3000);
      expect(state).toEqual({ read: "report fixture", written: true, cwd: workspace });
    } finally { await client.close(); }
  }
  expect(readFileSync(config, "utf8")).toBe(original);
});

test("missing or denied optional sandbox never falls back, while default host mode needs no bwrap", () => {
  if (process.platform !== "linux") return;
  const path = process.env.PATH;
  const bin = join(root, "host-bin"); mkdirSync(bin);
  writeFileSync(join(bin, "node"), "#!/bin/sh\nprintf compatible\n", { mode: 0o755 });
  try {
    process.env.PATH = bin;
    delete process.env.OCX_ZCODE_SANDBOX;
    expect(desktopStatus().issue).not.toBe("sandbox_missing");
    expect(desktopStatus().sandbox).toBe(false);
    process.env.OCX_ZCODE_SANDBOX = "1";
    expect(desktopStatus().issue).toBe("sandbox_missing");
    writeFileSync(join(bin, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(desktopStatus().issue).toBe("sandbox_unavailable");
    expect(desktopStatus().sandbox).toBe(true);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
  }
});

test("saved account routing and settings are explicit and never fall back to Desktop", async () => {
  const { allocateAccount, accountRoot, accountProfile } = await import("../../src/adapters/zcode/accounts");
  const { desktopRoutingModelIds } = await import("../../src/adapters/zcode/desktop");
  const { loadZcodeSettings } = await import("../../src/adapters/zcode/settings");
  const { knownModelIdsForProvider } = await import("../../src/router");
  const a = allocateAccount("Personal"), b = allocateAccount("Work");
  for (const [account, modelId] of [[a, "personal-model"], [b, "work-model"]] as const) {
    writeFileSync(join(accountRoot(account.id), "connection.json"), JSON.stringify({
      version: 1, connected: true, generation: crypto.randomUUID(), runtime: "/not-launched", workspace: root,
      models: [{ id: "builtin:zai/" + modelId, providerId: "builtin:zai", modelId, label: modelId }],
    }), { mode: 0o600 });
  }
  expect(desktopRoutingModelIds(a.id)).toEqual(["builtin:zai/personal-model"]);
  expect(desktopRoutingModelIds(b.id)).toEqual(["builtin:zai/work-model"]);
  expect(knownModelIdsForProvider("personal", { adapter: "zcode", baseUrl: "https://zcode.z.ai", zcodeAccountId: a.id }))
    .not.toContain("builtin:zai/work-model");
  expect(accountProfile(a.id)).not.toBe(accountProfile(b.id));
  expect(() => loadZcodeSettings(process.env, "../escape")).toThrow();
  expect(() => loadZcodeSettings(process.env, null as never)).toThrow();
  expect(() => loadZcodeSettings(process.env, crypto.randomUUID())).toThrow();
  await disconnectDesktop(a.id);
  expect(desktopRoutingModelIds(a.id)).toEqual([]);
  expect(desktopRoutingModelIds(b.id)).toEqual(["builtin:zai/work-model"]);
});
