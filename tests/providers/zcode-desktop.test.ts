import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDesktopWorkspace, desktopStatus, disconnectDesktop, isDefaultDesktopWorkspace, loadDesktopSettings, resolveDesktopRuntime, validateDesktopWorkspace } from "../../src/adapters/zcode/desktop";
import { readZcodeModels } from "../../src/adapters/zcode/settings";
import { accountProfile, accountRoot, allocateAccount } from "../../src/adapters/zcode/accounts";
import { fetchProviderModels } from "../../src/codex/catalog/provider-fetch";
import { repoRoot } from "../helpers/repo-root";

import { parseNativeOAuthEvent, nativeOAuthCommand } from "../../src/adapters/zcode/native-oauth";
import { resolveDesktopNode } from "../../src/adapters/zcode/desktop-node";

const require = createRequire(import.meta.url);
const { normalizeDesktopConfig, desktopModelCatalog } = require("../../src/adapters/zcode/desktop-bootstrap.cjs");
const { forceHostBashInput } = require("../../src/adapters/zcode/desktop-host-tool-hook.cjs");
const { materializeSession, subjectHash } = require("../../src/adapters/zcode/oauth-bootstrap.cjs");
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
  test("filters invalid model entries before applying the public catalog cap", () => {
    const invalid = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`invalid ${i}`, {}]));
    const config = normalizeDesktopConfig({ provider: { "builtin:zai-coding-plan": {
      ...provider(), models: { ...invalid, valid: { name: "Valid" } },
    } } });
    expect(desktopModelCatalog(config).map((model: { modelId: string }) => model.modelId)).toContain("valid");
    expect(config.model).toEqual({ main: "builtin:zai-coding-plan/valid", lite: "builtin:zai-coding-plan/valid" });
  });
  test("managed host config deterministically disables only ZCode's Bash sandbox", () => {
    const input = { provider: { "builtin:zai-coding-plan": provider() } };
    const isolated = normalizeDesktopConfig(input);
    expect(isolated.hooks).toBeUndefined();

    const host = normalizeDesktopConfig(input, { hostExecution: true });
    expect(host.hooks.events.PreToolUse).toMatchObject([{
      matcher: "^Bash$", hooks: [{ type: "process", timeoutMs: 2_000 }],
    }]);
    const hook = host.hooks.events.PreToolUse[0].hooks[0];
    expect(hook.command).toBe(process.execPath);
    expect(hook.args).toEqual([require.resolve("../../src/adapters/zcode/desktop-host-tool-hook.cjs")]);
    const original = {
      command: "cat /outside/workspace", description: "read fixture",
      dangerouslyDisableSandbox: false,
    };
    expect(forceHostBashInput({
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: original,
    })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: {
      ...original, dangerouslyDisableSandbox: true,
    } } });
    expect(original.dangerouslyDisableSandbox).toBeFalse();
    expect(() => forceHostBashInput({
      hook_event_name: "PreToolUse", tool_name: "Read", tool_input: original,
    })).toThrow("invalid hook input");
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
  test("sandbox checks canonical config paths while allowing only its canonical managed workspace", () => {
    if (process.platform === "win32") return;
    const realConfig = join(root, "real-config");
    const linkedConfig = join(root, "linked-config");
    mkdirSync(join(realConfig, "zcode-desktop"), { recursive: true });
    symlinkSync(realConfig, linkedConfig);
    process.env.OPENCODEX_HOME = linkedConfig;
    expect(() => validateDesktopWorkspace(linkedConfig)).toThrow("workspace_invalid");
    expect(() => validateDesktopWorkspace(realConfig)).toThrow("workspace_invalid");
    const protectedChild = join(realConfig, "zcode-desktop", "private");
    mkdirSync(protectedChild);
    expect(() => validateDesktopWorkspace(protectedChild)).toThrow("workspace_invalid");
    const managed = join(linkedConfig, "zcode-desktop", "workspace");
    expect(validateDesktopWorkspace(managed)).toBe(join(realConfig, "zcode-desktop", "workspace"));
    expect(isDefaultDesktopWorkspace(managed)).toBe(true);
    expect(isDefaultDesktopWorkspace(join(realConfig, "zcode-desktop", "workspace"))).toBe(true);
    expect(isDefaultDesktopWorkspace(join(realConfig, "zcode-desktop", "other"))).toBe(false);
    expect(defaultDesktopWorkspace()).toBe(managed);
  });
  test("sandbox allows only the matching account-managed workspace below the config root", async () => {
    const { allocateAccount } = await import("../../src/adapters/zcode/accounts");
    const account = allocateAccount("Personal");
    const managed = join(process.env.OPENCODEX_HOME!, "zcode-accounts", account.id, "workspace");
    expect(validateDesktopWorkspace(managed, account.id)).toBe(managed);
    expect(() => validateDesktopWorkspace(managed)).toThrow("workspace_invalid");
    const other = allocateAccount("Work");
    expect(() => validateDesktopWorkspace(managed, other.id)).toThrow("workspace_invalid");
  });
  test("disconnect persists revocation instead of falling back to operator env", async () => {
    expect(loadDesktopSettings()).toBeUndefined();
    await disconnectDesktop();
    const path = join(process.env.OPENCODEX_HOME!, "zcode-desktop/connection.json");
    expect(JSON.parse(readFileSync(path, "utf8")).connected).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => loadDesktopSettings()).toThrow("disconnected");
  });
  test("status retains configured state when prerequisites make the connection unusable", () => {
    const directory = join(process.env.OPENCODEX_HOME!, "zcode-desktop");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "connection.json"), JSON.stringify({
      version: 1, connected: true, generation: crypto.randomUUID(), runtime: "/missing/runtime",
      workspace: root, models: [],
    }), { mode: 0o600 });
    expect(desktopStatus()).toMatchObject({ configured: true, connected: false });
    expect(desktopStatus().issue).toBeDefined();
  });
  test("managed model discovery reads only the public cache, not Desktop credentials", () => {
    const result = readZcodeModels({ command: [], home: root, workspace: "/workspace", settingsPath: "/does/not/exist",
      scope: "desktop:test", desktopModels: [{ id: "builtin:zai/model", providerId: "builtin:zai", modelId: "model", label: "Model" }] });
    expect(result[0]?.id).toBe("builtin:zai/model");
    expect(result[0]?.runtimeModel).toEqual({});
  });
  test("managed discovery preserves a configured account model display name", async () => {
    process.env.OCX_ZCODE_SANDBOX = "0";
    const account = allocateAccount("Personal");
    const profile = join(accountProfile(account.id), ".zcode/v2");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "config.json"), "{}", { mode: 0o600 });
    const resources = join(root, "catalog-app/resources");
    mkdirSync(join(resources, "glm"), { recursive: true });
    writeFileSync(join(resources, "app.asar"), "fixture");
    const runtime = join(resources, "glm/zcode.cjs");
    writeFileSync(runtime, "");
    const workspace = defaultDesktopWorkspace(account.id);
    mkdirSync(workspace, { recursive: true });
    const model = { id: "builtin:zai-coding-plan/GLM-5.3", providerId: "builtin:zai-coding-plan",
      modelId: "GLM-5.3", label: "Z.AI / GLM-5.3" };
    writeFileSync(join(accountRoot(account.id), "connection.json"), JSON.stringify({
      version: 1, connected: true, generation: crypto.randomUUID(), runtime, workspace, models: [model],
    }), { mode: 0o600 });
    const discovered = await fetchProviderModels("zcode-personal", {
      adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai", zcodeAccountId: account.id,
      modelDisplayNames: { [model.id]: "Personal / Custom GLM" },
    }, 0);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.displayName).toBe("Personal / Custom GLM");
  });
});

