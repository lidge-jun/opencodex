import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleModelsOrderCommand } from "../../src/cli/models-order";
import * as cli from "../../src/cli/model-picker-ordering";
import * as gui from "../../gui/src/model-picker-order";
import { handleSubagentModelRoutes } from "../../src/server/management/subagent-model-routes";
import type { OcxConfig } from "../../src/types";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const committed = { status: "committed", changed: false, degraded: false, notices: [] };
const candidates = ["beta/z", "alpha/b", "alpha/a"];
const identities = candidates.map(namespaced => ({ provider: namespaced.split("/")[0]!, id: namespaced.split("/")[1]!, namespaced }));
const initial = { pickerAvailable: candidates, pickerOrder: [], pickerOrderMode: null, chosen: [] };
let home: TempHome, savedToken: string | undefined;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-models-order-");
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
type Options = { settings?: unknown; models?: unknown; freshSettings?: unknown; freshModels?: unknown; usage?: unknown; receipt?: unknown; http?: number; refresh?: unknown };
function fixture(options: Options = {}) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let resolutions = 0, settingsReads = 0, modelsReads = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 14500 + ++resolutions, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url: String(input), method: init?.method ?? "GET", ...(body === undefined ? {} : { body }) });
      if (options.http) return Response.json({ error: { message: "private server text" } }, { status: options.http });
      if (url.pathname === "/api/subagent-models" && init?.method === "PUT") {
        return Response.json(Object.hasOwn(options, "receipt") ? options.receipt : {
          ok: true, pickerOrder: body.pickerOrder ?? [], pickerOrderMode: body.pickerOrderMode,
          applied: [], force: null, catalogRefresh: Object.hasOwn(options, "refresh") ? options.refresh : committed,
        });
      }
      if (url.pathname === "/api/subagent-models") return Response.json(
        ++settingsReads > 1 && Object.hasOwn(options, "freshSettings") ? options.freshSettings
          : Object.hasOwn(options, "settings") ? options.settings : initial);
      if (url.pathname === "/api/models") return Response.json(
        ++modelsReads > 1 && Object.hasOwn(options, "freshModels") ? options.freshModels
          : Object.hasOwn(options, "models") ? options.models : identities);
      if (url.pathname === "/api/usage") return Response.json(options.usage ?? { models: [] });
      throw new Error("Unexpected fixture request");
    }) as typeof fetch,
  };
  return { deps, calls, resolutions: () => resolutions, writes: () => calls.filter(row => row.method === "PUT") };
}
function result(): Record<string, unknown> { return JSON.parse(String(output.mock.calls[0]?.[0])); }

describe("pure picker projections", () => {
  test("known sort results and requested identity usage, including unranked candidates", () => {
    expect(cli.modelPickerOrder("default", candidates)).toBeNull();
    expect(cli.modelPickerOrder("alphabetical", ["z/a", "a/z", "b/a"])).toEqual(["b/a", "z/a", "a/z"]);
    expect(cli.modelPickerOrder("provider", ["z/a", "a/z", "b/a"])).toEqual(["a/z", "b/a", "z/a"]);
    expect(cli.modelPickerOrder("most-used", candidates, [
      { provider: "beta", model: "z", requests: 7, resolvedModel: "alpha/a" },
      { provider: "alpha", model: "b", requests: 2 },
    ], identities)).toEqual(["beta/z", "alpha/b", "alpha/a"]);
  });
  test("raw slash identities and public spellings use observed mapping", () => {
    const ids = [{ provider: "p", id: "org/a", namespaced: "p/org-a" }, { provider: "p", id: "org-a", namespaced: "p/encoded" }];
    const models = ["p/org-a", "p/encoded"];
    expect(cli.normalizePickerIds(["p/org-a", "p/org/a", "native"], models, ids)).toEqual(["p/org-a"]);
    expect(cli.modelPickerOrder("most-used", models, [{ provider: "p", model: "org-a", requests: 10 }], ids)).toEqual(["p/encoded", "p/org-a"]);
    expect(cli.pickerIdentityCoverage(models, ids)).toBe(true);
  });
  test("featured prefix uses last occurrence and exact canonical rank", () => {
    const ids = [{ provider: "p", id: "raw/a", namespaced: "p/a" }, { provider: "p", id: "raw/b", namespaced: "p/b" }];
    const settings = { pickerAvailable: ["p/a", "p/b"], pickerOrder: [], pickerOrderMode: null,
      chosen: ["p/a", "p/b", "p/a", "p/raw/b"] };
    expect(cli.customPickerRows(settings, ids)?.fixed).toEqual(["p/b", "p/a"]);
  });
  test("GUI conformance: modes, manual normalization, fixed prefix and identity ambiguity", () => {
    const variants: cli.PickerModelIdentity[][] = [identities,
      [...identities, { provider: "alpha", id: "different", namespaced: "alpha/a" }],
      [{ provider: "p", id: "a/b", namespaced: "p/a-b" }, { provider: "p", id: "a-b", namespaced: "p/a-b-encoded" }],
    ];
    for (const rows of variants) {
      const available = rows.map(row => row.namespaced);
      const usage = rows.map((row, index) => ({ provider: row.provider, model: row.id, requests: index + 1 }));
      for (const mode of ["default", "alphabetical", "provider", "most-used"] as const) {
        expect(cli.modelPickerOrder(mode, available, usage, rows)).toEqual(gui.modelPickerOrder(mode, available, usage, rows));
      }
      const tokens = [...available, "native", ...rows.map(row => `${row.provider}/${row.id}`)];
      expect(cli.normalizePickerIds(tokens, available, rows)).toEqual(gui.normalizePickerIds(tokens, available, rows));
      expect(cli.pickerIdentityCoverage(available, rows)).toEqual(gui.pickerIdentityCoverage(available, rows));
      for (const pickerOrder of [[], ["native", ...available], available]) {
        const settings = { pickerAvailable: available, pickerOrder, pickerOrderMode: null, chosen: [...available].reverse() };
        expect(cli.customPickerRows(settings, rows)).toEqual(gui.customPickerRows(settings, rows));
      }
    }
  });
});

