import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { handleAgentCommand } from "../../src/cli/agent";
import { handleAgentSettingsRoutes } from "../../src/server/management/agent-settings-routes";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { OcxConfig } from "../../src/types";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let token: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-agent-parity-"); token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  mkdirSync(home.codexHome, { recursive: true });
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {}); errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
type Call = { path: string; method: string; body: Record<string, any> | null };
function fixture(reply: (call: Call) => unknown) {
  const calls: Call[] = []; let resolutions = 0;
  const deps: RuntimeApiDeps = { findLiveProxy: async () => ({ pid: null, port: 15600 + ++resolutions, source: "runtime" }),
    fetchImpl: async (input, init) => {
      expect(new URL(String(input)).port).toBe("15601"); expect(init?.redirect).toBe("error");
      const call = { path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call); const value = reply(call); return value instanceof Response ? value : Response.json(value);
    } };
  return { calls, deps, resolutions: () => resolutions };
}
const apply = { applied: false, reason: "not_requested", retryable: false };
const web = { enabled: true, model: "public-model", backend: "openai", streamRoutedModelOutput: false };
const vision = { enabled: true, model: "public-vision", backend: "routed", reasoning: "low", maxDescriptionsPerTurn: 2, timeoutMs: 45000 };
const json = () => JSON.parse(output.mock.calls.flat().join("\n"));

