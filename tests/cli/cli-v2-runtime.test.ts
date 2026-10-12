import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdV2, type V2CliDeps } from "../../src/cli/v2";
import { parseV2Command } from "../../src/cli/v2-input";
import { getLogicalMaxThreads, getMultiAgentModeHintText, isMultiAgentV2Enabled } from "../../src/codex/features";
import { resetCodexRuntimeResolveCacheForTests, setCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { MULTI_AGENT_MODE_HINT_RECOMMENDATION } from "../../src/codex/multi-agent-mode-policy";
import { SUBAGENT_SURFACE_GUIDE_URL } from "../../src/config/multi-agent-surface";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";

let home: TempHome, out: string[], errors: string[], path: string;
let logs: ReturnType<typeof spyOn>, errs: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
const privateText = "synthetic-private-native-error";
const committed = { status: "committed", changed: false, degraded: false, notices: [] };
const syncOk = { status: "applied", ok: true, catalogExists: true, catalogWritten: false, cacheSynced: false,
  added: 0, catalogPath: null, message: privateText, refreshOutcome: "committed" };
const readOutput = () => JSON.parse(out.join("\n"));
function config(extra: Record<string, unknown> = {}) {
  writeFileSync(home.path("config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", multiAgentMode: "default", ...extra }));
}
function native(enabled = false, threads = 12) {
  writeFileSync(path, `[features.multi_agent_v2]\nenabled = ${enabled}\nmax_concurrent_threads_per_session = ${threads}\n`);
}
function localDeps(syncValue: unknown = syncOk) {
  const syncPorts: (number | undefined)[] = [], actions: string[] = [];
  const deps: V2CliDeps = {
    featuresInvocation: action => ({ file: "synthetic-codex", args: ["features", action, "multi_agent_v2"], options: {} }),
    execFile: (file, args) => {
      expect(file).toBe("synthetic-codex"); actions.push(args[1]!);
      writeFileSync(path, readFileSync(path, "utf8").replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${args[1] === "enable"}`));
    },
    sync: async port => { syncPorts.push(port); return syncValue; },
  };
  return { deps, syncPorts, actions };
}
function state(overrides: Record<string, unknown> = {}) {
  return { enabled: false, agentsMaxThreadsConflict: false, maxConcurrentThreadsPerSession: 5,
    multiAgentMode: "default", keepNativeChatGptOnV1: false, agentsEnabled: null, agentsMaxDepth: null,
    subagentDeveloperInstructions: null, multiAgentModeHintText: null,
    multiAgentModeHintRecommendation: MULTI_AGENT_MODE_HINT_RECOMMENDATION,
    agentsMaxDepthAppliesWhenV2Disabled: true,
    multiAgentSurfaceAdvisory: { required: true, mode: "default", recommended: "v1", version: 1, docsUrl: SUBAGENT_SURFACE_GUIDE_URL },
    ...overrides };
}
function transport(body: unknown = state({ ok: true, catalogRefresh: committed }), status = 200) {
  const calls: { url: string; init: RequestInit }[] = []; let probes = 0;
  const runtimeApi: RuntimeApiDeps = {
    findLiveProxy: async () => { probes++; return { pid: 42, port: 19300 + probes, hostname: "127.0.0.1", source: "runtime" }; },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} }); return Response.json(body, { status });
    }) as typeof fetch,
  };
  return { runtimeApi, calls, probes: () => probes };
}
beforeEach(() => {
  home = createTempHome("ocx-cli-v2-runtime-"); mkdirSync(home.codexHome);
  path = join(home.codexHome, "config.toml"); config(); native();
  const binary = home.path("synthetic-codex");
  writeFileSync(binary, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("multi_agent_mode_hint_text")]));
  setCodexRuntimeResolveCacheForTests({ runtime: { command: binary, version: "fixture", source: "fallback" }, failures: [] });
  out = []; errors = [];
  logs = spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
  errs = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network denied"); });
});
afterEach(() => {
  logs.mockRestore(); errs.mockRestore(); network.mockRestore(); resetCodexRuntimeResolveCacheForTests(); home.remove();
});

describe("v2 preparse and literal hints", () => {
  const bad: string[][] = [
    ["status", "extra"], ["on", "off"], ["mode", "bogus"], ["mode", "v1", "extra"],
    ["keep-native-v1", "true"], ["threads", "0"], ["threads", "1.5"], ["threads", "9007199254740992"],
    ["mode-hint"], ["mode-hint", " "], ["mode-hint", "one", "two"], ["status", "--json", "--json"],
    ["mode", "v1", "--acknowledge-surface-advisory"], ["mode-hint", "value", "--acknowledge-surface-advisory"],
    ["on", "--", "value"], ["mode-hint", "--"], ["mode-hint", "--", "one", "two"],
    ["mode-hint", "--json=true"], ["mode-hint", "--live=yes"], ["mode-hint", "before", "--", "after"], ["mode-hint", "--", " "], ["unknown"],
  ];
  test.each(bad.map(args => [args] as const))("local malformed argv refuses before effects %j", async args => {
    const before = readFileSync(path, "utf8"), cfg = readFileSync(home.path("config.json"), "utf8");
    const local = localDeps();
    expect(await cmdV2([...args], local.deps, async () => { throw new Error("No discovery"); })).toBe(1);
    expect(local.actions).toEqual([]); expect(local.syncPorts).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before); expect(readFileSync(home.path("config.json"), "utf8")).toBe(cfg);
    expect(out).toEqual([]);
  });
  test.each([["status"], ["on"], ["off"], ["threads", "5"], ["keep-native-v1", "on"], ["mode-hint", "hint"]].map(args => [args] as const))(
    "live ack applies only to mode %j", async args => {
      const live = transport();
      expect(await cmdV2([...args, "--live", "--acknowledge-surface-advisory"], { runtimeApi: live.runtimeApi })).toBe(2);
      expect(live.calls).toEqual([]); expect(live.probes()).toBe(0);
    });
  test("duplicate live controls refuse before discovery", async () => {
    const live = transport();
    expect(await cmdV2(["status", "--live", "--live"], { runtimeApi: live.runtimeApi })).toBe(2);
    expect(live.probes()).toBe(0);
  });
  test.each(["--live", "--json", "--clear", "--acknowledge-surface-advisory", "help", "--help", "  Mixed  Case  "])("terminator preserves raw literal %s", async value => {
    const local = localDeps();
    expect(parseV2Command(["mode-hint", "--json", "--", value])).toMatchObject({ value, live: false, json: true });
    expect(await cmdV2(["mode-hint", "--json", "--", value], local.deps)).toBe(0);
    expect(getMultiAgentModeHintText()).toBe(value); expect(local.syncPorts).toEqual([]);
    expect(readOutput().state.multiAgentModeHintText).toBe(value);
  });
  test("unreserved legacy hyphen hint is ordinary text and clear unsets", async () => {
    expect(await cmdV2(["mode-hint", "- delegate early"])).toBe(0);
    expect(getMultiAgentModeHintText()).toBe("- delegate early"); out = [];
    expect(await cmdV2(["mode-hint", "--clear", "--json"])).toBe(0);
    expect(readOutput().state.multiAgentModeHintText).toBeNull();
  });
});

describe("live V2 fixed management operations", () => {
  const cases: [string[], Record<string, unknown> | undefined][] = [
    [[], undefined], [["status"], undefined], [["on"], { enabled: true }], [["off"], { enabled: false }],
    [["mode", "v1"], { multiAgentMode: "v1" }], [["mode", "default"], { multiAgentMode: "default" }],
    [["mode", "v2", "--acknowledge-surface-advisory"], { multiAgentMode: "v2", multiAgentSurfaceAdvisoryAcknowledged: true }],
    [["keep-native-v1", "off"], { keepNativeChatGptOnV1: false }], [["threads", "9"], { maxConcurrentThreadsPerSession: 9 }],
    [["mode-hint", "--clear"], { multiAgentModeHintText: null }], [["mode-hint", "  custom  "], { multiAgentModeHintText: "  custom  " }],
  ];
  test.each(cases)("maps %j and leaves local state untouched", async (args, body) => {
    const before = readFileSync(path, "utf8"), cfg = readFileSync(home.path("config.json"), "utf8"), files = readdirSync(home.root);
    const live = transport();
    expect(await cmdV2([...args, "--live", "--json"], { runtimeApi: live.runtimeApi,
      isEnabled: () => { throw new Error("No native read"); }, execFile: () => { throw new Error("No native process"); } })).toBe(0);
    expect(live.probes()).toBe(1); expect(live.calls).toHaveLength(1);
    expect(live.calls[0]!.url).toBe("http://127.0.0.1:19301/api/v2");
    expect(live.calls[0]!.init.redirect).toBe("error");
    expect(live.calls[0]!.init.method).toBe(body ? "PUT" : "GET");
    expect(body ? JSON.parse(String(live.calls[0]!.init.body)) : live.calls[0]!.init.body).toEqual(body);
    expect(readFileSync(path, "utf8")).toBe(before); expect(readFileSync(home.path("config.json"), "utf8")).toBe(cfg);
    expect(readdirSync(home.root)).toEqual(files); expect(readOutput().target).toBe("live");
  });
  test.each([[404, 4], [409, 5], [400, 1], [502, 1], [503, 1], [401, 1]])("safe refusal HTTP %i exits %i", async (status, code) => {
    const live = transport({ error: privateText, token: privateText }, status);
    expect(await cmdV2(["on", "--live", "--json"], { runtimeApi: live.runtimeApi })).toBe(code);
    expect(live.calls).toHaveLength(1); expect(out).toEqual([]); expect(errors.join("\n")).not.toContain(privateText);
    if (status === 502) expect(errors.join("\n")).toContain("partially applied");
  });
  test.each([
    { status: "committed", changed: true, degraded: true, notices: ["provider-auth"] },
    { status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: true },
    { status: "skipped", reason: "busy", retryable: true },
  ])("saved partial catalog is visible and nonzero %j", async catalogRefresh => {
    const live = transport(state({ ok: true, catalogRefresh, error: privateText, warnings: [privateText] }));
    expect(await cmdV2(["on", "--live", "--json"], { runtimeApi: live.runtimeApi })).toBe(1);
    expect(readOutput().catalogRefresh).toEqual(catalogRefresh); expect(out.join("\n")).not.toContain(privateText);
  });
  test.each([
    { enabled: "false" }, { agentsEnabled: "false" }, { agentsMaxDepth: 2147483648 }, { maxConcurrentThreadsPerSession: "5" },
    { multiAgentMode: "unknown" }, { multiAgentSurfaceAdvisory: {} }, { multiAgentModeHintRecommendation: "wrong" },
    { subagentDeveloperInstructions: {} }, { multiAgentModeHintText: [] }, { catalogRefresh: {} }, { ok: false },
  ])("rejects malformed outcome %j", async override => {
    const live = transport(state({ ok: true, catalogRefresh: committed, ...override }));
    expect(await cmdV2(["on", "--live", "--json"], { runtimeApi: live.runtimeApi })).toBe(1);
    expect(out).toEqual([]); expect(errors.join("\n")).not.toContain(privateText);
  });
});

describe("local V2 state and synchronization graph", () => {
  test.each([["mode", "default"], ["keep-native-v1", "off"], ["on"]].map(args => [args] as const))(
    "required sync runs with undefined port for %j", async args => {
      const local = localDeps();
      expect(await cmdV2([...args, "--json"], local.deps, async () => undefined)).toBe(0);
      expect(local.syncPorts).toEqual([undefined]); expect(readOutput().sync.catalog.converged).toBe(true);
      expect(out.join("\n")).not.toContain(privateText);
    });
  test.each([["status"], ["off"], ["threads", "7"], ["mode-hint", "sample"]].map(args => [args] as const))(
    "no new synchronization for %j", async args => {
      if (args[0] === "off") writeFileSync(path, "[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_threads = 12\n");
      const local = localDeps();
      expect(await cmdV2([...args, "--json"], local.deps, async () => { throw new Error("No port discovery"); })).toBe(0);
      expect(local.syncPorts).toEqual([]); expect(readOutput().sync.status).toBe("not-attempted");
    });
  test.each([undefined, {}, { ok: true }, { ...syncOk, catalogExists: "true" }, { ...syncOk, refreshOutcome: "unknown" }])(
    "unknown injected sync is unverified, preserving landed state %j", async result => {
      const local = localDeps(null); local.deps.sync = async () => result;
      expect(await cmdV2(["on", "--json"], local.deps)).toBe(1);
      expect(readOutput()).toMatchObject({ ok: false, changed: true, state: { enabled: true }, sync: { status: "unverified", ok: false } });
    });
  test.each([
    { ...syncOk, ok: false }, { ...syncOk, refreshOutcome: "refused" }, { ...syncOk, catalogExists: false },
    { ...syncOk, status: "refused", ok: false },
  ])("actual backend failure cannot report success %j", async result => {
    const local = localDeps(result);
    expect(await cmdV2(["mode", "v1", "--json"], local.deps)).toBe(1);
    expect(readOutput().sync.ok).toBe(false); expect(readOutput().state.multiAgentMode).toBe("v1");
    expect(out.join("\n")).not.toContain(privateText);
  });
  test("throwing sync preserves enabled state and hides private helper errors", async () => {
    const local = localDeps(); local.deps.sync = async () => { throw new Error(privateText); };
    expect(await cmdV2(["on", "--json"], local.deps)).toBe(1);
    expect(readOutput()).toMatchObject({ changed: true, state: { enabled: true }, sync: { status: "failed", ok: false } });
    expect(out.join("\n") + errors.join("\n")).not.toContain(privateText);
  });
  test("native feature failure restores original bytes with safe failure", async () => {
    const before = readFileSync(path, "utf8"); const local = localDeps();
    local.deps.execFile = () => { throw new Error(privateText); };
    expect(await cmdV2(["on", "--json"], local.deps)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before); expect(local.syncPorts).toEqual([]);
    expect(readOutput().state.enabled).toBe(false); expect(out.join("\n") + errors.join("\n")).not.toContain(privateText);
  });
  test("hybrid ownership refuses a global on before native writes", async () => {
    config({ multiAgentMode: "v2", keepNativeChatGptOnV1: true }); const local = localDeps();
    expect(await cmdV2(["on", "--json"], local.deps)).toBe(1);
    expect(local.actions).toEqual([]); expect(local.syncPorts).toEqual([]); expect(readOutput().changed).toBe(false);
  });
  test("unchanged on skips synchronization and reports no change", async () => {
    native(true); const local = localDeps();
    expect(await cmdV2(["on", "--json"], local.deps)).toBe(0);
    expect(readOutput().changed).toBe(false); expect(local.syncPorts).toEqual([]);
  });
  test("hybrid keep-native reconciliation disables the global override and syncs", async () => {
    native(true); config({ multiAgentMode: "v2", keepNativeChatGptOnV1: true }); const local = localDeps();
    expect(await cmdV2(["keep-native-v1", "on", "--json"], local.deps)).toBe(0);
    expect(readOutput()).toMatchObject({ changed: true, state: { enabled: false, multiAgentMode: "v2", keepNativeChatGptOnV1: true } });
    expect(local.actions).toEqual(["disable"]); expect(local.syncPorts).toEqual([undefined]);
  });
  test("typed skipped sync is policy truth without fabricated config application", async () => {
    const local = localDeps({ ...syncOk, status: "skipped", catalogExists: false, refreshOutcome: undefined });
    expect(await cmdV2(["mode", "default", "--json"], local.deps)).toBe(0);
    expect(readOutput().sync).toMatchObject({ status: "skipped", ok: true, configApplied: false, catalog: { exists: false, converged: false } });
  });
  test("post-save readback failure preserves an unknown outcome without claiming rollback", async () => {
    const local = localDeps(); let reads = 0;
    local.deps.isEnabled = () => { reads++; throw new Error(privateText); };
    expect(await cmdV2(["mode", "default", "--json"], local.deps)).toBe(1);
    expect(readOutput()).toMatchObject({ ok: false, state: null });
    expect(local.syncPorts).toEqual([undefined]); expect(reads).toBe(1);
    expect(out.join("\n") + errors.join("\n")).not.toContain(privateText);
  });
  test("mode/threads/off/on preserve native root-slot translation", async () => {
    writeFileSync(path, "[agents]\nmax_threads = 100\n"); const local = localDeps();
    for (const [args, total, enabled] of [
      [["mode", "v2"], 101, true], [["threads", "77"], 77, true], [["off"], 76, false],
      [["on"], 77, true], [["mode", "v1"], 76, false],
    ] as const) {
      out = []; expect(await cmdV2([...args, "--json"], local.deps)).toBe(0);
      expect(getLogicalMaxThreads()).toBe(total); expect(isMultiAgentV2Enabled()).toBe(enabled);
    }
    expect(local.syncPorts).toHaveLength(4);
  });
});

describe("live V2 accepted state through the isolated real handler", () => {
  test("real hint and mode writes report persisted fields, advisory and catalog", async () => {
    const { handleManagementAPI } = await import("../../src/server/management-api");
    const { loadConfig } = await import("../../src/config");
    const calls: string[] = [];
    const runtimeApi: RuntimeApiDeps = { baseUrl: "http://localhost", fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      const headers = new Headers(init?.headers); headers.set("Host", new URL(String(url)).host);
      const req = new Request(String(url), { ...init, headers });
      const reply = await handleManagementAPI(req, new URL(String(url)), loadConfig(), {
        toggleCodexMultiAgentV2: enabled => { writeFileSync(path, readFileSync(path, "utf8").replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`)); },
        createManagementConvergeCodex: catalogConvergenceFactory(),
      }) ?? new Response(null, { status: 404 });
      return reply;
    }) as typeof fetch };
    expect(await cmdV2(["mode-hint", "  custom  ", "--live", "--json"], { runtimeApi })).toBe(0);
    expect(readOutput().multiAgentModeHintText).toBe("  custom  "); expect(getMultiAgentModeHintText()).toBe("  custom  ");
    out = [];
    expect(await cmdV2(["mode", "v2", "--live", "--json", "--acknowledge-surface-advisory"], { runtimeApi })).toBe(0);
    expect(readOutput().multiAgentMode).toBe("v2"); expect(readOutput().multiAgentSurfaceAdvisory.required).toBe(false);
    expect(readOutput().catalogRefresh).toEqual(committed); expect(calls).toHaveLength(2);
  });
});


