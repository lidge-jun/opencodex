import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboConfigIssues, getCombo } from "../../src/combos";
import { getConfigPath, loadConfig, readConfigDiagnostics, saveConfig } from "../../src/config";
import { providerEditorConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const targets = [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }];
const selfHostedRow: OcxProviderConfig = {
  adapter: "jev-decision",
  baseUrl: "http://127.0.0.1:11434/v1/systemone",
  allowPrivateNetwork: true,
  defaultModel: "tev1:4b",
  liveModels: false,
};

function providers(): Record<string, OcxProviderConfig> {
  return {
    a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    "ollama-tev1": { ...selfHostedRow },
  };
}

function config(combos: OcxConfig["combos"] = undefined): OcxConfig {
  return { port: 10100, defaultProvider: "a", providers: providers(), ...(combos ? { combos } : {}) };
}

async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.OPENCODEX_HOME;
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ocx-jev-decision-provider-"));
  process.env.OPENCODEX_HOME = dir;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    removeTreeWithRetry(dir);
  }
}

async function api(cfg: OcxConfig, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), cfg, {
    createManagementConvergeCodex: catalogConvergenceFactory(async () => {}),
  });
  expect(response).not.toBeNull();
  return response!;
}

describe("JEV decisionProvider combo validation", () => {
  const issuesFor = (combo: Record<string, unknown>, rows = providers()) =>
    comboConfigIssues("auto", { targets, ...combo }, rows).filter(issue => issue.path[0]?.toString().startsWith("decision"));

  test("accepts a configured jev-decision row, the literal jev without a row, and omission", () => {
    expect(issuesFor({ strategy: "jev", decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000 })).toEqual([]);
    expect(issuesFor({ strategy: "jev", decisionProvider: "jev" })).toEqual([]);
    expect(issuesFor({ strategy: "jev" })).toEqual([]);
    expect(issuesFor({ strategy: "jev", decisionProvider: null, decisionTimeoutMs: null })).toEqual([]);
    const rows = providers();
    rows.remote = { ...selfHostedRow, baseUrl: "https://decisions.example/v1/decisions", apiKey: "remote-secret" };
    expect(issuesFor({ strategy: "jev", decisionProvider: "remote" }, rows)).toEqual([]);
  });

  test("rejects unknown rows, non-decision adapters, and use outside the jev strategy", () => {
    const rows = providers();
    rows.jev = { adapter: "openai-chat", baseUrl: "https://jev.example/v1" };
    expect(issuesFor({ strategy: "jev", decisionProvider: "missing" }, rows)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider "missing" is not configured' },
    ]);
    expect(issuesFor({ strategy: "jev", decisionProvider: "a" }, rows)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider "a" is not a decision service (adapter must be "jev-decision")' },
    ]);
    // Explicit "jev" means exactly what omission means, whatever row happens to be named `jev`.
    expect(issuesFor({ strategy: "jev", decisionProvider: "jev" }, rows)).toEqual([]);
    expect(issuesFor({ strategy: "jev" }, rows)).toEqual([]);
    rows.local = { adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1", allowPrivateNetwork: true };
    expect(issuesFor({ strategy: "jev", decisionProvider: "local" }, rows)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider "local" baseUrl must be a full HTTPS decision endpoint or an HTTP /systemone endpoint' },
    ]);
    expect(issuesFor({ strategy: "failover", decisionProvider: "ollama-tev1" }, rows)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider is only valid with strategy "jev"' },
    ]);
    expect(issuesFor({ decisionProvider: "ollama-tev1" }, rows)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider is only valid with strategy "jev"' },
    ]);
    for (const bad of ["", "   ", 7]) {
      expect(issuesFor({ strategy: "jev", decisionProvider: bad }, rows)).toEqual([
        { path: ["decisionProvider"], message: "decisionProvider must be a non-empty provider name" },
      ]);
    }
  });

  test("bounds decisionTimeoutMs and ties it to the jev strategy", () => {
    for (const bad of [999, 120_001, 1_500.5, "5000"]) {
      expect(issuesFor({ strategy: "jev", decisionTimeoutMs: bad })).toEqual([
        { path: ["decisionTimeoutMs"], message: "decisionTimeoutMs must be an integer from 1000 to 120000" },
      ]);
    }
    expect(issuesFor({ strategy: "round-robin", decisionTimeoutMs: 5_000 })).toEqual([
      { path: ["decisionTimeoutMs"], message: 'decisionTimeoutMs is only valid with strategy "jev"' },
    ]);
  });

  test("normalizes a trimmed decision provider and keeps omission sparse", () => {
    const cfg = config({
      auto: { strategy: "jev", targets, decisionProvider: "  ollama-tev1 ", decisionTimeoutMs: 30_000 },
      plain: { strategy: "jev", targets },
      explicit: { strategy: "jev", targets, decisionProvider: " jev " },
    });
    expect(getCombo(cfg, "auto")).toMatchObject({ decisionProvider: "ollama-tev1", decisionTimeoutMs: 30_000 });
    expect(getCombo(cfg, "plain")).not.toHaveProperty("decisionProvider");
    expect(getCombo(cfg, "plain")).not.toHaveProperty("decisionTimeoutMs");
    expect(getCombo(cfg, "explicit")).toEqual(getCombo(cfg, "plain"));
  });

  test("config-file load reports an invalid decisionProvider at its combo path", async () => {
    await withTempHome(async () => {
      writeFileSync(getConfigPath(), JSON.stringify(config({
        auto: { strategy: "jev", targets, decisionProvider: "a" },
      })), "utf8");
      const diagnostics = readConfigDiagnostics();
      expect(JSON.stringify(diagnostics)).toContain("decisionProvider \\\"a\\\" is not a decision service");
      expect(JSON.stringify(diagnostics)).toContain("combos.auto.decisionProvider");
    });
  });
});

