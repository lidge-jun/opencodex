import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleModelsCustomRuntimeCommand as command } from "../../src/cli/models-custom-runtime";
import { parseReasoningArgs } from "../../src/cli/models-custom-input";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadConfig, saveConfig } from "../../src/config";
import type { CatalogDisposition } from "../../src/codex/convergence-types";

const PRIVATE = "synthetic-private-do-not-print";
const committed = { status: "committed", changed: true, degraded: false, notices: [] };
const stored = { id: "stored-fixture-id", provider: "acme", modelId: "model", addedAt: "2026-01-01T00:00:00.000Z" };
let home: TempHome;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
let realHandler = false;

beforeEach(() => {
  home = createTempHome("ocx-custom-cli-");
  writeFileSync(home.path("config.json"), "local-config-sentinel");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  realHandler = false;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network"); });
});
afterEach(() => {
  if (!realHandler) expect(readFileSync(home.path("config.json"), "utf8")).toBe("local-config-sentinel");
  expect(network).not.toHaveBeenCalled();
  expect(JSON.stringify([...output.mock.calls, ...errors.mock.calls])).not.toContain(PRIVATE);
  output.mockRestore(); errors.mockRestore(); network.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});

function fixture(options: { roster?: unknown; receipt?: unknown; status?: number; malformed?: boolean; fail?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown; redirect?: RequestRedirect }> = [];
  let probes = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ port: ++probes === 1 ? 32101 : 32102, hostname: "127.0.0.1", pid: 1, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      const method = init?.method ?? "GET";
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      calls.push({ url: String(input), method, redirect: init?.redirect,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      if (options.fail) throw new Error(PRIVATE);
      if (options.malformed) return new Response(`invalid JSON ${PRIVATE}`);
      return Response.json(method === "GET" ? (options.roster ?? [stored])
        : options.receipt ?? (method === "POST" ? { ...stored, catalogRefresh: committed } : { ok: true, catalogRefresh: committed }),
      { status: options.status ?? (method === "POST" ? 201 : 200) });
    }) as typeof fetch,
  };
  return { deps, calls, probes: () => probes };
}
function printed(): Record<string, unknown> { return JSON.parse(output.mock.calls[0]![0]); }

