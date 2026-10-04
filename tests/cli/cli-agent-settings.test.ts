import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { handleAgentSettingsCommand } from "../../src/cli/agent-settings";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome, savedToken: string | undefined;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-agent-settings-");
  savedToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  output.mockRestore(); errors.mockRestore(); network.mockRestore();
  if (savedToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = savedToken;
  home.remove();
});
function fixture(response?: unknown, status = 200) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let resolutions = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 14500 + ++resolutions, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url: String(input), method: init?.method ?? "GET", ...(body === undefined ? {} : { body }) });
      return Response.json(response === undefined ? {
        ok: true, memoryModels: null, compactionRouting: null, ...body,
        catalogRefreshPending: false, apiKey: "not-for-output",
      } : response, { status });
    }) as typeof fetch,
  };
  return { deps, calls, resolutions: () => resolutions };
}
function result(): Record<string, unknown> {
  expect(output).toHaveBeenCalledTimes(1);
  return JSON.parse(String(output.mock.calls[0]?.[0]));
}
function stdin(value: unknown) { return Readable.from([Buffer.from(JSON.stringify(value))]); }
const blocks = [
  { sub: "memory-models", key: "memoryModels", args: ["--extract-model", " p/a ", "--extract-effort", "high"], value: { extract: { model: "p/a", reasoningEffort: "high" } } },
  { sub: "compaction-routing", key: "compactionRouting", args: ["--model", " p/a ", "--effort", "low", "--triggers", "manual,auto", "--sources", "p/*,q/raw-model"], value: { model: "p/a", reasoningEffort: "low", triggers: ["manual", "auto"], sourceModels: ["p/*", "q/raw-model"] } },
] as const;
for (const { sub, key, args, value } of blocks) describe(sub, () => {
  test("show is one read and emits only the validated task block", async () => {
    const f = fixture({ [key]: value, apiKey: "private", catalogRefreshPending: true });
    expect(await handleAgentSettingsCommand(sub, ["show", "--json"], f.deps)).toBe(0);
    expect(result()).toEqual({ [key]: value });
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:14501/api/settings", method: "GET" }]);
    expect(f.resolutions()).toBe(1);
  });
  test("scalar set normalizes and sends only one complete block without a probe", async () => {
    const f = fixture();
    expect(await handleAgentSettingsCommand(sub, ["set", ...args, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:14501/api/settings", method: "PUT", body: { [key]: value } }]);
    expect(f.resolutions()).toBe(1);
    expect(result()).toEqual({ [key]: value, catalogRefreshPending: false });
  });
  test("file block is normalized before writing", async () => {
    const path = home.path("block.json");
    const raw = sub === "memory-models" ? { extract: { model: " p/a ", reasoningEffort: "high" } }
      : { ...value, model: " p/a " };
    writeFileSync(path, JSON.stringify(raw));
    const f = fixture();
    expect(await handleAgentSettingsCommand(sub, ["set", "--file", path, "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ [key]: value });
  });
  test("clear sends null and describes routing restoration", async () => {
    const f = fixture();
    expect(await handleAgentSettingsCommand(sub, ["clear"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ [key]: null });
    expect(output.mock.calls.flat().join("\n")).toContain("existing routing remains in use");
  });
  for (const [pending, code] of [[true, 1], [false, 0], [undefined, 1], [null, 1], ["false", 1]] as const) {
    test(`actual pending evidence ${String(pending)}`, async () => {
      const f = fixture({ ok: true, [key]: value, catalogRefreshPending: pending });
      expect(await handleAgentSettingsCommand(sub, ["set", ...args, "--json"], f.deps)).toBe(code);
      expect(result()).toEqual({ [key]: value, catalogRefreshPending: typeof pending === "boolean" ? pending : null,
        ...(typeof pending === "boolean" ? {} : { verification: "unverified" }) });
    });
  }
  for (const invalid of [[], ["unknown-private"], ["set"], ["show", "--json", "--json"], ["show", "--json=true"],
    ["show", "--file", "private"], ["clear", ...args], ["set", ...args, "--file", "private"],
    ["set", "--file"], ["set", "--file=private", "--file=private2"], ["set", ...args, ...args],
    ["set", "--token", "private"], ["set", "--file", "private", "--unknown=private"]]) {
    test(`invalid syntax before discovery: ${invalid.join(" ")}`, async () => {
      const f = fixture();
      expect(await handleAgentSettingsCommand(sub, [...invalid], f.deps)).toBe(2);
      expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0); expect(output).not.toHaveBeenCalled();
      expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
    });
  }
  for (const bad of [null, [], "private", { token: "private" }]) test(`invalid file block ${JSON.stringify(bad)}`, async () => {
    const f = fixture(); f.deps.stdinImpl = stdin(bad);
    expect(await handleAgentSettingsCommand(sub, ["set", "--file", "-"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
  });
  for (const bad of [null, [], {}, { ok: false, [key]: value }, { ok: true }, { ok: true, [key]: { token: "private" } }]) {
    test(`refuses unusable acceptance ${JSON.stringify(bad)}`, async () => {
      expect(await handleAgentSettingsCommand(sub, ["clear", "--json"], fixture(bad).deps)).toBe(1);
      expect(output).not.toHaveBeenCalled(); expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
    });
  }
  for (const [http, code] of [[400, 1], [401, 1], [403, 1], [404, 4], [409, 5], [503, 1]] as const) {
    test(`HTTP ${http} has static diagnostics, no retry and exit ${code}`, async () => {
      const f = fixture({ error: "private", token: "private" }, http);
      expect(await handleAgentSettingsCommand(sub, ["clear", "--json"], f.deps)).toBe(code);
      expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
      expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
    });
  }
});

describe("strict phase and selector semantics", () => {
  test("empty memory file means no custom phases and stays distinct from clear", async () => {
    const f = fixture(); f.deps.stdinImpl = stdin({});
    expect(await handleAgentSettingsCommand("memory-models", ["set", "--file", "-", "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ memoryModels: {} });
  });
  test("consolidation can be the only selected phase", async () => {
    const f = fixture();
    expect(await handleAgentSettingsCommand("memory-models", ["set", "--consolidation-model=p/b"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ memoryModels: { consolidation: { model: "p/b" } } });
  });
  for (const args of [["--extract-effort", "high"], ["--extract-model", "p/a", "--consolidation-effort", "high"],
    ["--extract-model", " "], ["--extract-model", "p/a", "--extract-effort", "private"]]) {
    test(`memory refusal ${args.join(" ")}`, async () => {
      const f = fixture();
      expect(await handleAgentSettingsCommand("memory-models", ["set", ...args], f.deps)).toBe(2);
      expect(f.resolutions()).toBe(0);
    });
  }
  for (const value of [{ extract: {} }, { consolidation: { reasoningEffort: "high" } }, { extract: { model: "p/a", private: true } }]) {
    test(`memory file refusal ${JSON.stringify(value)}`, async () => {
      const f = fixture(); f.deps.stdinImpl = stdin(value);
      expect(await handleAgentSettingsCommand("memory-models", ["set", "--file", "-"], f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
    });
  }
  for (const [flag, values] of [["--triggers", ["", "manual,", "manual,,auto", "auto,auto", " auto", "other"]],
    ["--sources", ["", "p/*,", "p/a,,q/b", "p/a,p/a", " p/a", "p /a", "*", "p/a*", "p/*/a"]]] as const) {
    for (const value of values) test(`compaction refuses exact CSV ${flag} ${value}`, async () => {
      const f = fixture();
      expect(await handleAgentSettingsCommand("compaction-routing", ["set", "--model", "p/a", flag, value], f.deps)).toBe(2);
      expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    });
  }
  test("bounded serialization refuses scalar data before target discovery", async () => {
    const f = fixture();
    expect(await handleAgentSettingsCommand("compaction-routing", ["set", "--model", "m".repeat(4 * 1024 * 1024)], f.deps)).toBe(2);
    expect(f.resolutions()).toBe(0); expect(f.calls).toEqual([]);
  });
  test("malformed JSON and invalid UTF-8 do not echo bytes", async () => {
    for (const bytes of [Buffer.from('{"private":'), Buffer.from([0xff, 0xfe])]) {
      const f = fixture(); f.deps.stdinImpl = Readable.from([bytes]);
      expect(await handleAgentSettingsCommand("memory-models", ["set", "--file", "-"], f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
    }
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
  });
  test("oversized stdin is rejected before discovering a target", async () => {
    const f = fixture(); f.deps.stdinImpl = Readable.from([Buffer.alloc(4 * 1024 * 1024 + 1, 65)]);
    expect(await handleAgentSettingsCommand("memory-models", ["set", "--file", "-"], f.deps)).toBe(2);
    expect(f.resolutions()).toBe(0); expect(f.calls).toEqual([]);
    expect(errors.mock.calls.flat().join("\n")).toContain("4 MiB");
  });
  test("show refuses a missing block rather than inventing a cleared setting", async () => {
    for (const sub of ["memory-models", "compaction-routing"] as const) {
      expect(await handleAgentSettingsCommand(sub, ["show", "--json"], fixture({}).deps)).toBe(1);
    }
    expect(output).not.toHaveBeenCalled();
  });
  test("network failure never leaks transport text or retries", async () => {
    const f = fixture(); let attempts = 0;
    f.deps.fetchImpl = (async () => { attempts++; throw new Error("private transport details"); }) as typeof fetch;
    expect(await handleAgentSettingsCommand("memory-models", ["clear"], f.deps)).toBe(1);
    expect(attempts).toBe(1); expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
  });
});

describe("actual settings handler state", () => {
  for (const { sub, key, args, value } of blocks) test(`${sub} replaces, reads and clears persisted overrides only`, async () => {
    const configModule = await import("../../src/config");
    const { handleConfigRoutes } = await import("../../src/server/management/config-routes");
    const desktop = await import("../../src/codex/desktop-switches");
    const runtime = await import("../../src/codex/runtime");
    const quota = await import("../../src/codex/quota-auto-refresh");
    const { startupHealthFixture } = await import("../helpers/startup-health");
    const observe = spyOn(desktop, "observedCodexDesktopSwitchApply").mockResolvedValue({ applied: false, reason: "not_requested", retryable: false });
    const apply = spyOn(desktop, "applyCodexConfigInjection").mockImplementation(async () => { throw new Error("Native apply forbidden"); });
    const runtimeRead = spyOn(runtime, "getCodexRuntimeSnapshot").mockReturnValue({ runtime: { command: "codex", version: null, source: "fallback" }, failures: [] });
    const schedule = spyOn(quota, "runCodexQuotaAutoRefresh").mockImplementation(async () => { throw new Error("Scheduling forbidden"); });
    const config: import("../../src/types").OcxConfig = {
      port: 14501, defaultProvider: "p", providers: { p: { adapter: "openai-chat", baseUrl: "https://never.invalid/v1", apiKey: "fixture" } },
      memoryModels: { extract: { model: "p/old" }, consolidation: { model: "p/old2", reasoningEffort: "high" } },
      compactionRouting: { model: "p/old", triggers: ["auto"], sourceModels: ["old/*"] },
      showCodexCredits: true,
    };
    const otherKey = key === "memoryModels" ? "compactionRouting" : "memoryModels";
    const otherBefore = structuredClone(config[otherKey]);
    let catalogCalls = 0, requests = 0;
    configModule.saveConfig(config);
    const deps: RuntimeApiDeps = {
      baseUrl: "http://127.0.0.1:14501",
      fetchImpl: (async (input, init) => {
        requests++;
        expect(init?.redirect).toBe("error");
        const req = new Request(String(input), init);
        expect(new URL(req.url).pathname).toBe("/api/settings");
        const response = await handleConfigRoutes({ req, url: new URL(req.url), config,
          deps: { getCachedStartupHealth: async () => startupHealthFixture(), saveConfigPreservingClaudeCode: configModule.saveConfig },
          version: "fixture", trustedLoopbackIngress: true, guiSessionIssuance: null,
          convergeCodexCatalog: async () => { catalogCalls++; throw new Error("Catalog sync forbidden"); },
          syncClaudeAgentDefsBestEffort: async () => { throw new Error("Claude sync forbidden"); },
        });
        if (!response) throw new Error("No settings handler");
        return response;
      }) as typeof fetch,
    };
    try {
      expect(await handleAgentSettingsCommand(sub, ["set", ...args, "--json"], deps)).toBe(0);
      expect(config[key]).toEqual(value);
      expect(configModule.loadConfig()[key]).toEqual(value);
      expect(config[otherKey]).toEqual(otherBefore);
      expect(config.showCodexCredits).toBe(true);
      expect(result()).toEqual({ [key]: value, catalogRefreshPending: false });
      output.mockClear();
      expect(await handleAgentSettingsCommand(sub, ["show", "--json"], deps)).toBe(0);
      expect(result()).toEqual({ [key]: value });
      output.mockClear();
      expect(await handleAgentSettingsCommand(sub, ["clear", "--json"], deps)).toBe(0);
      expect(config[key]).toBeUndefined();
      expect(configModule.loadConfig()[key]).toBeUndefined();
      expect(config[otherKey]).toEqual(otherBefore);
      expect(result()).toEqual({ [key]: null, catalogRefreshPending: false });
      expect(requests).toBe(3); expect(catalogCalls).toBe(0);
      expect(apply).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
    } finally { observe.mockRestore(); apply.mockRestore(); runtimeRead.mockRestore(); schedule.mockRestore(); }
  });
});
