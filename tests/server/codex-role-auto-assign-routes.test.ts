import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCatalogNativeSlugs, type CatalogModel } from "../../src/codex/catalog";
import { ARTIFICIAL_ANALYSIS_SOURCE, type LoadCapability } from "../../src/codex/role-capability";
import { ROLE_SIZING_SYSTEM_PROMPT } from "../../src/codex/role-sizing";
import { handleManagementAPI } from "../../src/server/management-api";
import type { RoleSizingCall } from "../../src/server/management/codex-role-auto-assign";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const EXPLORER = 'name = "explorer"\ndescription = "Read-only search."\nmodel = "stub/big"\nmodel_reasoning_effort = "high"\n';
const WORKER = 'name = "worker"\ndeveloper_instructions = """\nChange code across modules.\n"""\n';
const BARE = 'name = "bare"\n';
const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root = "";
let calls: RoleSizingCall[] = [];
let answer: { text: string; error?: string } = { text: "" };

function sized(tier: string, effort: string) {
  return { tier, effort, rationale: "why", move_up_if: "up", move_down_if: "down" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-role-auto-assign-"));
  mkdirSync(join(root, "codex", "agents"), { recursive: true });
  writeFileSync(join(root, "codex", "agents", "explorer.toml"), EXPLORER);
  writeFileSync(join(root, "codex", "agents", "worker.toml"), WORKER);
  writeFileSync(join(root, "codex", "agents", "bare.toml"), BARE);
  writeFileSync(join(root, "codex", "config.toml"), 'model = "stub/sizer"\n');
  installLazyCodex();
  process.env.CODEX_HOME = join(root, "codex");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  calls = [];
  answer = { text: JSON.stringify({ roles: { explorer: sized("fast", "glance"), worker: sized("frontier", "exhaustive") } }) };
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  removeTreeWithRetry(root);
});

const routed = (id: string, efforts: string[]): CatalogModel => ({ id, provider: "stub", reasoningEfforts: efforts, defaultReasoningEffort: "medium" });

const LAZYCODEX_ENABLED = '[plugins."omo@sisyphuslabs"]\nenabled = true\n';

function installLazyCodex(): void {
  const plugin = join(root, "codex", "plugins", "cache", "sisyphuslabs", "omo", "5.1.1");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "lazycodex-install.json"), "{}");
  writeFileSync(join(root, "codex", "config.toml"), 'model = "stub/sizer"\n' + LAZYCODEX_ENABLED);
}

const config = {
  port: 10100,
  providers: {},
  defaultProvider: "openai",
  disabledModels: listCatalogNativeSlugs(),
  codexRoleTiers: { fast: ["stub/small"], frontier: ["stub/big"] },
} as unknown as OcxConfig;

const deps = {
  fetchAllModels: async () => [routed("small", ["low", "medium", "high"]), routed("big", ["low", "medium", "high", "xhigh"])],
  completeCodexRoleSizing: async (call: RoleSizingCall) => {
    calls.push(call);
    return answer;
  },
  loadCodexRoleCapability: (async () => ({ source: null, publishedAt: null, domains: {} })) as LoadCapability,
};

