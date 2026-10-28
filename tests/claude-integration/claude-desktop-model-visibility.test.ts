import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer as startServerImpl } from "../../src/server";
import {
  desktop3pAlias,
  desktop3pModelOptions,
  generateDesktop3pConfig,
  generateDesktop3pModels,
  removeDesktop3pStandardPivot,
  resolveDesktop3pAlias,
  writeDesktop3pConfig,
} from "../../src/claude/desktop-3p";
import { reconcileDesktopProfile, moveDesktopRoute } from "../../src/claude/desktop-profile";
import {
  desktopRouteVisible,
  filterDesktopModelsByVisibility,
  parseDesktopModelVisibility,
} from "../../src/claude/desktop-model-visibility";
import type { OcxConfig } from "../../src/types";
import { buildClaudeDesktopState } from "../../src/server/management/shared";
import * as desktopState from "../../src/server/management/shared";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { isolateClientLifecycleLock } from "../helpers/client-lifecycle-lock";

/*
 * #7702: a per-client Claude Desktop model selection. It narrows only the written Desktop
 * list; the alias registry, the tier profile and every other client stay as they were.
 */

setDefaultTimeout(30_000);

const ROUTED = [
  { provider: "google", id: "gemini-3-pro" },
  { provider: "deepseek", id: "deepseek-v4" },
  { provider: "xai", id: "grok-5" },
];

test("parse accepts include/exclude, sorts and dedupes routes, and rejects malformed input", () => {
  expect(parseDesktopModelVisibility({ mode: "include", routes: ["xai/grok-5", "google/gemini-3-pro", "xai/grok-5"] }))
    .toEqual({ mode: "include", routes: ["google/gemini-3-pro", "xai/grok-5"] });
  expect(() => parseDesktopModelVisibility({ mode: "all", routes: [] })).toThrow("mode");
  expect(() => parseDesktopModelVisibility({ mode: "include", routes: ["no-slash"] })).toThrow("provider/model");
  expect(() => parseDesktopModelVisibility({ mode: "include", routes: [], extra: 1 })).toThrow("unknown field");
  expect(() => parseDesktopModelVisibility(["google/gemini-3-pro"])).toThrow("object");
});

test("include hides newly discovered routes, exclude lists them", () => {
  expect(desktopRouteVisible(undefined, "new/model")).toBe(true);
  expect(desktopRouteVisible({ mode: "include", routes: ["google/gemini-3-pro"] }, "new/model")).toBe(false);
  expect(desktopRouteVisible({ mode: "exclude", routes: ["xai/grok-5"] }, "new/model")).toBe(true);
  expect(desktopRouteVisible({ mode: "exclude", routes: ["xai/grok-5"] }, "xai/grok-5")).toBe(false);
});

test("the written list drops hidden rows while the registry still decodes them", () => {
  const visibility = { mode: "exclude" as const, routes: ["google/gemini-3-pro"] };
  const models = generateDesktop3pModels([], ROUTED, undefined, undefined, { visibility });
  const hiddenAlias = desktop3pAlias("google", "gemini-3-pro");
  expect(models.map(model => model.name)).not.toContain(hiddenAlias);
  expect(models).toHaveLength(2);
  // A running Desktop session that still sends the hidden alias keeps routing.
  expect(resolveDesktop3pAlias(hiddenAlias)).toBe("google/gemini-3-pro");
  // The hidden row was the family default; exactly one remaining row takes the role.
  expect(models.filter(model => model.isFamilyDefault)).toHaveLength(1);
  expect(models[0]!.isFamilyDefault).toBe(true);
});

test("a hidden profile default hands the family role to a remaining member", () => {
  const profileModels = ROUTED.map(model => ({ route: `${model.provider}/${model.id}`, label: model.id }));
  let profile = reconcileDesktopProfile(undefined, profileModels);
  profile = moveDesktopRoute(profile, "deepseek/deepseek-v4", "sonnet", true);
  const all = generateDesktop3pModels([], ROUTED, profile);
  const hidden = generateDesktop3pModels([], ROUTED, profile, undefined, {
    visibility: { mode: "exclude", routes: [profile.defaults.opus!] },
  });
  expect(all).toHaveLength(3);
  expect(hidden).toHaveLength(2);
  for (const family of ["opus", "sonnet"] as const) {
    expect(hidden.filter(model => model.anthropicFamilyTier === family && model.isFamilyDefault)).toHaveLength(1);
  }
  // Defaults still lead the list, as renderDesktopProfile writes it.
  expect(hidden.slice(0, 2).every(model => model.isFamilyDefault)).toBe(true);
});