describe("live custom model creation", () => {
  test("one pinned POST with existing metadata and typed 201 receipt", async () => {
    const metadata = { displayName: "Demo", contextWindow: 32768, inputModalities: ["text", "image"], reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" };
    const f = fixture({ receipt: { ...stored, ...metadata, catalogRefresh: committed, privateField: PRIVATE } });
    expect(await command("add", ["acme", "model", "--display-name", "Demo", "--context-window=32768", "--modalities", "text,image,text", "--reasoning-efforts", "high,low", "--default-reasoning-effort", "high", "--json"], f.deps)).toBe(0);
    expect(f.probes()).toBe(1);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:32101/api/custom-models", method: "POST", redirect: "error", body: { provider: "acme", modelId: "model", ...metadata } }]);
    expect(printed()).toEqual({ ...stored, ...metadata, catalogRefresh: committed });
  });

  for (const [args, expected] of [
    [[], undefined], [["--reasoning-efforts", "-"], undefined],
    [["--reasoning-efforts", ""], []], [["--reasoning-efforts="], []],
  ] as const) test(`preserves reasoning omission or empty override: ${JSON.stringify(args)}`, async () => {
    const f = fixture({ receipt: { ...stored, ...(expected === undefined ? {} : { reasoningEfforts: expected }), catalogRefresh: committed } });
    expect(await command("add", ["acme", "model", ...args, "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ provider: "acme", modelId: "model", ...(expected === undefined ? {} : { reasoningEfforts: expected }) });
  });

  test("preserves the pure legacy reasoning result contract", () => {
    expect(parseReasoningArgs("high,low,high", "low")).toEqual({ reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" });
    expect(parseReasoningArgs("", undefined)).toEqual({ reasoningEfforts: [], defaultReasoningEffort: undefined });
    expect(parseReasoningArgs("-", "-")).toEqual({ reasoningEfforts: undefined, defaultReasoningEffort: undefined });
    expect(parseReasoningArgs("low,,high", undefined).error).toBeDefined();
  });

  for (const extra of [
    ["--context-window", "0"], ["--context-window", "-1"], ["--context-window", "1.5"],
    ["--context-window", "9007199254740992"], ["--context-window", "NaN"],
    ["--context-window", "2", "--context-window=3"], ["--modalities", "text,,audio"],
    ["--display-name", "bad/name"], ["--reasoning-efforts", PRIVATE],
    ["--reasoning-efforts", "low", "--default-reasoning-effort", "high"],
    ["--reasoning-efforts", "", "--default-reasoning-effort", "low"],
    ["--reasoning-efforts=", "--reasoning-efforts", "low"],
    ["--file", PRIVATE], ["--json", "--json"], ["--yes"], ["--live"],
  ]) test(`invalid or conflicting input refuses before discovery: ${extra[0]} ${extra[1]}`, async () => {
    const f = fixture();
    expect(await command("add", ["acme", "model", ...extra], f.deps)).toBe(2);
    expect(f.probes()).toBe(0); expect(f.calls).toHaveLength(0); expect(output).not.toHaveBeenCalled();
  });

  for (const receipt of [
    [], {}, { ...stored, id: "" }, { ...stored, provider: "other" }, { ...stored, modelId: "other" },
    { ...stored, addedAt: "bad" }, { ...stored, inputModalities: ["video"] },
    { ...stored, reasoningEfforts: ["nonsense"] }, { ...stored, defaultReasoningEffort: "low" },
    { ...stored, contextWindow: 1.5 }, { ...stored, displayName: "bad/name" },
  ]) test(`malformed model receipt refuses: ${JSON.stringify(receipt)}`, async () => {
    const f = fixture({ receipt: { ...receipt, catalogRefresh: committed, privateField: PRIVATE } });
    expect(await command("add", ["acme", "model", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
  });
});

describe("live custom model exact-or-refuse removal", () => {
  for (const selector of ["stored-fixture-id", "acme/model"]) test(`removes complete identity ${selector}`, async () => {
    const f = fixture();
    expect(await command("remove", [selector, "--yes", "--json"], f.deps)).toBe(0);
    expect(f.probes()).toBe(1);
    expect(f.calls).toEqual([
      { url: "http://127.0.0.1:32101/api/custom-models", method: "GET", redirect: "error" },
      { url: "http://127.0.0.1:32101/api/custom-models/stored-fixture-id", method: "DELETE", redirect: "error" },
    ]);
    expect(printed()).toEqual({ ok: true, id: stored.id, provider: "acme", modelId: "model", catalogRefresh: committed });
  });
  test("addresses non-UUID stored IDs with encoded reserved characters", async () => {
    const f = fixture({ roster: [{ ...stored, id: "legacy/id?value#suffix" }] });
    expect(await command("remove", ["legacy/id?value#suffix", "--yes"], f.deps)).toBe(0);
    expect(f.calls[1]?.url).toBe("http://127.0.0.1:32101/api/custom-models/legacy%2Fid%3Fvalue%23suffix");
  });
  for (const selector of ["acme/vendor/model", "acme/vendor-model"]) test(`slash/dash collision refuses ${selector}`, async () => {
    const f = fixture({ roster: [{ ...stored, modelId: "vendor/model" }, { ...stored, id: "second", modelId: "vendor-model" }] });
    expect(await command("remove", [selector, "--yes"], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
  });
  test("complete provider roster distinguishes a self-namespaced model", async () => {
    const f = fixture({ roster: [{ ...stored, modelId: "acme/turbo" }, { ...stored, id: "second", modelId: "turbo" }] });
    expect(await command("remove", ["acme/turbo", "--yes"], f.deps)).toBe(0);
    expect(f.calls[1]?.url).toEndWith("/stored-fixture-id");
  });
  test("self-namespaced encoded collision refuses even the exact spelling", async () => {
    const f = fixture({ roster: [{ ...stored, modelId: "acme/turbo" }, { ...stored, id: "second", modelId: "acme-turbo" }] });
    expect(await command("remove", ["acme/turbo", "--yes"], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(1);
  });
  for (const roster of [null, {}, [stored, stored], [stored, {}], [stored, { ...stored, id: "second", provider: "bad/name" }]]) {
    test(`malformed or duplicate complete roster refuses: ${JSON.stringify(roster)}`, async () => {
      const f = fixture({ roster });
      // null is intentionally supplied via the fetch boundary, not the fixture default.
      if (roster === null) f.deps.fetchImpl = (async () => Response.json(null)) as typeof fetch;
      expect(await command("remove", [stored.id, "--yes"], f.deps)).toBe(1);
      expect(f.calls.every(call => call.method === "GET")).toBe(true);
    });
  }
  for (const target of ["unknown", "stored-fixt", "Display name"]) test(`does not guess ${target}`, async () => {
    const f = fixture({ roster: [{ ...stored, displayName: "Display name" }] });
    expect(await command("remove", [target, "--yes"], f.deps)).toBe(4);
    expect(f.calls).toHaveLength(1);
  });
  for (const args of [[stored.id], [stored.id, "--yes", "--yes"], [stored.id, "--yes", "--json", "--json"], [stored.id, "--yes", "--file", PRIVATE]]) {
    test(`confirmation and syntax checked before discovery: ${args.join(" ")}`, async () => {
      const f = fixture();
      expect(await command("remove", args, f.deps)).toBe(2);
      expect(f.probes()).toBe(0); expect(f.calls).toHaveLength(0);
    });
  }
  test("dot-segment stored IDs cannot select a different route", async () => {
    const f = fixture({ roster: [{ ...stored, id: ".." }] });
    expect(await command("remove", ["..", "--yes"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
});

describe("catalog and transport outcomes", () => {
  for (const sub of ["add", "remove"] as const) {
    const args = sub === "add" ? ["acme", "model", "--json"] : [stored.id, "--yes", "--json"];
    for (const refresh of [
      { status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: true },
      { status: "skipped", reason: "busy", retryable: true },
      { ...committed, degraded: true, notices: ["provider-network"] },
    ]) test(`${sub} preserves saved partial ${refresh.status} with nonzero result`, async () => {
      const f = fixture({ receipt: { ...(sub === "add" ? stored : { ok: true }), catalogRefresh: refresh } });
      expect(await command(sub, args, f.deps)).toBe(1);
      expect(printed().catalogRefresh).toEqual(refresh);
      expect(f.calls).toHaveLength(sub === "add" ? 1 : 2);
    });
    for (const refresh of [undefined, null, {}, { status: "committed" }]) test(`${sub} missing/malformed catalog is not success: ${JSON.stringify(refresh)}`, async () => {
      const f = fixture({ receipt: { ...(sub === "add" ? stored : { ok: true }), catalogRefresh: refresh } });
      expect(await command(sub, args, f.deps)).toBe(1); expect(output).not.toHaveBeenCalled();
    });
    for (const [status, code] of [[400, 1], [404, 4], [409, 5], [503, 1]]) test(`${sub} returns HTTP ${status} without retry`, async () => {
      const f = fixture();
      const original = f.deps.fetchImpl!;
      f.deps.fetchImpl = (async (url, init) => {
        const result = await original(url, init);
        return (init?.method ?? "GET") === "GET" ? result : Response.json({ error: { code: PRIVATE, message: PRIVATE }, issues: [PRIVATE] }, { status });
      }) as typeof fetch;
      expect(await command(sub, args, f.deps)).toBe(code);
      expect(f.calls).toHaveLength(sub === "add" ? 1 : 2); expect(output).not.toHaveBeenCalled();
    });
    for (const options of [{ malformed: true }, { fail: true }]) test(`${sub} invalid JSON/network error is safe`, async () => {
      const f = fixture(options);
      expect(await command(sub, args, f.deps)).toBe(1); expect(output).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(1);
    });
  }
});

describe("isolated real custom model handlers", () => {
  function realFixture(refresh?: CatalogDisposition) {
    realHandler = true;
    saveConfig({ defaultProvider: "acme", providers: { acme: {
      adapter: "openai-chat", baseUrl: "https://acme.example.test/v1", liveModels: false, models: ["base"],
    } } });
    let refreshes = 0;
    const calls: string[] = [];
    const deps: RuntimeApiDeps = { baseUrl: "http://localhost", fetchImpl: (async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      const req = new ManagementRequest(String(input), init);
      const response = await handleManagementAPI(req, new URL(req.url), loadConfig(), {
        createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshes++; }, refresh),
      });
      if (!response) throw new Error("Unhandled isolated management request");
      return response;
    }) as typeof fetch };
    return { deps, calls, refreshes: () => refreshes };
  }
  test("POST persists empty ladder and DELETE removes exact stored identity", async () => {
    const f = realFixture();
    expect(await command("add", ["acme", "vendor/model", "--reasoning-efforts", "", "--json"], f.deps)).toBe(0);
    const entries = loadConfig().customModels!;
    expect(entries).toHaveLength(1); expect(entries[0]?.reasoningEfforts).toEqual([]);
    expect(printed().id).toBe(entries[0]?.id);
    expect(await command("remove", ["acme/vendor/model", "--yes", "--json"], f.deps)).toBe(0);
    expect(loadConfig().customModels).toBeUndefined(); expect(f.refreshes()).toBe(2);
    expect(f.calls).toEqual(["POST /api/custom-models", "GET /api/custom-models", `DELETE /api/custom-models/${entries[0]!.id}`]);
  });
  test("server collision remains conflict with no automatic retry or second write", async () => {
    const f = realFixture();
    expect(await command("add", ["acme", "vendor/model", "--json"], f.deps)).toBe(0);
    expect(await command("add", ["acme", "vendor-model", "--json"], f.deps)).toBe(5);
    expect(loadConfig().customModels).toHaveLength(1); expect(f.calls).toHaveLength(2); expect(f.refreshes()).toBe(1);
  });
  test("real handler persists despite catalog failure and CLI reports saved receipt", async () => {
    const refresh: CatalogDisposition = { status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: true };
    const f = realFixture(refresh);
    expect(await command("add", ["acme", "model", "--json"], f.deps)).toBe(1);
    expect(loadConfig().customModels).toHaveLength(1); expect(printed().catalogRefresh).toEqual(refresh);
    expect(f.refreshes()).toBe(1);
  });
});