async function call(path: string, init?: RequestInit) {
  const response = await handleManagementAPI(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`), config, deps);
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, any> };
}

function snapshot(): Record<string, string> {
  const dir = join(root, "codex", "agents");
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), "utf8")]));
}

describe("POST /api/codex-agent-roles/auto-assign", () => {
  test("Artificial Analysis success produces measured tiers without exposing scores", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | globalThis.Request) => {
      urls.push(String(input));
      return Response.json({ data: [
        { name: "small", evaluations: { artificial_analysis_coding_index: 66 } },
        { name: "big", evaluations: { artificial_analysis_coding_index: 58 } },
      ] });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    answer = { text: JSON.stringify({ roles: { explorer: { ...sized("frontier", "glance"), domain: "coding" } } }) };
    try {
      const response = await handleManagementAPI(
        new Request("http://localhost/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" }),
        new URL("http://localhost/api/codex-agent-roles/auto-assign"),
        { ...config, codexRoleTiers: undefined, codexRoleCapability: { artificialAnalysis: { apiKey: "aa-success-route-fixture" } } },
        { ...deps, loadCodexRoleCapability: undefined },
      );
      const body = await response!.json();
      expect(urls).toEqual(["https://artificialanalysis.ai/api/v2/data/llms/models"]);
      expect(body.capability.name).toBe("Artificial Analysis");
      expect(body.capability.domains.coding).toEqual([{ model: "stub/small", tier: expect.any(String) }, { model: "stub/big", tier: expect.any(String) }]);
      expect(body.proposals.find((row: { role: string }) => row.role === "explorer")).toMatchObject({ tierSource: "measured", proposedModel: "stub/small" });
    } finally { globalThis.fetch = originalFetch; }
  });
  test.each([false, true])("disabled benchmarks retain proposals and report unavailability (Artificial Analysis configured: %s)", async withAnalysis => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | globalThis.Request) => {
      requests.push(String(input));
      return new Response("fixture failure", { status: 401 });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    try {
      const response = await handleManagementAPI(
        new Request("http://localhost/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" }),
        new URL("http://localhost/api/codex-agent-roles/auto-assign"),
        { ...config, codexRoleCapability: withAnalysis ? { artificialAnalysis: { apiKey: "route-consent-fixture" } } : undefined },
        { ...deps, loadCodexRoleCapability: undefined },
      );
      expect(response!.status).toBe(200);
      const body = await response!.json();
      expect(requests).toEqual(withAnalysis ? ["https://artificialanalysis.ai/api/v2/data/llms/models"] : []);
      expect(body.capability.error).toBe(withAnalysis ? "Artificial Analysis could not be read" : "benchmark data was unavailable: no Artificial Analysis key is configured");
      expect(body.capability).toMatchObject({ name: null, url: null, license: null, publishedAt: null });
      expect(body.capability.domains).toEqual({});
      expect(body.proposals.find((row: { role: string }) => row.role === "explorer")).toMatchObject({ status: "proposed", proposedModel: "stub/small" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("proposes a model and effort per role through one sizing call and writes nothing", async () => {
    const before = snapshot();
    const result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
    expect(result.status).toBe(200);
    expect(snapshot()).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("stub/sizer");
    expect(calls[0]!.system).toBe(ROLE_SIZING_SYSTEM_PROMPT);
    expect(calls[0]!.user).toContain("Read-only search.");
    expect(calls[0]!.user).not.toContain('"bare"');
    expect(result.body.sizingModel).toBe("stub/sizer");
    const byRole = Object.fromEntries((result.body.proposals as any[]).map(p => [p.role, p]));
    expect(byRole.explorer).toMatchObject({ status: "proposed", model: "stub/big", effort: "high", proposedModel: "stub/small", proposedEffort: "low", tier: "fast" });
    expect(byRole.worker).toMatchObject({ status: "proposed", proposedModel: "stub/big", proposedEffort: "xhigh", tier: "frontier" });
    expect(byRole.bare.status).toBe("unsized");
  });

  test("tiers a role by its domain's measured scores, and an unreadable source leaves price rank in charge", async () => {
    const pricedConfig = { ...config, codexRoleTiers: undefined } as unknown as OcxConfig;
    answer = { text: JSON.stringify({ roles: { explorer: { ...sized("frontier", "glance"), domain: "coding" } } }) };
    const post = async (loadCodexRoleCapability: typeof deps.loadCodexRoleCapability) => {
      const response = await handleManagementAPI(
        new Request("http://localhost/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" }),
        new URL("http://localhost/api/codex-agent-roles/auto-assign"),
        pricedConfig,
        { ...deps, loadCodexRoleCapability },
      );
      return await response!.json() as Record<string, any>;
    };
    const measured = await post(async () => ({
      source: ARTIFICIAL_ANALYSIS_SOURCE,
      publishedAt: null,
      domains: { coding: new Map([["small", 1550], ["big", 1450]]) },
    }));
    const explorer = (measured.proposals as any[]).find(p => p.role === "explorer");
    expect(explorer).toMatchObject({ domain: "coding", proposedModel: "stub/small", tierSource: "measured" });
    expect(measured.capability).toMatchObject({ name: "Artificial Analysis", publishedAt: null, error: null });
    expect(measured.capability.domains.coding[0].score).toBeUndefined();
    const licensed = await post(async () => ({
      source: ARTIFICIAL_ANALYSIS_SOURCE,
      publishedAt: null,
      domains: { coding: new Map([["small", 66], ["big", 58]]) },
    }));
    expect(licensed.capability).toMatchObject({ name: "Artificial Analysis", url: "https://artificialanalysis.ai" });
    expect(licensed.capability.domains.coding[0]).toEqual({ model: "stub/small", tier: expect.any(String) });
    expect(licensed.capability.redistributable).toBeUndefined();
    const failed = await post(async () => { throw new Error("offline at /home/secret"); });
    expect(failed.capability.error).toBe("the measured capability source could not be read");
    expect(JSON.stringify(failed)).not.toContain("/home/secret");
    expect((failed.proposals as any[]).find(p => p.role === "explorer").tierSource).not.toBe("measured");
  });

  test("a routed model that declares no levels takes the ladder and default Codex shows for it", async () => {
    const levels = ["low", "medium", "high", "xhigh"].map(effort => ({ effort, description: effort }));
    writeFileSync(join(root, "codex", "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "stub/small", supported_reasoning_levels: levels, default_reasoning_level: "medium" }],
    }));
    const bare: CatalogModel = { id: "small", provider: "stub" };
    const result = await handleManagementAPI(
      new Request("http://localhost/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" }),
      new URL("http://localhost/api/codex-agent-roles/auto-assign"),
      config,
      { ...deps, fetchAllModels: async () => [bare, routed("big", ["low", "medium", "high", "xhigh"])] },
    );
    const body = await result!.json() as Record<string, any>;
    const explorer = (body.proposals as any[]).find(p => p.role === "explorer");
    expect(explorer).toMatchObject({ proposedModel: "stub/small", proposedEffort: "low" });
    answer = { text: JSON.stringify({ roles: { explorer: sized("fast", "measured") } }) };
    const measured = await handleManagementAPI(
      new Request("http://localhost/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" }),
      new URL("http://localhost/api/codex-agent-roles/auto-assign"),
      config,
      { ...deps, fetchAllModels: async () => [bare] },
    );
    const again = await measured!.json() as Record<string, any>;
    expect((again.proposals as any[]).find(p => p.role === "explorer")).toMatchObject({ proposedEffort: "medium" });
  });

  test("a routed row's own ladder keeps the default Codex shows, and an explicit empty ladder stays empty", async () => {
    const levels = ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort, description: effort }));
    writeFileSync(join(root, "codex", "opencodex-catalog.json"), JSON.stringify({
      models: [{ slug: "stub/small", supported_reasoning_levels: levels, default_reasoning_level: "medium" }],
    }));
    answer = { text: JSON.stringify({ roles: { explorer: sized("fast", "measured") } }) };
    type Proposal = { role: string; proposedModel: string | null; proposedEffort: string | null };
    const explorerWith = async (small: CatalogModel) => {
      const result = await handleManagementAPI(
        new Request("http://localhost/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" }),
        new URL("http://localhost/api/codex-agent-roles/auto-assign"),
        config,
        { ...deps, fetchAllModels: async () => [small, routed("big", ["low", "medium", "high", "xhigh"])] },
      );
      const body = await result!.json() as { proposals: Proposal[] };
      return body.proposals.find(p => p.role === "explorer");
    };
    // The middle of five rungs is high; the default Codex shows is medium.
    const ownLadder = await explorerWith({ id: "small", provider: "stub", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(ownLadder).toMatchObject({ proposedModel: "stub/small", proposedEffort: "medium" });
    // An explicit [] declares no effort control, so the written ladder is not borrowed.
    const noControl = await explorerWith({ id: "small", provider: "stub", reasoningEfforts: [] });
    expect(noControl).toMatchObject({ proposedModel: "stub/small", proposedEffort: null });
  });

  test("an unusable sizing answer or a failed call leaves roles unsized", async () => {
    answer = { text: "explorer should be fast" };
    let result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: JSON.stringify({ model: "stub/other" }) });
    expect(calls[0]!.model).toBe("stub/other");
    expect((result.body.proposals as any[]).every(p => p.status === "unsized")).toBe(true);
    answer = { text: "", error: "role sizing HTTP 502: boom" };
    result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
    expect(result.body.sizingError).toBe("HTTP 502");
    expect((result.body.proposals as any[]).find(p => p.role === "worker").reason).toContain("the sizing call failed");
  });

  test("a failed sizing call never echoes upstream text or exception messages", async () => {
    const leaks = [
      "role sizing HTTP 500: /Users/example/.codex/auth.json account=acct_123 key=sk-live-abc",
      "connect ECONNREFUSED while opening /Users/example/secret.sock for acct_123",
    ];
    for (const error of leaks) {
      answer = { text: "", error };
      const result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
      const serialized = JSON.stringify(result.body);
      expect(serialized).not.toContain("/Users/example");
      expect(serialized).not.toContain("acct_123");
      expect(serialized).not.toContain("sk-live-abc");
    }
  });

  test("refuses without a sizing model and never calls one", async () => {
    writeFileSync(join(root, "codex", "config.toml"), LAZYCODEX_ENABLED);
    const result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: "{}" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("no_sizing_model");
    expect(calls).toHaveLength(0);
  });

  test("refuses without LazyCodex before reading the body or calling the sizing model", async () => {
    writeFileSync(join(root, "codex", "config.toml"), 'model = "stub/sizer"\n');
    const before = snapshot();
    const result = await call("/api/codex-agent-roles/auto-assign", { method: "POST", body: JSON.stringify({ model: "stub/other" }) });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("lazycodex_not_detected");
    expect(calls).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });
});

describe("PUT /api/codex-agent-roles/{role} with an effort", () => {
  test("writes model and effort together and rejects an unknown effort", async () => {
    const put = (body: unknown) => call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ model: "stub/small", effort: "turbo" })).status).toBe(400);
    expect(snapshot()["explorer.toml"]).toBe(EXPLORER);
    const result = await put({ model: "stub/small", effort: "low" });
    expect(result.body).toMatchObject({ ok: true, model: "stub/small", effort: "low" });
    expect(snapshot()["explorer.toml"]).toBe(EXPLORER.replace("stub/big", "stub/small").replace('"high"', '"low"'));
  });
});
