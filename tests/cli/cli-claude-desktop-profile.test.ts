import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { handleClaudeDesktopProfileCommand, type DesktopProfileCliDeps } from "../../src/cli/claude-desktop-profile";
import { handleClaudeDesktopCommand } from "../../src/cli/claude-desktop";
import { runtimeRequest } from "../../src/cli/runtime-api";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../../src/server/management/body";
import { handleAgentSettingsRoutes } from "../../src/server/management/agent-settings-routes";
import { loadConfig, saveConfig } from "../../src/config";
import * as profiles from "../../src/claude/desktop-profile";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let admin: string | undefined;
let nativeEnv: Array<[string, string | undefined]>;
beforeEach(() => {
  home = createTempHome("ocx-desktop-profile-cli-"); mkdirSync(home.codexHome, { recursive: true });
  nativeEnv = ["CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_CONFIG_DIR = home.path("claude"); process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = home.path("claude-desktop");
  admin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN; delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {}); errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network denied"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (admin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = admin;
  for (const [key, value] of nativeEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  home.remove();
});
const profile: profiles.DesktopProfile = { version: 1, assignments: { "fixture/model": { family: "opus", alias: "claude-opus-4-8-20260101" } },
  defaults: { opus: "fixture/model", fable: null, sonnet: null, haiku: null } };
function state() { return { profile: structuredClone(profile), port: 15801,
  models: [{ route: "fixture/model", label: "Fixture model", available: true, effortSupported: false, supports1m: false, assignment: { ...profile.assignments["fixture/model"]! } }],
  rendered: [{ route: "fixture/model", label: "Fixture model", name: "claude-opus-4-8-p000", family: "opus", isFamilyDefault: true, supports1m: false }] }; }
function fixture(reply: unknown = state()) {
  const calls: { path: string; init: RequestInit }[] = []; let discoveries = 0;
  const deps: DesktopProfileCliDeps = { findLiveProxy: async () => { discoveries++; return { pid: null, port: 15801, source: "runtime" }; },
    fetchImpl: async (input, init) => { expect(init?.redirect).toBe("error"); calls.push({ path: new URL(String(input)).pathname, init: init ?? {} });
      return reply instanceof Response ? reply : Response.json(reply); } };
  return { deps, calls, discoveries: () => discoveries };
}
const stdout = () => output.mock.calls.flat().join("\n");
const stderr = () => errors.mock.calls.flat().join("\n");
const json = () => JSON.parse(stdout());
function file(value: unknown = profile) { const path = home.path("profile.json"); writeFileSync(path, JSON.stringify(value)); return path; }
function handler(config: OcxConfig): DesktopProfileCliDeps {
  return { baseUrl: "http://127.0.0.1:15801", fetchImpl: async (input, init) => {
    const req = new Request(String(input), init); expect(new URL(req.url).pathname).toBe("/api/claude-desktop");
    const result = await handleAgentSettingsRoutes({ req, url: new URL(req.url), config, deps: {}, version: "fixture",
      trustedLoopbackIngress: true, guiSessionIssuance: null, syncClaudeAgentDefsBestEffort: async () => {},
      convergeCodexCatalog: async () => { throw new Error("Unexpected convergence"); } });
    if (!result) throw new Error("Missing handler"); return result;
  } };
}
function seededConfig() {
  const config: OcxConfig = { port: 15801, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["model"], liveModels: false } },
    claudeCode: { desktopNativeModels: false, desktopProfile: structuredClone(profile) } };
  saveConfig(config); return loadConfig();
}