describe("JEV decisionProvider usability at save time", () => {
  const rows = () => ({
    ...providers(),
    off: { ...selfHostedRow, disabled: true },
    nomodel: { ...selfHostedRow, defaultModel: " ", models: [] },
    listed: { ...selfHostedRow, defaultModel: undefined, models: ["tev1:4b"] },
  });

  test("config-file validation stays lenient; save-time validation rejects rows the runtime would skip", () => {
    const strict = { requireUsableDecisionService: true };
    for (const id of ["off", "nomodel", "listed"]) {
      expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionProvider: id }, rows())).toEqual([]);
    }
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionProvider: "off" }, rows(), strict)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider "off" is disabled' },
    ]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionProvider: "nomodel" }, rows(), strict)).toEqual([
      { path: ["decisionProvider"], message: 'decisionProvider "nomodel" has no model (set defaultModel or models)' },
    ]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionProvider: "listed" }, rows(), strict)).toEqual([]);
    expect(comboConfigIssues("auto", { strategy: "jev", targets, decisionProvider: "jev" }, rows(), strict)).toEqual([]);
  });

  test("the management API refuses a disabled or model-less decision provider", async () => {
    await withTempHome(async () => {
      const cfg = { ...config(), providers: rows() };
      saveConfig(cfg);
      const disabled = await api(cfg, "PUT", "/api/combos", {
        id: "auto", combo: { strategy: "jev", targets, decisionProvider: "off" },
      });
      expect(disabled.status).toBe(400);
      expect(await disabled.json()).toEqual({ error: 'decisionProvider "off" is disabled' });
      const modelless = await api(cfg, "PUT", "/api/combos", {
        id: "auto", combo: { strategy: "jev", targets, decisionProvider: "nomodel" },
      });
      expect(modelless.status).toBe(400);
      expect(await modelless.json()).toEqual({
        error: 'decisionProvider "nomodel" has no model (set defaultModel or models)',
      });
      expect(cfg.combos?.auto).toBeUndefined();
    });
  });
});