describe("live V2 real-handler refusal and incomplete convergence", () => {
  test.each(["native-failure", "catalog-failure"])("reports %s without local fallback or hidden retry", async failure => {
    const { handleManagementAPI } = await import("../../src/server/management-api");
    const { loadConfig } = await import("../../src/config");
    const before = readFileSync(path, "utf8"); let requests = 0, toggles = 0;
    const runtimeApi: RuntimeApiDeps = { baseUrl: "http://localhost", fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests++; const headers = new Headers(init?.headers); headers.set("Host", "localhost");
      return await handleManagementAPI(new Request(String(url), { ...init, headers }), new URL(String(url)), loadConfig(), {
        toggleCodexMultiAgentV2: enabled => {
          toggles++;
          if (failure === "native-failure") throw new Error(privateText);
          writeFileSync(path, readFileSync(path, "utf8").replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
        },
        createManagementConvergeCodex: catalogConvergenceFactory(() => {}, { status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: true }),
      }) ?? new Response(null, { status: 404 });
    }) as typeof fetch };
    expect(await cmdV2(["on", "--live", "--json"], { runtimeApi,
      execFile: () => { throw new Error("Local fallback is forbidden"); } })).toBe(1);
    expect(requests).toBe(1); expect(toggles).toBe(1);
    if (failure === "native-failure") { expect(out).toEqual([]); expect(readFileSync(path, "utf8")).toBe(before); }
    else expect(readOutput()).toMatchObject({ enabled: true, catalogRefresh: { status: "failed", partialWrite: true } });
    expect(out.join("\n") + errors.join("\n")).not.toContain(privateText);
  });
});