describe("injection defaults and sidecar parity fields", () => {
  test.each([true, false])("guidance alias supports the same explicit default-sync value", async enabled => {
    const f = fixture(() => ({ ok: true, model: "fixture/model", effort: "high", prompt: null,
      multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: enabled }));
    expect(await handleAgentCommand(["guidance", "set", "--sync-codex-defaults", enabled ? "on" : "off", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: "/api/injection-model", method: "PUT", body: { syncCodexSubagentDefaults: enabled } }]);
    expect(json().syncCodexSubagentDefaults).toBe(enabled);
  });
  test("malformed guidance alias input cannot reach the legacy or live writer", async () => {
    const f = fixture(() => ({}));
    expect(await handleAgentCommand(["guidance", "set", "--sync-codex-defaults", "fixture-private-value", "--json"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
  });
  test.each([true, false])("default-sync sends only explicit fields and uses actual normalized response", async enabled => {
    const f = fixture(() => ({ ok: true, model: "fixture/model", effort: "high", prompt: null,
      multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: enabled, token: "fixture-private-value" }));
    expect(await handleAgentCommand(["injection", "set", "--sync-codex-defaults", enabled ? "on" : "off", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: "/api/injection-model", method: "PUT", body: { syncCodexSubagentDefaults: enabled } }]);
    expect(json()).toEqual({ ok: true, model: "fixture/model", effort: "high", prompt: null,
      multiAgentGuidanceEnabled: true, syncCodexSubagentDefaults: enabled });
  });
  test("actual injection handler keeps model/effort while toggling default sync", async () => {
    const config: OcxConfig = { port: 15600, defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["model"] } },
      injectionModel: "fixture/model", injectionEffort: "high", injectionPrompt: "kept", multiAgentGuidanceEnabled: true };
    const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:15600", fetchImpl: async (input, init) => {
      const req = new Request(String(input), init);
      const res = await handleAgentSettingsRoutes({ req, url: new URL(req.url), config, deps: {}, version: "fixture",
        trustedLoopbackIngress: true, guiSessionIssuance: null, convergeCodexCatalog: async () => { throw new Error("No catalog request expected"); },
        syncClaudeAgentDefsBestEffort: async () => {}, });
      if (!res) throw new Error("Missing handler"); return res;
    } };
    expect(await handleAgentCommand(["injection", "set", "--sync-codex-defaults", "on", "--json"], deps)).toBe(0);
    expect(config).toMatchObject({ syncCodexSubagentDefaults: true, injectionModel: "fixture/model", injectionEffort: "high", injectionPrompt: "kept" });
    output.mockClear();
    expect(await handleAgentCommand(["injection", "set", "--sync-codex-defaults", "off", "--json"], deps)).toBe(0);
    expect(config).not.toHaveProperty("syncCodexSubagentDefaults");
    expect(JSON.parse(readFileSync(home.path("config.json"), "utf8"))).toMatchObject({ injectionModel: "fixture/model", injectionEffort: "high", injectionPrompt: "kept" });
  });
  test.each([true, false])("web stream-only edits do not reset siblings", async enabled => {
    const f = fixture(() => ({ ok: true, webSearch: { ...web, streamRoutedModelOutput: enabled, exaApiKey: "fixture-private-value" }, codexWebSearch: apply }));
    expect(await handleAgentCommand(["sidecar", "web", "--stream-routed-output", enabled ? "on" : "off", "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ webSearch: { streamRoutedModelOutput: enabled } });
    expect(json().webSearch).toEqual({ ...web, streamRoutedModelOutput: enabled });
    expect(output.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
  });
  test("new web option retains existing candidate normalization and reasoning input", async () => {
    const f = fixture(call => call.method === "GET" ? { webSearchModels: [{ value: "choice", model: "wire-model", backend: "anthropic" }] }
      : { ok: true, webSearch: { ...web, model: "wire-model", backend: "anthropic", streamRoutedModelOutput: true }, codexWebSearch: apply });
    expect(await handleAgentCommand(["sidecar", "web", "--model", "choice", "--reasoning", "high", "--stream-routed-output", "on", "--json"], f.deps)).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(["GET", "PUT"]); expect(f.resolutions()).toBe(1);
    expect(f.calls[1]?.body).toEqual({ webSearch: { model: "wire-model", backend: "anthropic", reasoning: "high", streamRoutedModelOutput: true } });
  });
  test("actual sidecar handler persists web reasoning even though the reply omits it", async () => {
    const config: OcxConfig = { port: 15600, defaultProvider: "", providers: {},
      webSearchSidecar: { model: "gpt-5.6-luna", reasoning: "low" } };
    const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:15600", fetchImpl: async (input, init) => {
      const req = new Request(String(input), init);
      const response = await handleConfigRoutes({ req, url: new URL(req.url), config, deps: {}, version: "fixture",
        trustedLoopbackIngress: true, guiSessionIssuance: null,
        convergeCodexCatalog: async () => { throw new Error("No catalog request expected"); },
        syncClaudeAgentDefsBestEffort: async () => {}, });
      if (!response) throw new Error("Missing handler"); return response;
    } };
    expect(await handleAgentCommand(["sidecar", "web", "--reasoning", "high", "--stream-routed-output", "on", "--json"], deps)).toBe(0);
    expect(config.webSearchSidecar).toMatchObject({ reasoning: "high", streamRoutedModelOutput: true });
    expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).webSearchSidecar.reasoning).toBe("high");
    expect(json().webSearch).not.toHaveProperty("reasoning");
  });
  test.each([1, 2147483647])("vision timeout uses canonical inclusive limits", async timeoutMs => {
    const f = fixture(() => ({ ok: true, vision: { ...vision, timeoutMs }, codexWebSearch: apply }));
    expect(await handleAgentCommand(["sidecar", "vision", "--timeout-ms", String(timeoutMs), "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ vision: { timeoutMs } }); expect(json().vision.timeoutMs).toBe(timeoutMs);
  });
  test("deferred native apply remains saved but nonzero without private detail", async () => {
    const f = fixture(() => ({ ok: true, webSearch: { ...web, enabled: false }, codexWebSearch: {
      applied: false, reason: "external_provider", retryable: false, detail: "fixture-private-value" } }));
    expect(await handleAgentCommand(["sidecar", "web", "--enabled", "off", "--stream-routed-output", "off", "--json"], f.deps)).toBe(1);
    expect(json().webSearch.enabled).toBe(false); expect(json().codexWebSearch).not.toHaveProperty("detail");
  });
  test.each([
    ["sidecar", "web", "--max-descriptions", "2"], ["sidecar", "web", "--timeout-ms", "1"],
    ["sidecar", "vision", "--stream-routed-output", "off"], ["sidecar", "vision", "--timeout-ms", "0"],
    ["sidecar", "vision", "--timeout-ms", "2147483648"], ["sidecar", "vision", "--timeout-ms", "1.5"],
    ["sidecar", "web", "--stream-routed-output", "on", "--stream-routed-output", "off"],
    ["injection", "status", "--sync-codex-defaults", "on"], ["injection", "set", "--sync-codex-defaults", "fixture-private-value"],
  ])("wrong section/invalid option refuses before transport", async (...args) => {
    const f = fixture(() => ({})); expect(await handleAgentCommand([...args, "--json"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("fixture-private-value");
  });
});