describe("JEV decisionProvider management round-trip", () => {
  test("a dashboard-shaped save keeps the decision provider and timeout; another strategy drops them", async () => {
    await withTempHome(async () => {
      const cfg = config();
      saveConfig(cfg);
      const created = await api(cfg, "PUT", "/api/combos", {
        id: "auto",
        combo: { strategy: "jev", targets, decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000 },
      });
      expect(created.status).toBe(200);
      expect(cfg.combos?.auto).toMatchObject({ decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000 });

      // The GUI sends no decision-service fields (toPutBody): an omitted field is carried forward.
      const dashboard = await api(cfg, "PUT", "/api/combos", {
        id: "auto",
        combo: {
          targets, strategy: "jev", defaultEffort: null, imageInput: "auto", reasoningEffortMode: "adaptive",
        },
      });
      expect(dashboard.status).toBe(200);
      expect(cfg.combos?.auto).toMatchObject({ decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000 });
      const disk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(disk.combos?.auto).toMatchObject({ decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000 });
      const listed = await (await api(cfg, "GET", "/api/combos")).json() as { combos: unknown[] };
      expect(listed.combos).toEqual([expect.objectContaining({
        id: "auto", decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000,
      })]);

      // Rename follows the source combo.
      const renamed = await api(cfg, "PUT", "/api/combos", {
        id: "auto2", renameFrom: "auto", combo: { targets, strategy: "jev" },
      });
      expect(renamed.status).toBe(200);
      expect(cfg.combos?.auto2).toMatchObject({ decisionProvider: "ollama-tev1", decisionTimeoutMs: 60_000 });

      // Explicit null clears; switching strategy drops the carried values instead of failing.
      const cleared = await api(cfg, "PUT", "/api/combos", {
        id: "auto2", combo: { targets, strategy: "jev", decisionProvider: null, decisionTimeoutMs: null },
      });
      expect(cleared.status).toBe(200);
      expect(cfg.combos?.auto2).not.toHaveProperty("decisionProvider");
      expect(cfg.combos?.auto2).not.toHaveProperty("decisionTimeoutMs");
      await api(cfg, "PUT", "/api/combos", {
        id: "auto2", combo: { targets, strategy: "jev", decisionProvider: "ollama-tev1" },
      });
      const switched = await api(cfg, "PUT", "/api/combos", { id: "auto2", combo: { targets, strategy: "failover" } });
      expect(switched.status).toBe(200);
      expect(cfg.combos?.auto2).not.toHaveProperty("decisionProvider");

      const rejected = await api(cfg, "PUT", "/api/combos", {
        id: "auto2", combo: { targets, strategy: "jev", decisionProvider: "a" },
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: 'decisionProvider "a" is not a decision service (adapter must be "jev-decision")',
      });
    });
  });

  test("a decision provider named by a combo cannot be deleted; the literal jev row can", async () => {
    await withTempHome(async () => {
      const cfg = config({
        custom: { strategy: "jev", targets, decisionProvider: "ollama-tev1" },
        canonical: { strategy: "jev", targets, decisionProvider: "jev" },
      });
      cfg.providers.jev = { adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", liveModels: false };
      saveConfig(cfg);
      const blocked = await api(cfg, "DELETE", "/api/providers?name=ollama-tev1");
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: "provider_has_dependent_combos", combos: ["custom"] });
      expect(cfg.providers["ollama-tev1"]).toBeDefined();

      const canonical = await api(cfg, "DELETE", "/api/providers?name=jev");
      expect(canonical.status).toBe(200);
      expect(cfg.providers.jev).toBeUndefined();
    });
  });

  test("the provider-editor batch save refuses to drop a decision provider a combo names", async () => {
    await withTempHome(async () => {
      saveConfig(config({ custom: { strategy: "jev", targets, decisionProvider: "ollama-tev1" } }));
      const cfg = loadConfig();
      const before = readFileSync(getConfigPath(), "utf8");
      const baseline = providerEditorConfigDTO(cfg);
      const next = structuredClone(baseline);
      delete next.providers["ollama-tev1"];

      const blocked = await api(cfg, "PUT", "/api/providers", { baseline, next });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: "provider_has_dependent_combos" });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    });
  });

  test("a provider PATCH cannot break a combo's decision provider; disabling it still can", async () => {
    await withTempHome(async () => {
      saveConfig(config({ custom: { strategy: "jev", targets, decisionProvider: "ollama-tev1" } }));
      const cfg = loadConfig();
      const before = readFileSync(getConfigPath(), "utf8");

      const adapter = await api(cfg, "PATCH", "/api/providers?name=ollama-tev1", { adapter: "openai-chat" });
      expect(adapter.status).toBe(400);
      expect((await adapter.json() as { error: string }).error).toContain(
        'combos.custom.decisionProvider: decisionProvider "ollama-tev1" is not a decision service',
      );
      const endpoint = await api(cfg, "PATCH", "/api/providers?name=ollama-tev1", {
        baseUrl: "http://127.0.0.1:11434/v1",
      });
      expect(endpoint.status).toBe(400);
      expect((await endpoint.json() as { error: string }).error).toContain(
        'combos.custom.decisionProvider: decisionProvider "ollama-tev1" baseUrl must be a full HTTPS decision endpoint',
      );
      expect(cfg.providers["ollama-tev1"]).toMatchObject({ adapter: "jev-decision", baseUrl: selfHostedRow.baseUrl });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);

      // Runtime fails open for an unusable row, so these stay allowed.
      const moved = await api(cfg, "PATCH", "/api/providers?name=ollama-tev1", {
        baseUrl: "http://127.0.0.1:11435/v1/systemone",
      });
      expect(moved.status).toBe(200);
      const disabled = await api(cfg, "PATCH", "/api/providers?name=ollama-tev1", { disabled: true });
      expect(disabled.status).toBe(200);
      expect(cfg.providers["ollama-tev1"]?.disabled).toBe(true);
      expect(cfg.combos?.custom).toMatchObject({ decisionProvider: "ollama-tev1" });
    });
  });

  test("a retargeted jev row is not probed, so its stored key is never sent", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`);
        return Response.json({ data: [] });
      },
    });
    try {
      const cfg = config();
      cfg.providers.jev = {
        adapter: "jev-decision",
        baseUrl: `http://127.0.0.1:${server.port}/v1/systemone`,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "stored-typesafe-secret",
      };
      const response = await api(cfg, "POST", "/api/providers/test?name=jev");
      expect(await response.json()).toEqual({ applicable: false, reason: "retargeted_decision_service", latencyMs: 0 });
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