describe("root dispatch compatibility", () => {
  test("real root dispatch preserves local JSON and terminator operands", async () => {
    const { dispatchCommand } = await import("../../src/cli/dispatch");
    const { parseCliHead } = await import("../../src/cli/root");
    const run = async (args: string[]) => {
      const head = parseCliHead(args);
      expect(head.kind).toBe("command");
      // Only the v2 runner's declared dependency is present; accessing another is a fixture failure.
      const deps = new Proxy({ args, findLiveProxy: async () => { throw new Error("No discovery"); } }, {
        get(target, key) { if (key in target) return Reflect.get(target, key); throw new Error("Unexpected root dependency"); },
      }) as unknown as import("../../src/cli/dispatch").CliDispatchDeps;
      return dispatchCommand(head, deps);
    };
    expect(await run(["v2", "status", "--json"])).toBe(0);
    expect(readOutput().state.enabled).toBe(false); out = [];
    expect(await run(["v2", "mode-hint", "--json", "--", "--help"])).toBe(0);
    expect(readOutput().state.multiAgentModeHintText).toBe("--help"); out = [];
    expect(await run(["v2", "status", "extra", "--json"])).toBe(1); expect(out).toEqual([]);
  });
  test("human status retains native tri-state and V1-only meaning", async () => {
    native(true); writeFileSync(path, readFileSync(path, "utf8") + '\n[agents]\nenabled = false\nmax_depth = 2\n');
    expect(await cmdV2(["status"])).toBe(0);
    expect(out.join("\n")).toContain("agents.enabled: false");
    expect(out.join("\n")).toContain("agents.max_depth: 2 (V1-only — ignored while multi_agent_v2 is enabled)");
    expect(out.join("\n")).toContain("subagent_developer_instructions: (unset — children inherit)");
  });
});