test("a selection that hides every model falls back to the full list instead of an empty picker", () => {
  const models = generateDesktop3pModels([], ROUTED, undefined, undefined, { visibility: { mode: "include", routes: ["gone/model"] } });
  expect(models).toHaveLength(3);
});

test("filter keeps the original list when nothing is hidden", () => {
  const rows = [{ anthropicFamilyTier: "opus", isFamilyDefault: true }, { anthropicFamilyTier: "opus" }];
  expect(filterDesktopModelsByVisibility(rows, ["a/x", "b/y"], { mode: "exclude", routes: [] })).toEqual(rows);
});

test("the generated config and model options carry the persisted selection; an unreadable one lists everything", () => {
  const options = desktop3pModelOptions({ desktopModelVisibility: { mode: "include", routes: ["xai/grok-5"] } });
  const config = generateDesktop3pConfig(10100, [], ROUTED, "ocx", "static", undefined, undefined, options) as { inferenceModels: Array<{ name: string }> };
  expect(config.inferenceModels.map(model => model.name)).toEqual([desktop3pAlias("xai", "grok-5")]);
  expect(desktop3pModelOptions({ desktopModelVisibility: { mode: "bogus" } }).visibility).toBeUndefined();
});

let testDir = "";
let previousHome: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let lifecycleLock: ReturnType<typeof isolateClientLifecycleLock> | null = null;

function startServer() {
  return startServerImpl(0, {
    managementApi: {
      writeDesktop3pConfig: (port, slugs, models, key, mode, profile, cap) =>
        writeDesktop3pConfig(port, slugs, models, key, mode, profile, cap, { lockPath: join(testDir, "lifecycle.sqlite") }),
      removeDesktop3pStandardPivot: options => removeDesktop3pStandardPivot({ ...options, lifecycleLockDeps: { lockPath: join(testDir, "lifecycle.sqlite") } }),
    },
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-desktop-visibility-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-desktop-visibility-"));
  lifecycleLock = isolateClientLifecycleLock(testDir);
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["keep-model", "hide-model"] },
    },
    claudeCode: { desktopNativeModels: false },
  } as OcxConfig);
});

afterEach(async () => {
  if (testDir) await removeTreeAfterBackgroundWork(testDir);
  lifecycleLock?.restore();
  lifecycleLock = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
});

