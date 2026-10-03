import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ROUTING_CAPABILITIES } from "../../src/cli/capabilities-agents-routing";
import { handleAgentCommand } from "../../src/cli/agent";
import { handleComboCommand } from "../../src/cli/combo";
import { handleEffortCommand } from "../../src/cli/effort";
import { handleRoutePolicyCommand } from "../../src/cli/route-policy";
import { cmdV2 } from "../../src/cli/v2";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previous: Record<string, string | undefined>;
let output: ReturnType<typeof spyOn<typeof console, "log">>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-cap-agent-"));
  previous = { OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "", port: 10100 }));
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore(); errors.mockRestore();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});

type RequestRow = { path: string; method: string; body: unknown };
function runtime(reply: (request: RequestRow) => unknown = () => ({ ok: true })) {
  const requests: RequestRow[] = [];
  const deps: RuntimeApiDeps = {
    baseUrl: "http://fixture.invalid", findLiveProxy: async () => null,
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const request = { path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      requests.push(request);
      return Response.json(reply(request));
    }) as typeof fetch,
  };
  return { requests, deps };
}
function leaf(key: string) {
  const found = AGENT_ROUTING_CAPABILITIES.find(row => row.command.join(" ") === key);
  expect(found).toBeDefined();
  return found!;
}