describe("local V2 action-specific human feedback", () => {
  test.each([true, false])("changed keep-native-v1 reports its actual switch %s", async enabled => {
    config({ keepNativeChatGptOnV1: !enabled }); const local = localDeps();
    expect(await cmdV2(["keep-native-v1", enabled ? "on" : "off"], local.deps)).toBe(0);
    expect(out.join("\n")).toContain(`keep_native_chatgpt_on_v1: ${enabled ? "ON" : "OFF"}`);
    expect(local.syncPorts).toEqual([undefined]);
  });
  test.each([true, false])("unchanged keep-native-v1 still syncs and names the existing state %s", async enabled => {
    config({ keepNativeChatGptOnV1: enabled }); const local = localDeps();
    expect(await cmdV2(["keep-native-v1", enabled ? "on" : "off"], local.deps)).toBe(0);
    expect(out.join("\n")).toContain(`keep_native_chatgpt_on_v1 already ${enabled ? "ON" : "OFF"} — catalog re-synced.`);
    expect(local.syncPorts).toEqual([undefined]);
  });
  test("mode output names the effective hybrid surface", async () => {
    config({ keepNativeChatGptOnV1: true }); const local = localDeps();
    expect(await cmdV2(["mode", "v2"], local.deps)).toBe(0);
    expect(out.join("\n")).toContain("multi_agent_mode: v2 hybrid — ChatGPT-native models use v1; routed models use v2");
    expect(out.join("\n")).toContain("Applies to NEW sessions");
  });
  test.each([true, false])("changed native toggle names the switch and new-session scope %s", async enabled => {
    native(!enabled); const local = localDeps();
    expect(await cmdV2([enabled ? "on" : "off"], local.deps)).toBe(0);
    expect(out.join("\n")).toContain(`multi_agent_v2: ${enabled ? "ON" : "OFF"}`);
    expect(out.join("\n")).toContain("Applies to NEW sessions");
  });
  test("hybrid refusal names why and gives the recovery command", async () => {
    config({ multiAgentMode: "v2", keepNativeChatGptOnV1: true }); const local = localDeps();
    expect(await cmdV2(["on"], local.deps)).toBe(1);
    expect(errors.join("\n")).toContain("global multi_agent_v2 overrides the native v1 catalog pin");
    expect(errors.join("\n")).toContain("ocx v2 keep-native-v1 off");
    expect(local.syncPorts).toEqual([]);
  });
  test("missing keep-native switch gives static expected choices", async () => {
    expect(await cmdV2(["keep-native-v1"])).toBe(1);
    expect(errors.join("\n")).toContain("expected on|off");
  });
  test.each([undefined, { ...syncOk, refreshOutcome: "refused" }])("unverified or refused sync remains a safe resync failure %j", async result => {
    const local = localDeps(null); local.deps.sync = async () => result;
    expect(await cmdV2(["on"], local.deps)).toBe(1);
    expect(errors.join("\n")).toContain("catalog resync failed");
    expect(errors.join("\n")).toContain("settings landed");
    expect(errors.join("\n")).not.toContain(privateText); expect(isMultiAgentV2Enabled()).toBe(true);
    expect(out).toEqual([]);
  });
  test.each([false, true])("a policy skip does not falsely claim the catalog was re-synced (existing=%s)", async catalogExists => {
    config({ keepNativeChatGptOnV1: true });
    const local = localDeps({ ...syncOk, status: "skipped", catalogExists, refreshOutcome: undefined });
    expect(await cmdV2(["keep-native-v1", "on"], local.deps)).toBe(0);
    expect(out.join("\n")).toContain("already ON — catalog sync skipped by policy");
    expect(out.join("\n")).not.toContain("catalog re-synced");
  });
});