test("an invalid hand-edited selection is dropped alone; providers survive", () => {
  const path = join(testDir, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  raw.claudeCode = { ...raw.claudeCode, desktopModelVisibility: { mode: "include", routes: "mock/keep-model" } };
  writeFileSync(path, JSON.stringify(raw));
  const loaded = loadConfig();
  expect(Object.keys(loaded.providers)).toContain("mock");
  expect(loaded.claudeCode?.desktopNativeModels).toBe(false);
  expect(loaded.claudeCode?.desktopModelVisibility).toBeUndefined();
});

test("dashboard save persists the selection, apply writes only selected rows, and status reports them", async () => {
  const server = startServer();
  const api = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);
  const put = (body: unknown) => api("/api/claude-desktop", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const initial = await api("/api/claude-desktop").then(r => r.json()) as Record<string, any>;
    expect(initial.visibility).toBeNull();
    expect(initial.listed.map((row: { route: string }) => row.route).sort()).toEqual(["mock/hide-model", "mock/keep-model"]);

    // Hiding everything is refused: Desktop would have nothing to pick.
    const refused = await put({ profile: initial.profile, visibility: { mode: "include", routes: [] } });
    expect(refused.status).toBe(400);
    expect(loadConfig().claudeCode?.desktopModelVisibility).toBeUndefined();

    const saved = await put({ profile: initial.profile, visibility: { mode: "include", routes: ["mock/keep-model"] } });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as Record<string, any>;
    expect(savedBody.visibility).toEqual({ mode: "include", routes: ["mock/keep-model"] });
    expect(savedBody.models.find((model: { route: string }) => model.route === "mock/hide-model").visible).toBe(false);
    expect(savedBody.listed.map((row: { route: string }) => row.route)).toEqual(["mock/keep-model"]);
    // Tier mapping is untouched: the hidden model keeps its assignment.
    expect(loadConfig().claudeCode?.desktopProfile?.assignments["mock/hide-model"]).toBeDefined();
    expect(loadConfig().claudeCode?.desktopModelVisibility).toEqual({ mode: "include", routes: ["mock/keep-model"] });

    // A later profile-only save keeps the selection.
    expect((await put({ profile: savedBody.profile })).status).toBe(200);
    expect(loadConfig().claudeCode?.desktopModelVisibility?.mode).toBe("include");

    const apply = await api("/api/claude-desktop/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "gateway" }) });
    expect(apply.status).toBe(200);
    const { path } = await apply.json() as { path: string };
    const written = JSON.parse(readFileSync(path, "utf8")) as { inferenceModels: Array<{ name: string }> };
    const keepName = savedBody.listed[0].name as string;
    expect(written.inferenceModels.map(model => model.name)).toEqual([keepName]);

    const status = await api("/api/claude-desktop/status").then(r => r.json()) as { appliedModels: Array<{ name: string; label: string }> | null };
    expect(status.appliedModels?.map(model => model.name)).toEqual([keepName]);

    // null clears the selection: every model is listed again.
    expect((await put({ profile: savedBody.profile, visibility: null })).status).toBe(200);
    expect(loadConfig().claudeCode?.desktopModelVisibility).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("the next-apply projection matches the writer when every selected model disappears", async () => {
  const config = loadConfig();
  const initial = await buildClaudeDesktopState(config);
  const profile = reconcileDesktopProfile(initial.profile, [{ route: "mock/gone", label: "Gone" }]);
  profile.defaults.opus = "mock/gone";
  config.claudeCode = {
    ...config.claudeCode,
    desktopProfile: profile,
    desktopModelVisibility: { mode: "include", routes: ["mock/gone"] },
  };
  const state = await buildClaudeDesktopState(config);
  const written = generateDesktop3pModels([], [
    { provider: "mock", id: "keep-model" }, { provider: "mock", id: "hide-model" },
  ], state.profile, undefined, desktop3pModelOptions(config.claudeCode));
  expect(state.models.find(model => model.route === "mock/gone")?.available).toBe(false);
  expect(state.visibility).toEqual({ mode: "include", routes: ["mock/gone"] });
  expect(state.profile.defaults.opus).toBe("mock/gone");
  expect(state.listed.map(model => model.name)).toEqual(written.map(model => model.name));
  expect(state.listed).toHaveLength(2);
});

test("a visibility change during discovery refuses a stale replacement", async () => {
  const server = startServer();
  const endpoint = new URL("/api/claude-desktop", server.url);
  const put = (body: unknown) => fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let discovery: ReturnType<typeof spyOn> | undefined;
  try {
    const initial = await fetch(endpoint).then(response => response.json()) as { profile: unknown };
    expect((await put({ profile: initial.profile })).status).toBe(200);
    const buildState = desktopState.buildClaudeDesktopState;
    let changed = false;
    discovery = spyOn(desktopState, "buildClaudeDesktopState").mockImplementation(async (...args) => {
      const result = await buildState(...args);
      if (!changed) {
        changed = true;
        const concurrent = loadConfig();
        concurrent.claudeCode = { ...concurrent.claudeCode, desktopModelVisibility: { mode: "include", routes: ["mock/keep-model"] } };
        saveConfig(concurrent);
      }
      return result;
    });
    const response = await put({ profile: initial.profile, visibility: { mode: "include", routes: ["mock/hide-model"] } });
    expect(changed).toBe(true);
    expect(response.status).toBe(409);
    expect(loadConfig().claudeCode?.desktopModelVisibility).toEqual({ mode: "include", routes: ["mock/keep-model"] });
  } finally {
    discovery?.mockRestore();
    await server.stop(true);
  }
});
