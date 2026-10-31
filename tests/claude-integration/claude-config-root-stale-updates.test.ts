import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as paths from "../../src/config/paths";
import { handleAgentSettingsRoutes } from "../../src/server/management/agent-settings-routes";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import { readConfigForAdmittedMutation } from "../../src/config/persisted-mutation";
import { persistDesktopProfileField } from "../../src/server/management/claude-desktop-config-writers";
import { persistCommittedDesktopGateway } from "../../src/claude/desktop-gateway-state";
import { emptyDesktopProfile, reconcileDesktopProfile } from "../../src/claude/desktop-profile";
import type { ManagementContext } from "../../src/server/management/context";
import { resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, windowsSecretAclReapPendingForPath, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const turn = () => new Promise<void>(done => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const keys = ["OPENCODEX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
let root: string;
let previous: (string | undefined)[];
let restores: Array<() => void>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-config-writer-barrier-"));
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, "config.toml"), "");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  restores = [];
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001");
  setIcaclsRunnerForTests(() => success);
});

test.each([
  ["/api/sidecar-settings", { webSearchSidecar: { enabled: true } }, { webSearch: { enabled: false } }, { webSearch: { streamRoutedModelOutput: true } }, "webSearchSidecar", { enabled: false, streamRoutedModelOutput: true }],
  ["/api/settings", { codexMainAccountHardLockThresholds: { short: 80, long: 90 } }, { codexMainAccountHardLockThresholds: { long: 100 } }, { codexMainAccountHardLockThresholds: { short: 85 } }, "codexMainAccountHardLockThresholds", { short: 85, long: 100 }],
  ["/api/effort-caps", { modelPinnedEfforts: { a: "high" } }, { modelPinnedEfforts: { a: null } }, { modelPinnedEfforts: { b: "low" } }, "modelPinnedEfforts", { b: "low" }],
  ["/api/claude-code", { claudeCode: { enabled: true } }, { enabled: false }, { injectAgents: false }, "claudeCode", { enabled: false, injectAgents: false }],
  ["/api/injection-model", { injectionModel: "mock/test-model", injectionEffort: "high", syncCodexSubagentDefaults: true }, { model: null }, { prompt: "updated" }, "injectionModel", undefined],
] as const)("admitted partial edits merge the latest state: %s", async (path, initial, firstBody, secondBody, key, expected) => {
  const config = Object.assign(fixture(), structuredClone(initial));
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const parent = holdParent(); await parent.entered;
  const handle = path === "/api/sidecar-settings" || path === "/api/settings" ? handleConfigRoutes : handleAgentSettingsRoutes;
  const first = handle(context(config, path, firstBody));
  await parent.atAdmission(1);
  const second = handle(context(config, path, secondBody));
  await parent.atAdmission(2);
  parent.release();
  const replies = await Promise.all([first, second]);
  expect(replies.map(r => r?.status)).toEqual([200, 200]);
  const disk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  if (expected && typeof expected === "object") {
    expect(config[key]).toMatchObject(expected);
    expect(disk[key]).toMatchObject(expected);
  } else {
    expect(config[key]).toBeUndefined(); expect(disk[key]).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined(); expect(config.syncCodexSubagentDefaults).toBeUndefined();
  }
});

test("threshold cross-field validation uses the admitted state", async () => {
  const config = Object.assign(fixture(), { codexMainAccountHardLockThresholds: { short: 80, long: 100 } });
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const parent = holdParent(); await parent.entered;
  const first = handleConfigRoutes(context(config, "/api/settings", { codexMainAccountHardLockThresholds: { short: 95 } }));
  await parent.atAdmission(1);
  const second = handleConfigRoutes(context(config, "/api/settings", { codexMainAccountHardLockThresholds: { long: 90 } }));
  await parent.atAdmission(2); parent.release();
  expect((await Promise.all([first, second])).map(r => r?.status)).toEqual([200, 400]);
  expect(config.codexMainAccountHardLockThresholds).toEqual({ short: 95, long: 100 });
});

test("async sidecar evidence refuses changed configuration before publication", async () => {
  const config = fixture();
  config.visionSidecar = { model: "custom-vision" };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const parent = holdParent(); await parent.entered;
  const work = handleConfigRoutes(context(config, "/api/sidecar-settings", { vision: { model: "another-custom-vision" } }));
  await parent.atAdmission(1);
  config.visionSidecar = { backend: "routed", model: "mock/test-model" };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const before = readFileSync(join(root, "config.json"), "utf8");
  parent.release();
  const response = await work;
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ code: "config_changed" });
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe(before);
});

test("profile discovery and committed markers cannot overwrite a newer desired profile", async () => {
  const config = fixture(), profile = emptyDesktopProfile();
  config.claudeCode!.desktopProfile = profile;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const parent = holdParent(); await parent.entered;
  const work = persistDesktopProfileField(config, profile, structuredClone(profile));
  await parent.atAdmission(1);
  const newer = reconcileDesktopProfile(profile, [{ route: "mock/test-model", label: "Fixture" }]);
  config.claudeCode!.desktopProfile = newer;
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  parent.release();
  expect(await work).toEqual({ ok: false, reason: "conflict" });
  expect(persistCommittedDesktopGateway(config, profile, "stale-fingerprint")).toEqual({ ok: false, reason: "conflict" });
  expect(config.claudeCode!.desktopProfile).toEqual(newer);
  expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).claudeCode.desktopProfile).toEqual(newer);
});