describe("runtime Desktop profile command", () => {
  test("public Desktop dispatch preserves numeric failures and intercepts mode aliases before local apply", async () => {
    const f = fixture(Response.json({ error: "private-fixture" }, { status: 409 }));
    const request: typeof runtimeRequest = async <T>(path: string, init?: RequestInit, deps?: DesktopProfileCliDeps): Promise<T> => {
      expect(deps?.findLiveProxy).toBe(f.deps.findLiveProxy);
      return runtimeRequest<T>(path, init, f.deps);
    };
    const deps = { runtimeRequestImpl: request, findLiveProxyImpl: f.deps.findLiveProxy };
    expect(await handleClaudeDesktopCommand(["profile", "import", file(), "--json"], deps)).toBe(5);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.path).toBe("/api/claude-desktop");
    expect(await handleClaudeDesktopCommand(["profile", "import", file(), "--gateway"], deps)).toBe(2);
    expect(f.calls).toHaveLength(1); expect(existsSync(home.path("config.json"))).toBe(false); expect(stdout()).toBe("");
  });
  test("show uses only the selected GET and rebuilds public DTOs", async () => {
    const raw = { ...state(), secret: "private-fixture", models: state().models.map(row => ({ ...row, apiKey: "private-fixture", assignment: { ...row.assignment, token: "private-fixture" } })) };
    const f = fixture(raw);
    expect(await handleClaudeDesktopProfileCommand(["show", "--json"], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.path).toBe("/api/claude-desktop"); expect(f.calls[0]!.init.method).toBe("GET"); expect(f.calls[0]!.init.body).toBeUndefined();
    expect(json()).toEqual(state()); expect(stdout()).not.toContain("private-fixture");
  });
  test("file import sends only profile, no apply, and says saved", async () => {
    const f = fixture({ ok: true, ...state() });
    expect(await handleClaudeDesktopProfileCommand(["import", file()], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.path).toBe("/api/claude-desktop"); expect(f.calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ profile });
    expect(stdout()).toContain("saved"); expect(stdout()).toContain("not been applied"); expect(existsSync(home.path("config.json"))).toBe(false);
  });
  test("explicit stdin accepts a profile with a complete JSON save receipt", async () => {
    const f = fixture({ ok: true, ...state() });
    expect(await handleClaudeDesktopProfileCommand(["import", "-", "--json"], { ...f.deps, stdinImpl: Readable.from([Buffer.from(JSON.stringify(profile))]) })).toBe(0);
    expect(json()).toEqual({ ok: true, ...state() });
  });
  test.each([[], ["show", "extra"], ["import"], ["import", "missing", "--apply"], ["import", "--native-mode"], ["show", "--json", "--json"], ["apply"]].map(args => [args]))("invalid grammar has no discovery or file effect", async args => {
    const f = fixture(); expect(await handleClaudeDesktopProfileCommand(args, f.deps)).toBe(2);
    expect(f.discoveries()).toBe(0); expect(f.calls).toHaveLength(0); expect(stdout()).toBe("");
  });
  test.each([null, {}, { ...profile, secret: "private-fixture" }, { ...profile, defaults: {} }, { ...profile, assignments: { "private-fixture": {} } }])("invalid profile refuses before discovery without echo", async value => {
    const f = fixture(); expect(await handleClaudeDesktopProfileCommand(["import", file(value)], f.deps)).toBe(2);
    expect(f.discoveries()).toBe(0); expect(stderr()).not.toContain("private-fixture"); expect(stdout()).toBe("");
  });
  test("input failures, directory, oversized file and invalid UTF-8 never reach runtime", async () => {
    const f = fixture(); const oversized = home.path("large.json"); writeFileSync(oversized, " ".repeat(MANAGEMENT_JSON_BODY_MAX_BYTES + 1));
    const invalid = home.path("invalid.json"); writeFileSync(invalid, Buffer.from([255]));
    for (const path of [home.path("private-fixture"), home.root, oversized, invalid]) expect(await handleClaudeDesktopProfileCommand(["import", path], f.deps)).toBe(2);
    expect(f.discoveries()).toBe(0); expect(stderr()).not.toContain("private-fixture");
  });
  test("serialized profile envelope also stays under the management body cap", async () => {
    const value = { ...profile, appliedFingerprint: "x".repeat(MANAGEMENT_JSON_BODY_MAX_BYTES - Buffer.byteLength(JSON.stringify({ ...profile, appliedFingerprint: "" }))) };
    const f = fixture(); expect(Buffer.byteLength(JSON.stringify(value))).toBe(MANAGEMENT_JSON_BODY_MAX_BYTES);
    expect(await handleClaudeDesktopProfileCommand(["import", file(value)], f.deps)).toBe(2); expect(f.discoveries()).toBe(0);
  });
  test("oversized and malformed stdin cannot cause discovery", async () => {
    for (const bytes of [Buffer.alloc(MANAGEMENT_JSON_BODY_MAX_BYTES + 1, 32), Buffer.from("{private-fixture"), Buffer.alloc(0)]) {
      const f = fixture(); expect(await handleClaudeDesktopProfileCommand(["import", "-"], { ...f.deps, stdinImpl: Readable.from([bytes]) })).toBe(2);
      expect(f.discoveries()).toBe(0); expect(f.calls).toEqual([]); expect(stderr()).not.toContain("private-fixture");
    }
  });
  test.each([null, {}, { ...state(), port: 0 }, { ...state(), models: [] }, { ...state(), rendered: [] }, { ...state(), profile: {} },
    { ...state(), models: [{ ...state().models[0], available: "true" }] }, { ...state(), rendered: [{ ...state().rendered[0], family: "bad" }] }])("malformed state fails without stdout", async raw => {
    const f = fixture(raw); expect(await handleClaudeDesktopProfileCommand(["show", "--json"], f.deps)).toBe(1); expect(stdout()).toBe("");
  });
  test("save without explicit ok is unverified", async () => {
    const f = fixture(); expect(await handleClaudeDesktopProfileCommand(["import", file(), "--json"], f.deps)).toBe(1); expect(stdout()).toBe("");
  });
  test.each([[400, 1], [404, 4], [409, 5], [503, 1]])("management refusal has no local fallback or raw body", async (status, exit) => {
    const f = fixture(Response.json({ error: "private-fixture" }, { status }));
    expect(await handleClaudeDesktopProfileCommand(["import", file(), "--json"], f.deps)).toBe(exit);
    expect(existsSync(home.path("config.json"))).toBe(false); expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-fixture");
  });
  test("stopped and client-role runtimes fail without fallback", async () => {
    for (const live of [null, { pid: null, port: 15801, source: "runtime" as const, role: "client" as const }]) {
      expect(await handleClaudeDesktopProfileCommand(["show"], { findLiveProxy: async () => live })).toBe(1);
    }
    expect(stdout()).toBe(""); expect(stderr()).toContain("Hub");
  });
  test("runtimeRequestImpl seam receives exact save-only route and redirect policy", async () => {
    const calls: string[] = []; const request: typeof runtimeRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push(path); expect(init?.redirect).toBe("error"); return { ok: true, ...state() } as T;
    };
    expect(await handleClaudeDesktopProfileCommand(["import", file()], { runtimeRequestImpl: request })).toBe(0); expect(calls).toEqual(["/api/claude-desktop"]);
  });
  test("human data escapes terminal controls while JSON retains actual model identity", async () => {
    const raw = state(); const route = "fixture/model\u001b[31m";
    raw.profile.assignments = { [route]: profile.assignments["fixture/model"]! }; raw.profile.defaults.opus = route;
    raw.models[0]!.route = route; raw.rendered[0]!.route = route;
    const f = fixture(raw); expect(await handleClaudeDesktopProfileCommand(["show"], f.deps)).toBe(0); expect(stdout()).not.toContain("\u001b");
    output.mockClear(); expect(await handleClaudeDesktopProfileCommand(["show", "--json"], f.deps)).toBe(0); expect(json().profile.defaults.opus).toBe(route);
  });
  test("real management save/read roundtrip preserves trusted markers and never applies", async () => {
    const config = seededConfig(); config.claudeCode!.desktopProfile!.appliedFingerprint = "trusted-fingerprint"; saveConfig(config);
    const deps = handler(config); const forged = { ...profile, appliedFingerprint: "forged", appliedAt: "forged" };
    expect(await handleClaudeDesktopProfileCommand(["import", file(forged), "--json"], deps)).toBe(0);
    expect(loadConfig().claudeCode!.desktopProfile!.appliedFingerprint).toBe("trusted-fingerprint");
    const edited = profiles.moveDesktopRoute(profile, "fixture/model", "sonnet", true);
    output.mockClear(); expect(await handleClaudeDesktopProfileCommand(["import", file(edited), "--json"], deps)).toBe(0);
    expect(loadConfig().claudeCode!.desktopProfile!.defaults.sonnet).toBe("fixture/model"); expect(json().profile.appliedFingerprint).toBeUndefined();
    output.mockClear(); expect(await handleClaudeDesktopProfileCommand(["show", "--json"], deps)).toBe(0); expect(json().profile.defaults.sonnet).toBe("fixture/model");
    expect(existsSync(home.path("claude-desktop"))).toBe(false);
  });
  test("real handler rejects newly unavailable models without a local save fallback", async () => {
    const config = seededConfig(); const before = readFileSync(home.path("config.json"), "utf8");
    const unavailable = { ...profile, assignments: { "missing/model": profile.assignments["fixture/model"]! }, defaults: { ...profile.defaults, opus: "missing/model" } };
    expect(await handleClaudeDesktopProfileCommand(["import", file(unavailable), "--json"], handler(config))).toBe(1);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(before); expect(stdout()).toBe(""); expect(stderr()).not.toContain("missing/model");
  });
  test("real handler retains unavailable assignments but refuses moving them", async () => {
    const config = seededConfig();
    const retained: profiles.DesktopProfile = { version: 1,
      assignments: { ...profile.assignments, "missing/old-model": { family: "sonnet", alias: "claude-opus-4-8-20260102" } },
      defaults: { ...profile.defaults, sonnet: "missing/old-model" } };
    config.claudeCode!.desktopProfile = retained; saveConfig(config);
    const deps = handler(config);
    expect(await handleClaudeDesktopProfileCommand(["import", file(retained), "--json"], deps)).toBe(0);
    expect(json().models.find((row: { route: string }) => row.route === "missing/old-model").available).toBe(false);
    expect(json().rendered.map((row: { route: string }) => row.route)).toEqual(["fixture/model"]); output.mockClear();
    const before = readFileSync(home.path("config.json"), "utf8");
    expect(await handleClaudeDesktopProfileCommand(["import", file(profiles.moveDesktopRoute(retained, "missing/old-model", "haiku", true)), "--json"], deps)).toBe(1);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(before); expect(stdout()).toBe("");
  });
  test("real handler refuses concurrent desired-profile change", async () => {
    const config = seededConfig(); let builds = 0; const original = profiles.reconcileDesktopProfile;
    const newer = profiles.moveDesktopRoute(profile, "fixture/model", "haiku", true);
    const intercept = spyOn(profiles, "reconcileDesktopProfile").mockImplementation((stored, models) => {
      const result = original(stored, models);
      if (++builds === 2) { const concurrent = loadConfig(); concurrent.claudeCode!.desktopProfile = newer; saveConfig(concurrent); }
      return result;
    });
    try {
      expect(await handleClaudeDesktopProfileCommand(["import", file(profile), "--json"], handler(config))).toBe(5);
      expect(loadConfig().claudeCode!.desktopProfile!.defaults.haiku).toBe("fixture/model"); expect(stdout()).toBe("");
    } finally { intercept.mockRestore(); }
  });
});
