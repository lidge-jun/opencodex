import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleModelsDisplayNameCommand } from "../../src/cli/models-order";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { handleModelRoutes } from "../../src/server/management/model-routes";
import { clearModelCache } from "../../src/codex/model-cache";
import type { CatalogDisposition } from "../../src/codex/convergence-types";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const committed: CatalogDisposition = { status: "committed", changed: true, degraded: false, notices: [] };
const failed: CatalogDisposition = { status: "failed", reason: "disk", phase: "commit", partialWrite: true, retryable: false };
let home: TempHome, token: string | undefined;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-display-name-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  output.mockRestore(); errors.mockRestore(); network.mockRestore(); clearModelCache();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
function fixture(options: { receipt?: unknown; status?: number; refresh?: unknown; throwTransport?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let resolutions = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 14600 + ++resolutions, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      expect(init?.method).toBe("PUT"); expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), body });
      if (options.throwTransport) throw new Error("private transport detail");
      return Response.json(Object.hasOwn(options, "receipt") ? options.receipt : {
        ok: true, provider: "fixture", modelId: body.modelId,
        displayName: body.displayName ?? "fixture/raw-id", displayNameOverride: body.displayName,
        displayNameSource: body.displayName === null ? "fallback" : "operator",
        catalogRefresh: Object.hasOwn(options, "refresh") ? options.refresh : committed,
        private: "must not print",
      }, { status: options.status ?? 200 });
    }) as typeof fetch,
  };
  return { deps, calls, resolutions: () => resolutions };
}
function result(): Record<string, unknown> { return JSON.parse(String(output.mock.calls[0]?.[0])); }

describe("model display name command", () => {
  for (const args of [[], ["fixture/model"], ["fixture/model", "--set", "Name", "--clear"],
    ["fixture/model", "--set=Name", "--set=Other"], ["fixture/model", "--clear", "--clear"],
    ["fixture/model", "--clear", "--json", "--json"], ["model", "--clear"], ["fixture/", "--clear"],
    ["__proto__/model", "--clear"], ["fixture/raw\nmodel", "--clear"], ["fixture/model", "--set", " "],
    ["fixture/model", "--set", "Bad/Name"], ["fixture/model", "--set", "Bad\u001bName"],
    ["fixture/model", "--set", "x".repeat(1000)], ["fixture/model", "--set"], ["fixture/model", "--clear", "--unknown"]]) {
    test(`refuses syntax before discovery ${JSON.stringify(args)}`, async () => {
      const f = fixture(); expect(await handleModelsDisplayNameCommand(args, f.deps)).toBe(2);
      expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0); expect(output).not.toHaveBeenCalled();
    });
  }
  test("splits first slash, retains raw slashes/percent and emits validated projection", async () => {
    const f = fixture();
    expect(await handleModelsDisplayNameCommand(["fixture/org/raw%2Fmodel", "--set", "  My Model  ", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:14601/api/providers/fixture/model-display-names",
      body: { modelId: "org/raw%2Fmodel", displayName: "My Model" } }]);
    expect(f.resolutions()).toBe(1);
    expect(result()).toEqual({ ok: true, provider: "fixture", modelId: "org/raw%2Fmodel", displayName: "My Model",
      displayNameOverride: "My Model", displayNameSource: "operator", catalogRefresh: committed });
  });
  test("clear sends null and retains effective fallback label", async () => {
    const f = fixture(); expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear", "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ modelId: "raw-id", displayName: null });
    expect(result()).toMatchObject({ displayName: "fixture/raw-id", displayNameOverride: null, displayNameSource: "fallback" });
  });
  test("saved 503 returns receipt and numeric one without retry or raw error text", async () => {
    const f = fixture({ status: 503, receipt: { saved: true, provider: "fixture", modelId: "raw-id",
      displayNameOverride: "Label", catalogRefresh: failed, error: "private backend detail" } });
    expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--set=Label", "--json"], f.deps)).toBe(1);
    expect(result()).toEqual({ saved: true, provider: "fixture", modelId: "raw-id", displayNameOverride: "Label", catalogRefresh: failed });
    expect(f.calls).toHaveLength(1); expect(errors).not.toHaveBeenCalled();
  });
  for (const refresh of [null, {}, { status: "committed" }]) test(`refuses malformed refresh ${JSON.stringify(refresh)}`, async () => {
    expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear", "--json"], fixture({ refresh }).deps)).toBe(1);
    expect(output).not.toHaveBeenCalled();
  });
  for (const patch of [{ provider: "other" }, { modelId: "other" }, { displayNameOverride: "other" },
    { ok: false }, { displayName: null }, { displayNameSource: "private" }, { catalogRefresh: null }]) {
    test(`rejects success DTO mismatch ${JSON.stringify(patch)}`, async () => {
      const receipt = { ok: true, provider: "fixture", modelId: "raw-id", displayNameOverride: null,
        displayName: "Raw", displayNameSource: "fallback", catalogRefresh: committed, ...patch };
      expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear", "--json"], fixture({ receipt }).deps)).toBe(1);
      expect(output).not.toHaveBeenCalled();
    });
  }
  for (const patch of [{ saved: false }, { provider: "other" }, { modelId: "other" },
    { displayNameOverride: "other" }, { catalogRefresh: committed }, { catalogRefresh: null }]) {
    test(`rejects unproven saved 503 ${JSON.stringify(patch)}`, async () => {
      const receipt = { saved: true, provider: "fixture", modelId: "raw-id", displayNameOverride: null, catalogRefresh: failed, ...patch };
      expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear", "--json"], fixture({ receipt, status: 503 }).deps)).toBe(1);
      expect(output).not.toHaveBeenCalled();
    });
  }
  for (const refresh of [{ ...committed, degraded: true }, { status: "skipped", reason: "stale", retryable: true }, failed]) {
    test(`valid partial refresh returns one ${refresh.status}`, async () => {
      expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear", "--json"], fixture({ refresh }).deps)).toBe(1);
      expect(result().catalogRefresh).toEqual(refresh);
    });
  }
  for (const [status, exit] of [[400, 1], [404, 4], [409, 5], [503, 1]]) test(`HTTP ${status} numeric outcome`, async () => {
    const f = fixture({ status, receipt: { error: { message: "private server detail" } } });
    expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear", "--json"], f.deps)).toBe(exit!);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private server detail");
  });
  test("transport failure emits fixed error without hidden credentials", async () => {
    const f = fixture({ throwTransport: true });
    expect(await handleModelsDisplayNameCommand(["fixture/raw-id", "--clear"], f.deps)).toBe(1);
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private transport detail");
  });
});