test("admitted authority reads do not start a new optional hardening child", async () => {
  writeFileSync(join(root, "config.json"), JSON.stringify(fixture()));
  let starts = 0;
  setAsyncIcaclsRunnerForTests(async () => { starts++; return success; });
  await paths.withConfigDirHardeningSettled(root, () => expect(readConfigForAdmittedMutation().port).toBe(10100));
  await turn();
  expect(starts).toBe(0);
});

test("sidecar apply decisions use the before and after values from each admitted phase", async () => {
  const config = fixture();
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  let convergences = 0;
  const request = () => {
    const ctx = context(config, "/api/sidecar-settings", { vision: { enabled: false } });
    ctx.convergeCodexCatalog = async () => { convergences++; return {} as never; };
    return handleConfigRoutes(ctx);
  };
  const parent = holdParent(); await parent.entered;
  const first = request(); await parent.atAdmission(1);
  const second = request(); await parent.atAdmission(2);
  parent.release();
  expect((await Promise.all([first, second])).map(r => r?.status)).toEqual([200, 200]);
  expect(convergences).toBe(1);
});

test("a config-only mode reset still works without a Codex home", async () => {
  const config = fixture(); config.multiAgentMode = "v1";
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  process.env.CODEX_HOME = join(root, "absent-codex");
  const response = await handleAgentSettingsRoutes(context(config, "/api/v2", { multiAgentMode: "default" }));
  expect(response?.status).toBe(200);
  expect(config.multiAgentMode).toBeUndefined();
});
afterEach(async () => {
  await paths.flushConfigDirHardeningAndReaps(root);
  for (const restore of restores.reverse()) restore();
  setAsyncIcaclsRunnerForTests(null);
  setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null);
  setIcaclsRunnerForTests(null);
  setPlatformForTests(null);
  setSyntheticWindowsPrincipalForTests(null);
  resetHardenedStateForTests();
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  removeTreeWithRetry(root);
});

function holdParent(writerRoot = root, observe = true) {
  const entered = deferred(), release = deferred(), reached = deferred();
  let held = true;
  const descendants: string[] = [];
  let arrivals = 0;
  const waiting = new Map<number, ReturnType<typeof deferred>>();
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(writerRoot + sep)) { descendants.push(args[0]); reached.resolve(); }
    return success;
  });
  const barrier = paths.withConfigDirHardeningSettled;
  if (observe) {
    const entry = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
      const work = barrier(dir, mutate); reached.resolve();
      waiting.get(++arrivals)?.resolve();
      return work;
    });
    restores.push(() => entry.mockRestore());
  }
  paths.hardenConfigDir();
  return { entered: entered.promise, reached: reached.promise, descendants,
    atAdmission(count: number) {
      if (arrivals >= count) return Promise.resolve();
      const signal = deferred(); waiting.set(count, signal); return signal.promise;
    }, release: () => { held = false; release.resolve(); } };
}
const fixture = () => ({ port: 10100, providers: {
  mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only", allowPrivateNetwork: true, models: ["test-model"] },
}, defaultProvider: "mock",
  claudeCode: { desktopMode: "gateway", cliFirstParty: true } }) as OcxConfig;

function context(config: OcxConfig, path: string, body: unknown, method = "PUT"): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return { config, url, req: new Request(url, { method, headers: { Host: url.host, "content-type": "application/json" }, body: JSON.stringify(body) }),
    deps: {}, convergeCodexCatalog: async () => ({}), syncClaudeAgentDefsBestEffort: async () => {},
  } as unknown as ManagementContext;
}

test("L5 concurrent sidecar partial edits preserve a committed disable", async () => {
  const config = fixture();
  config.visionSidecar = { maxDescriptionsPerTurn: 1 };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const parent = holdParent(); await parent.entered;
  const first = handleConfigRoutes(context(config, "/api/sidecar-settings", { vision: { enabled: false } }));
  await parent.atAdmission(1);
  const second = handleConfigRoutes(context(config, "/api/sidecar-settings", { vision: { maxDescriptionsPerTurn: 2 } }));
  await parent.atAdmission(2);
  parent.release();
  const replies = await Promise.all([first, second]);
  const disk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  expect(replies.map(r => r?.status)).toEqual([200, 200]);
  expect(config.visionSidecar).toMatchObject({ enabled: false, maxDescriptionsPerTurn: 2 });
  expect(disk.visionSidecar).toMatchObject({ enabled: false, maxDescriptionsPerTurn: 2 });
});

test.each([
  ["/api/injection-model", { multiAgentGuidanceEnabled: true, injectionPrompt: "initial" }, { multiAgentGuidanceEnabled: false }, { prompt: "updated" }, "multiAgentGuidanceEnabled", false],
  ["/api/subagent-model-fallback", { subagentModelFallback: ["mock/test-model"], subagentModelFallbackPollMs: 60000 }, { models: [] }, { pollMs: 5000 }, "subagentModelFallback", undefined],
] as const)("L5 concurrent agent partial edits preserve a committed disable: %s", async (path, initial, firstBody, secondBody, key, expected) => {
  const config = Object.assign(fixture(), structuredClone(initial));
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const parent = holdParent(); await parent.entered;
  const first = handleAgentSettingsRoutes(context(config, path, firstBody));
  await parent.atAdmission(1);
  const second = handleAgentSettingsRoutes(context(config, path, secondBody));
  await parent.atAdmission(2);
  parent.release();
  const replies = await Promise.all([first, second]);
  const disk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  expect(replies.map(r => r?.status)).toEqual([200, 200]);
  expect(config[key]).toEqual(expected);
  expect(disk[key]).toEqual(expected);
});