describe("declared agent and routing workflows", () => {
  test("agent status declares the six actual reads and preserves its envelope", async () => {
    const { requests, deps } = runtime(request => ({ path: request.path }));
    expect(leaf("agent status").json).toBe("envelope");
    expect(await handleAgentCommand(["status", "--json"], deps)).toBe(0);
    const paths = ["/api/v2", "/api/injection-model", "/api/effort-caps", "/api/subagent-models", "/api/subagent-model-fallback", "/api/sidecar-settings"];
    expect(requests.map(r => r.path)).toEqual(paths);
    expect(leaf("agent status").routes).toEqual(paths.map(path => ({ method: "GET", path })));
    expect(JSON.parse(String(output.mock.calls[0][0])).caps).toEqual({ path: "/api/effort-caps" });
  });

  test.each([
    { key: "agent effort set", args: ["effort", "set", "--main", "high", "--subagent", "-", "--json"], path: "/api/effort-caps", body: { effortCap: "high", subagentEffortCap: null } },
    { key: "agent subagents set", args: ["subagents", "set", "demo/a,demo/b", "--json"], path: "/api/subagent-models", body: { models: ["demo/a", "demo/b"] } },
    { key: "agent subagents clear", args: ["subagents", "clear", "--json"], path: "/api/subagent-models", body: { models: [] } },
    { key: "agent fallback set", args: ["fallback", "set", "demo/b", "--poll-ms", "5000", "--json"], path: "/api/subagent-model-fallback", body: { models: ["demo/b"], pollMs: 5000 } },
    { key: "agent fallback clear", args: ["fallback", "clear", "--json"], path: "/api/subagent-model-fallback", body: { models: [] } },
  ])("$key drives the declared owner with explicit clear semantics", async ({ key, args, path, body }) => {
    expect(leaf(key).routes).toEqual([{ method: "PUT", path }]);
    expect(leaf(key).mutates).toBe(true);
    const { requests, deps } = runtime();
    expect(await handleAgentCommand(args, deps)).toBe(0);
    expect(requests).toEqual([{ method: "PUT", path, body }]);
  });

  test("web sidecar candidates normalize the actual selected model before PUT", async () => {
    const { requests, deps } = runtime(() => ({ webSearchModels: [{ value: "slot/demo", model: "demo", backend: "anthropic" }] }));
    expect(leaf("agent sidecar web").flags.find(f => f.name === "--list")?.value).toBe("boolean");
    expect(await handleAgentCommand(["sidecar", "web", "--model", "slot/demo", "--json"], deps)).toBe(0);
    expect(requests).toEqual([
      { path: "/api/sidecar-settings", method: "GET", body: null },
      { path: "/api/sidecar-settings", method: "PUT", body: { webSearch: { model: "demo", backend: "anthropic" } } },
    ]);
    expect(leaf("agent sidecar web").routes).toEqual([{ method: "GET", path: "/api/sidecar-settings" }, { method: "PUT", path: "/api/sidecar-settings" }]);
  });

  test("vision list is a read and does not write settings", async () => {
    const { requests, deps } = runtime(() => ({ visionModels: [{ value: "demo/vision", backend: "routed" }] }));
    expect(leaf("agent sidecar vision").usage).toContain("--list");
    expect(await handleAgentCommand(["sidecar", "vision", "--list", "--json"], deps)).toBe(0);
    expect(requests).toEqual([{ path: "/api/sidecar-settings", method: "GET", body: null }]);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual([{ value: "demo/vision", backend: "routed" }]);
  });

  test("effort set writes and reads back both live fields without changing local config", async () => {
    const initial = readFileSync(join(home, "config.json"), "utf8");
    const { requests, deps } = runtime(request => request.path === "/api/effort-caps"
      ? { effortCap: "high", subagentEffortCap: "medium", efforts: ["medium", "high"] } : { effort: "minimal" });
    expect(leaf("effort set").json).toBe("envelope");
    expect(await handleEffortCommand(["set", "--main", "high", "--injection", "minimal", "--json"], deps)).toBe(0);
    expect(requests).toEqual([
      { path: "/api/effort-caps", method: "PUT", body: { effortCap: "high" } },
      { path: "/api/injection-model", method: "PUT", body: { effort: "minimal" } },
      { path: "/api/effort-caps", method: "GET", body: null },
      { path: "/api/injection-model", method: "GET", body: null },
    ]);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(initial);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ ok: true, effortCap: "high", subagentEffortCap: "medium", injectionEffort: "minimal", source: "runtime" });
  });

  test("effort clear preserves injection effort in an isolated offline home", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, effortCap: "high", subagentEffortCap: "medium", injectionEffort: "minimal" }));
    expect(leaf("effort clear").mutates).toBe(true);
    expect(await handleEffortCommand(["clear", "--json"], { findLiveProxy: async () => null })).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(saved.effortCap).toBeUndefined(); expect(saved.subagentEffortCap).toBeUndefined();
    expect(saved.injectionEffort).toBe("minimal");
    expect(JSON.parse(String(output.mock.calls[0][0])).source).toBe("config");
  });

  test("combo set reads the collection and sends independent target/rename fields", async () => {
    const { requests, deps } = runtime(request => {
      if (request.method === "GET") return { combos: [] };
      const body = request.body as { id: string; combo: Record<string, unknown> };
      return { success: true, id: body.id, model: `combo/${body.id}`, combo: body.combo,
        catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } };
    });
    expect(leaf("combo set").usage).toContain("--rename-from <id>");
    expect(await handleComboCommand(["set", "new", "--targets", "demo/a:2,demo/b", "--strategy", "round-robin", "--sticky", "3", "--rename-from", "old", "--json"], deps)).toBe(0);
    expect(requests).toEqual([
      { path: "/api/combos", method: "GET", body: null },
      { path: "/api/combos", method: "PUT", body: { id: "new", renameFrom: "old", combo: { strategy: "round-robin", stickyLimit: 3, targets: [{ provider: "demo", model: "a", weight: 2 }, { provider: "demo", model: "b" }] } } },
    ]);
    expect(leaf("combo set").routes).toEqual([{ method: "GET", path: "/api/combos" }, { method: "PUT", path: "/api/combos" }]);
  });

  test("combo remove refuses without confirmation before sending any DELETE", async () => {
    const { requests, deps } = runtime();
    expect(leaf("combo remove").flags.find(f => f.name === "--yes")?.required).toBe(true);
    expect(await handleComboCommand(["remove", "fixture", "--json"], deps)).toBe(2);
    expect(requests).toEqual([]);
    expect(errors.mock.calls.flat().join(" ")).toContain("requires --yes");
  });

  test.each(["dry-run", "evaluate"])("route policy %s preserves exact evidence and marks possible Lab activation", async verb => {
    const { requests, deps } = runtime(() => ({ profile: "fixture", selected: null }));
    const capability = leaf("route policy " + verb);
    expect(capability.mutates).toBe(true);
    expect(capability.routes).toEqual([{ method: "POST", path: "/api/routing-profiles/dry-run" }]);
    expect(await handleRoutePolicyCommand([verb, "fixture", "--model-context", "32000", "--tools", "--image", "--structured-output", "--json"], deps)).toBe(0);
    expect(requests).toEqual([{ path: "/api/routing-profiles/dry-run", method: "POST", body: { profile: "fixture", evidence: { contextWindow: 32000, toolsRequired: true, imageInputRequired: true, structuredOutputRequired: true } } }]);
  });

  test("local v2 mode-hint clears through the real helper without claiming JSON or HTTP", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "codex"));
    writeFileSync(join(home, "codex", "config.toml"), '[features.multi_agent_v2]\nmulti_agent_mode_hint_text = "old"\n');
    const capability = leaf("v2 mode-hint");
    expect(capability.routes).toEqual([]); expect(capability.json).toBe("none");
    expect(capability.usage).toBe("ocx v2 mode-hint <text|--clear>");
    expect(await cmdV2(["mode-hint", "--clear"])).toBe(0);
    expect(readFileSync(join(home, "codex", "config.toml"), "utf8")).not.toContain("multi_agent_mode_hint_text");
    expect(await cmdV2(["mode-hint", "   "])).toBe(1);
  });

  test("v2 invalid thread/mode operands refuse without invoking tools or synchronization", async () => {
    let sideEffects = 0;
    for (const [key, args] of [["v2 threads", ["threads", "0"]], ["v2 mode", ["mode", "invalid"]], ["v2 keep-native-v1", ["keep-native-v1", "invalid"]]] as const) {
      expect(leaf(key).json).toBe("none"); expect(leaf(key).routes).toEqual([]);
      expect(await cmdV2([...args], { execFile: () => { sideEffects++; }, sync: async () => { sideEffects++; } })).toBe(1);
    }
    expect(sideEffects).toBe(0);
  });
});