describe("CLI through actual display-name handler", () => {
  for (const refresh of [committed, failed]) test(`saved state and truthful outcome: ${refresh.status}`, async () => {
    const config: OcxConfig = { port: 10100, defaultProvider: "fixture", modelCacheTtlMs: 60_000,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["org/raw"] } } };
    const persisted: OcxConfig[] = [];
    const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:14601", fetchImpl: (async (input, init) => {
      const req = new Request(String(input), init);
      const response = await handleModelRoutes({ req, url: new URL(req.url), config,
        deps: { saveConfigPreservingClaudeCode: saved => { persisted.push(structuredClone(saved)); } },
        convergeCodexCatalog: async () => refresh, syncClaudeAgentDefsBestEffort: async () => {},
      });
      if (!response) throw new Error("Handler did not match");
      return response;
    }) as typeof fetch };
    expect(await handleModelsDisplayNameCommand(["fixture/org/raw", "--set=My Label", "--json"], deps)).toBe(refresh.status === "committed" ? 0 : 1);
    expect(config.providers.fixture?.modelDisplayNames).toEqual({ "org/raw": "My Label" });
    expect(persisted).toHaveLength(1);
    expect(result()).toMatchObject({ provider: "fixture", modelId: "org/raw", displayNameOverride: "My Label", catalogRefresh: refresh });
    output.mockClear();
    expect(await handleModelsDisplayNameCommand(["fixture/org/raw", "--clear", "--json"], deps)).toBe(refresh.status === "committed" ? 0 : 1);
    expect(config.providers.fixture?.modelDisplayNames).toBeUndefined();
    expect(persisted).toHaveLength(2);
    expect(result().displayNameOverride).toBeNull();
  });
});