describe("models order commands", () => {
  for (const args of [[], ["wat"], ["status", "--mode", "default"], ["reset", "--models", "a/b"],
    ["set"], ["set", "--models=a/b", "--mode=default"], ["set", "--mode=custom"],
    ["set", "--models=a/b,,c/d"], ["set", "--models=a/b,a/b"], ["set", "--mode"],
    ["set", "--mode=provider", "--mode=provider"], ["status", "--json", "--json"], ["reset", "--force"]]) {
    test(`rejects syntax before target discovery: ${args.join(" ")}`, async () => {
      const f = fixture();
      expect(await handleModelsOrderCommand(args, f.deps)).toBe(2);
      expect(f.resolutions()).toBe(0); expect(f.calls).toEqual([]); expect(output).not.toHaveBeenCalled();
    });
  }
  test("status preserves native saved ids and known chosen state, projects only domain fields", async () => {
    const settings = { ...initial, pickerOrder: ["native", "beta/z"], chosen: ["native"], secret: "private" };
    const f = fixture({ settings });
    expect(await handleModelsOrderCommand(["status", "--json"], f.deps)).toBe(0);
    expect(result()).toEqual({ ...initial, pickerOrder: ["native", "beta/z"], chosen: ["native"] });
    expect(f.calls).toHaveLength(1); expect(f.resolutions()).toBe(1);
  });
  test("unknown chosen remains unknown in status", async () => {
    const { chosen: _, ...settings } = initial;
    expect(await handleModelsOrderCommand(["status"], fixture({ settings }).deps)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("Featured: unknown");
  });
  for (const args of [["reset"], ["set", "--mode=default"]]) test(`two-field reset: ${args.join(" ")}`, async () => {
    const f = fixture();
    expect(await handleModelsOrderCommand([...args, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:14501/api/subagent-models", method: "PUT",
      body: { pickerOrder: null, pickerOrderMode: null } }]);
    expect(result().applied).toEqual([]);
  });
  test("manual canonical precedence and observed legacy normalization preserve every token", async () => {
    const models = [{ provider: "p", id: "org/a", namespaced: "p/org-a" }, { provider: "p", id: "org-a", namespaced: "p/encoded" }];
    const settings = { pickerAvailable: ["p/org-a", "p/encoded"], pickerOrder: [], pickerOrderMode: null, chosen: [] };
    const f = fixture({ models, settings });
    expect(await handleModelsOrderCommand(["set", "--models=p/org/a,p/encoded", "--json"], f.deps)).toBe(0);
    expect(f.writes()[0]?.body?.pickerOrder).toEqual(["p/org-a", "p/encoded"]);
    const duplicate = fixture({ models, settings });
    expect(await handleModelsOrderCommand(["set", "--models=p/org/a,p/org-a"], duplicate.deps)).toBe(2);
    expect(duplicate.writes()).toEqual([]);
  });
  for (const settings of [null, {}, { ...initial, chosen: null }, { ...initial, pickerAvailable: ["native"] },
    { ...initial, pickerAvailable: ["alpha/a", "alpha/a"] }, { ...initial, pickerOrderMode: "custom" }]) {
    test(`malformed settings refuse status ${JSON.stringify(settings)}`, async () => {
      const f = fixture({ settings }); expect(await handleModelsOrderCommand(["status", "--json"], f.deps)).toBe(1);
      expect(output).not.toHaveBeenCalled(); expect(f.writes()).toEqual([]);
    });
  }
  for (const models of [null, {}, [{ provider: "alpha", id: "a" }], [{ provider: "alpha", id: "", namespaced: "alpha/a" }]]) {
    test(`malformed identities refuse writes ${JSON.stringify(models)}`, async () => {
      const f = fixture({ models }); expect(await handleModelsOrderCommand(["set", "--mode=provider"], f.deps)).toBe(1);
      expect(output).not.toHaveBeenCalled(); expect(f.writes()).toEqual([]);
    });
  }
  test("manual permutation checks both snapshots on a single target and never writes featured state", async () => {
    const f = fixture({ settings: { ...initial, chosen: ["beta/z"] } });
    expect(await handleModelsOrderCommand(["set", "--models=beta/z,alpha/a,alpha/b", "--json"], f.deps)).toBe(0);
    expect(f.resolutions()).toBe(1);
    expect(f.calls.map(row => new URL(row.url).pathname)).toEqual([
      "/api/subagent-models", "/api/models", "/api/subagent-models", "/api/models", "/api/subagent-models",
    ]);
    expect(f.writes()[0]?.body).toEqual({ pickerOrder: ["beta/z", "alpha/a", "alpha/b"], pickerOrderMode: null });
  });
  for (const mode of ["alphabetical", "provider", "most-used"]) test(`preset ${mode} does not prepend featured`, async () => {
    const f = fixture({ settings: { ...initial, chosen: ["beta/z"] } });
    expect(await handleModelsOrderCommand(["set", `--mode=${mode}`, "--json"], f.deps)).toBe(0);
    expect(f.writes()[0]?.body).toEqual({ pickerOrder: ["alpha/a", "alpha/b", "beta/z"], pickerOrderMode: mode });
  });
  test("most-used queries all/all and attributes requested identity instead of resolved model", async () => {
    const f = fixture({ usage: { models: [{ provider: "beta", model: "z", requests: 10, resolvedModel: "alpha/a" }] } });
    expect(await handleModelsOrderCommand(["set", "--mode=most-used"], f.deps)).toBe(0);
    expect(f.calls.find(row => row.url.includes("/api/usage"))?.url).toBe("http://127.0.0.1:14501/api/usage?range=all&surface=all");
    expect(f.writes()[0]?.body?.pickerOrder).toEqual(["beta/z", "alpha/a", "alpha/b"]);
  });
  for (const usage of [null, {}, { models: [] , usageIncomplete: true }, { models: [], usageIncomplete: "false" },
    { models: [{ provider: "alpha", model: "a", requests: -1 }] }, { models: [{ provider: "alpha", model: "a", requests: "1" }] }]) {
    test(`refuses incomplete/malformed usage ${JSON.stringify(usage)}`, async () => {
      const f = fixture({ usage: usage === null ? { models: null } : usage });
      expect(await handleModelsOrderCommand(["set", "--mode=most-used"], f.deps)).toBe(1);
      expect(f.writes()).toEqual([]);
    });
  }
  for (const args of [["set", "--models=alpha/a,alpha/b,beta/z"], ["set", "--mode=provider"]]) {
    for (const settings of [{ ...initial, pickerOrder: ["native", "alpha/a"] }, { ...initial, pickerAvailable: [] }]) {
      test(`refuses native/empty replacement ${JSON.stringify([args, settings.pickerAvailable])}`, async () => {
        const f = fixture({ settings });
        expect(await handleModelsOrderCommand(args, f.deps)).toBe(2); expect(f.writes()).toEqual([]);
      });
    }
  }
  for (const csv of ["alpha/a,alpha/b", "alpha/a,alpha/b,unknown/x", "alpha/a,alpha/b,beta/z,alpha/c"]) {
    test(`refuses incomplete manual permutation ${csv}`, async () => {
      const f = fixture(); expect(await handleModelsOrderCommand(["set", `--models=${csv}`], f.deps)).toBe(2);
      expect(f.writes()).toEqual([]);
    });
  }
  test("refuses changed featured prefix", async () => {
    const f = fixture({ settings: { ...initial, chosen: ["beta/z"] } });
    expect(await handleModelsOrderCommand(["set", "--models=alpha/a,alpha/b,beta/z"], f.deps)).toBe(2);
    expect(f.writes()).toEqual([]);
  });
  test("refuses unknown chosen and identity ambiguity", async () => {
    const { chosen: _, ...settings } = initial;
    for (const options of [{ settings }, { models: identities.slice(1) },
      { models: [...identities, { provider: "alpha", id: "collision", namespaced: "alpha/a" }] }]) {
      const f = fixture(options);
      expect(await handleModelsOrderCommand(["set", "--models=alpha/a,alpha/b,beta/z"], f.deps)).toBe(2);
      expect(f.writes()).toEqual([]);
    }
  });
  for (const options of [
    { freshSettings: { ...initial, chosen: ["alpha/a"] } },
    { freshSettings: { ...initial, pickerOrder: ["beta/z"] } },
    { freshSettings: { ...initial, pickerOrderMode: "provider" } },
    { freshSettings: { ...initial, pickerAvailable: [...candidates].reverse() } },
    { freshModels: [...identities].reverse() },
    { freshModels: identities.map(row => ({ ...row, id: `${row.id}-changed` })) },
  ]) test(`refuses observational drift ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    expect(await handleModelsOrderCommand(["set", "--models=alpha/a,alpha/b,beta/z"], f.deps)).toBe(5);
    expect(f.writes()).toEqual([]);
  });
  for (const refresh of [null, {}, { status: "committed" }]) test(`refuses malformed refresh ${JSON.stringify(refresh)}`, async () => {
    const f = fixture({ refresh }); expect(await handleModelsOrderCommand(["reset", "--json"], f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled();
  });
  for (const refresh of [{ ...committed, degraded: true }, { status: "skipped", reason: "busy", retryable: true },
    { status: "failed", reason: "disk", phase: "commit", partialWrite: true, retryable: false }]) {
    test(`preserves saved partial receipt ${refresh.status}`, async () => {
      expect(await handleModelsOrderCommand(["reset", "--json"], fixture({ refresh }).deps)).toBe(1);
      expect(result()).toMatchObject({ ok: true, pickerOrder: [], catalogRefresh: refresh });
    });
  }
  for (const receipt of [null, {}, { ok: true, pickerOrder: [], pickerOrderMode: null, applied: "yes", force: null, catalogRefresh: committed },
    { ok: true, pickerOrder: ["unexpected/model"], pickerOrderMode: null, applied: [], force: null, catalogRefresh: committed }]) {
    test(`refuses malformed save DTO ${JSON.stringify(receipt)}`, async () => {
      expect(await handleModelsOrderCommand(["reset", "--json"], fixture({ receipt }).deps)).toBe(1);
      expect(output).not.toHaveBeenCalled();
    });
  }
  for (const [http, exit] of [[404, 4], [409, 5], [503, 1], [400, 1]]) test(`numeric HTTP ${http}`, async () => {
    const f = fixture({ http }); expect(await handleModelsOrderCommand(["reset", "--json"], f.deps)).toBe(exit!);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private server text");
  });
});


describe("picker save through the actual settings handler", () => {
  for (const reset of [false, true]) test(`preserves featured/force and saves picker only (reset=${reset})`, async () => {
    const config: OcxConfig = { port: 10100, defaultProvider: "alpha", modelCacheTtlMs: 60_000,
      providers: { alpha: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["a", "b"], liveModels: false } },
      subagentModels: ["alpha/b"], claudeCode: { subagentModelForce: "alpha/b" }, modelPickerOrder: ["alpha/b", "alpha/a"] };
    const persisted: OcxConfig[] = [];
    const rows = [{ provider: "alpha", id: "a", namespaced: "alpha/a" }, { provider: "alpha", id: "b", namespaced: "alpha/b" }];
    const settings = { pickerAvailable: ["alpha/a", "alpha/b"], pickerOrder: config.modelPickerOrder, pickerOrderMode: null, chosen: ["alpha/b"] };
    const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:14501", fetchImpl: (async (input, init) => {
      if (init?.method !== "PUT") return Response.json(String(input).endsWith("/api/models") ? rows : settings);
      const req = new Request(String(input), init);
      const response = await handleSubagentModelRoutes({ req, url: new URL(req.url), config,
        deps: { saveConfigPreservingClaudeCode: saved => { persisted.push(structuredClone(saved)); },
          fetchAllModels: async () => rows },
        convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }),
        syncClaudeAgentDefsBestEffort: async () => { throw new Error("Must not synchronize featured state"); },
      }, async () => { throw new Error("Must not apply Desktop"); });
      if (!response) throw new Error("Handler did not match");
      return response;
    }) as typeof fetch };
    expect(await handleModelsOrderCommand(reset ? ["reset", "--json"] : ["set", "--models=alpha/b,alpha/a", "--json"], deps)).toBe(0);
    expect(persisted).toHaveLength(1);
    expect(config.subagentModels).toEqual(["alpha/b"]);
    expect(config.claudeCode?.subagentModelForce).toBe("alpha/b");
    expect(config.modelPickerOrder).toEqual(reset ? undefined : ["alpha/b", "alpha/a"]);
    expect(result()).toMatchObject({ applied: ["alpha/b"], force: "alpha/b", pickerOrder: reset ? [] : ["alpha/b", "alpha/a"] });
  });
});