test("Node selection skips an incompatible nvm prefix and fails safely", () => {
  if (process.platform === "win32") return;
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

test("refresh validates restored identity before model-provider profile mutation", async () => {
  const profile = join(root, "refresh-profile"); mkdirSync(profile, { mode: 0o700 });
  const sentinel = join(profile, "sentinel"); writeFileSync(sentinel, "unchanged");
  const result = { kind: "session", provider: "zai", userInfo: { id: "different-user" } };
  const calls: string[] = [];
  const models = { call: async (method: string) => { calls.push(method); writeFileSync(sentinel, "mutated"); } };
  await expect(materializeSession(result, models, "a".repeat(64))).rejects.toThrow("account_identity_mismatch");
  expect(calls).toEqual([]);
  expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
  expect(subjectHash(result)).toMatch(/^[a-f0-9]{64}$/);
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
  if (process.platform !== "linux") return; // Managed Desktop prerequisites currently support Linux only.
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
    const os=require("node:os");
    const path=require("node:path");
    const {spawnSync}=require("node:child_process");
    require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
      const r=JSON.parse(line);
      const external=${JSON.stringify(external)};
      const value=fs.readFileSync(external,"utf8");
      fs.writeFileSync(external,value);
      const runtimeHome=os.homedir();
      const settings=JSON.parse(fs.readFileSync(path.join(runtimeHome,".zcode/cli/config.json"),"utf8"));
      const nativeHome=spawnSync(process.execPath,["-e","process.stdout.write(require('node:os').homedir())"],
        {encoding:"utf8",env:process.env}).stdout;
      process.stdout.write(JSON.stringify({id:r.id,result:{read:value,written:true,cwd:process.cwd(),
        hostHome:process.env.HOME,runtimeHome,nativeHome,dataBase:process.env.ZCODE_DATA_BASE_DIR,
        runtimeMarker:Object.hasOwn(process.env,"OCX_ZCODE_RUNTIME_HOME"),args:process.argv.slice(2),
        providerIds:Object.keys(settings.provider),mainModel:settings.model.main,
        storageDir:settings.storage.dir}})+"\\n");
    });
  `);
  const settings = { command: [resolveDesktopNode(), fileURLToPath(new URL("../../src/adapters/zcode/desktop-bootstrap.cjs", import.meta.url)),
    "--host", runtime, config, workspace, home], home, workspace, settingsPath: "", scope: "desktop:test-host",
    hostExecution: true, nativePermissionMode: "yolo" as const };
  // Repeated processes must not fail on an existing config, or overwrite Desktop's file.
  for (let i = 0; i < 2; i++) {
    const client = new ZcodeClient(settings);
    try {
      const models = await client.request("opencodex/desktopModels", {}, 3000);
      expect(models.models).toHaveLength(1);
      const state = await client.request("workspace/readState", {}, 3000);
      const runtimeArgs = state.args as string[];
      expect(state).toMatchObject({ read: "report fixture", written: true, cwd: workspace,
        hostHome: homedir(), nativeHome: homedir(), dataBase: home, runtimeMarker: false,
        providerIds: ["builtin:zai-coding-plan"], mainModel: "builtin:zai-coding-plan/model",
        storageDir: join(home, ".zcode") });
      expect(runtimeArgs).toEqual(["app-server"]);
      expect(state.runtimeHome).toStartWith(join(home, "turn-"));
      expect(state.runtimeHome).not.toBe(homedir());
    } finally { await client.close(); }
  }
  expect(readdirSync(home).filter(name => name.startsWith("turn-"))).toEqual([]);
  expect(readFileSync(config, "utf8")).toBe(original);
});

test("host cancellation terminates the official runtime tree and cleans its turn home", async () => {
  if (process.platform !== "linux") return; // Managed Desktop prerequisites currently support Linux only.
  const { ZcodeClient } = await import("../../src/adapters/zcode/client");
  const { fileURLToPath } = await import("node:url");
  const home = join(root, "cancel-state"), workspace = join(root, "cancel-project");
  mkdirSync(join(home, ".zcode/cli/db"), { recursive: true });
  mkdirSync(workspace);
  const config = join(root, "cancel-desktop-config.json");
  writeFileSync(config, JSON.stringify({ provider: { "builtin:zai-coding-plan": provider() } }));
  const runtime = join(root, "uncooperative-runtime-fixture.cjs");
  writeFileSync(runtime, `
    const {spawn}=require("node:child_process");
    process.on("SIGTERM",()=>{});
    const tool=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
    require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
      const request=JSON.parse(line);
      process.stdout.write(JSON.stringify({id:request.id,result:{runtimePid:process.pid,toolPid:tool.pid}})+"\\n");
    });
    setInterval(()=>{},1000);
  `);
  const settings = { command: [resolveDesktopNode(), fileURLToPath(new URL("../../src/adapters/zcode/desktop-bootstrap.cjs", import.meta.url)),
    "--host", runtime, config, workspace, home], home, workspace, settingsPath: "", scope: "desktop:test-cancel",
    hostExecution: true, nativePermissionMode: "yolo" as const };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let runtimePid = 0, toolPid = 0;
  const client = new ZcodeClient(settings);
  try {
    const state = await client.request("workspace/readState", {}, 3000);
    runtimePid = state.runtimePid as number; toolPid = state.toolPid as number;
    expect(alive(runtimePid)).toBe(true); expect(alive(toolPid)).toBe(true);
    await client.close();
    await Bun.sleep(100);
    expect(alive(runtimePid)).toBe(false);
    expect(alive(toolPid)).toBe(false);
    expect(readdirSync(home).filter(name => name.startsWith("turn-"))).toEqual([]);
  } finally {
    await client.close();
    for (const pid of [runtimePid, toolPid]) if (pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
  }
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

test("Desktop connection generations share a stable physical-profile lock", () => {
  if (process.platform !== "linux") return;
  const oldPath = process.env.PATH;
  const oldSandbox = process.env.OCX_ZCODE_SANDBOX;
  process.env.PATH = "/usr/bin:/bin";
  process.env.OCX_ZCODE_SANDBOX = "0";
  try {
    const account = allocateAccount("Lock fixture");
    const profile = join(accountProfile(account.id), ".zcode/v2");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "config.json"), "{}", { mode: 0o600 });
    const resources = join(root, "lock-app/resources");
    mkdirSync(join(resources, "glm"), { recursive: true });
    writeFileSync(join(resources, "app.asar"), "fixture");
    const runtime = join(resources, "glm/zcode.cjs");
    writeFileSync(runtime, "");
    const workspace = join(root, "lock-workspace");
    mkdirSync(workspace);
    const connectionPath = join(accountRoot(account.id), "connection.json");
    const connection = { version: 1, connected: true, generation: crypto.randomUUID(), runtime, workspace,
      models: [{ id: "builtin:zai/model", providerId: "builtin:zai", modelId: "model", label: "Model" }] };
    writeFileSync(connectionPath, JSON.stringify(connection), { mode: 0o600 });
    const before = loadDesktopSettings(account.id)!;
    writeFileSync(connectionPath, JSON.stringify({ ...connection, generation: crypto.randomUUID() }), { mode: 0o600 });
    const after = loadDesktopSettings(account.id)!;
    expect(after.lockKey).toBe(before.lockKey);
    expect(after.scope).not.toBe(before.scope);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldSandbox === undefined) delete process.env.OCX_ZCODE_SANDBOX; else process.env.OCX_ZCODE_SANDBOX = oldSandbox;
  }
});

test("ZCode catalog advertises sidecar-backed attachments for legacy and account providers", async () => {
  const {applyProviderConfigHints} = await import("../../src/codex/catalog/provider-fetch");
  for(const name of ["zcode","work-account"]) {
    const result = applyProviderConfigHints(name,{adapter:"zcode",authMode:"local",baseUrl:"https://zcode.z.ai"},{provider:name,id:"builtin:zai-coding-plan/GLM-5.3-Flash",inputModalities:["text"]});
    expect(result.inputModalities).toContain("image");
  }
});

test("ZCode GLM-5.3 catalog exposes only real levels plus Codex ultra", async () => {
  const runtimeRoot = join(root, "app"), runtime = join(runtimeRoot, "resources/glm/zcode.cjs");
  mkdirSync(join(runtimeRoot, "resources/glm"), { recursive: true });
  writeFileSync(join(runtimeRoot, "resources/app.asar"), "fixture"); writeFileSync(runtime, "");
  const opencodexHome = join(root, "proxy");
  const desktopHome = join(root, "desktop-home");
  mkdirSync(join(desktopHome, ".zcode/v2"), { recursive: true });
  writeFileSync(join(desktopHome, ".zcode/v2/config.json"), "{}");
  const workspace = join(root, "workspace"), connectionDir = join(opencodexHome, "zcode-desktop");
  mkdirSync(workspace); mkdirSync(connectionDir, { recursive: true });
  const ids = ["builtin:zai-coding-plan/GLM-5.3", "builtin:zai-coding-plan/GLM-5.3-Flash"];
  writeFileSync(join(connectionDir, "connection.json"), JSON.stringify({
    version: 1, connected: true, generation: crypto.randomUUID(), runtime, workspace,
    models: ids.map(id => ({ id, providerId: "builtin:zai-coding-plan", modelId: id.split("/")[1], label: id })),
  }), { mode: 0o600 });
  const providerName = `zcode-fixture-${crypto.randomUUID()}`;
  // Catalog discovery reads process-global managed Desktop state. Keep this assertion in a child
  // so unrelated parallel files that exercise a different OPENCODEX_HOME cannot replace its input.
  const script = `
    const { gatherRoutedModels } = await import("./src/codex/catalog/provider-fetch.ts");
    const providerName = ${JSON.stringify(providerName)};
    const models = await gatherRoutedModels({ port: 0, defaultProvider: providerName, providers: {
      [providerName]: { adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai",
        liveModels: true, contextWindow: 8192 },
    } });
    console.log(JSON.stringify(models));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      HOME: desktopHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_ZCODE_SANDBOX: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const models = JSON.parse(child.stdout.toString()) as Array<{
    provider: string;
    id: string;
    contextWindow?: number;
    inputModalities?: string[];
    reasoningEfforts?: string[];
  }>;
  const { buildCatalogEntries } = await import("../../src/codex/catalog/sync");
  for (const modelId of ids) {
    const model = models.find(row => row.provider === providerName && row.id === modelId);
    expect(model?.contextWindow, JSON.stringify(models)).toBe(8192);
    expect(model?.inputModalities).toContain("image");
    expect(model?.reasoningEfforts).toEqual(["low", "high", "max"]);
    const [entry] = buildCatalogEntries(null, [], [model!]);
    const efforts = (entry?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort);
    expect(efforts).toEqual(["low", "high", "max", "ultra"]);
    expect(efforts).not.toContain("medium");
    expect(efforts).not.toContain("xhigh");
    expect(entry?.default_reasoning_level).toBe("max");
  }
});
