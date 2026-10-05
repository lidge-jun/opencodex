import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleProviderCommand, type ProviderCommandDeps } from "../../src/cli/provider";
import { syncModelsToCodex, type CodexSyncResult } from "../../src/codex/sync";
import { refreshCodexModelCatalog } from "../../src/codex/refresh";
import { FOREIGN_CODEX_HOME_OWNER_MESSAGE, UNKNOWN_CODEX_HOME_OWNER_MESSAGE,
  unbackedRoutedRemovalMessage } from "../../src/codex/catalog/routed-removal";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { validateConfigCandidate } from "../../src/config";

let home: TempHome, stdout: ReturnType<typeof spyOn>, stderr: ReturnType<typeof spyOn>;
let previousExit: typeof process.exitCode;
beforeEach(() => {
  home = createTempHome("ocx-provider-sync-result-");
  previousExit = process.exitCode;
  process.exitCode = 0;
  writeFileSync(home.path("config.json"), JSON.stringify({ port: 19223, defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } } }));
  stdout = spyOn(console, "log").mockImplementation(() => {});
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stdout.mockRestore(); stderr.mockRestore();
  process.exitCode = previousExit ?? 0;
  home.remove();
});
const add = ["add", "example", "--adapter", "openai-chat", "--base-url", "https://example.test/v1"];
const printed = () => stdout.mock.calls.map(call => call.join(" ")).join("\n");
const configured = () => JSON.parse(readFileSync(home.path("config.json"), "utf8"));

function syncDeps(result: CodexSyncResult): ProviderCommandDeps {
  return {
    findLiveProxy: async () => ({ port: 19223 } as LiveProxy),
    syncModels: async (port, config, log) => {
      expect(port).toBe(19223);
      expect(config!.providers.example).toBeDefined();
      expect(log).toBeNull(); // JSON cannot suppress the operation or admit its prose logger.
      return result;
    },
  };
}
const receipt = (status: CodexSyncResult["status"], ok: boolean): CodexSyncResult => ({
  status, ok, added: 1, catalogPath: "/fixture/private-path", catalogExists: true,
  catalogWritten: true, cacheSynced: true, message: "fixture-private-non-token-value",
});

describe("provider add keeps requested local sync independent of JSON output", () => {
  test.each([
    { result: { ok: false, error: "fixture connection refused" }, code: 1 },
    { result: { ok: true, message: "fixture connected" }, code: 0 },
    { result: { applicable: false, reason: "static catalog" }, code: 0 },
  ])("provider test preserves its observed exit $code", async ({ result, code }) => {
    let requests = 0;
    await handleProviderCommand(["test", "example", "--json"], {
      baseUrl: "http://fixture.test",
      fetchImpl: (async (input, init) => {
        requests++;
        expect(String(input)).toBe("http://fixture.test/api/providers/test?name=example");
        expect(init?.method).toBe("POST");
        return Response.json(result);
      }) as typeof fetch,
    });
    expect(requests).toBe(1);
    expect(JSON.parse(printed())).toEqual(result);
    expect(process.exitCode ?? 0).toBe(code);
  });
  test.each([
    ["deepseek", "--auth-mode", "local"],
    ["deepseek", "--auth-mode", "forward"],
    ["google-antigravity", "--auth-mode", "local"],
    ["deepseek", "--auth-mode", "local", "--base-url", "http://127.0.0.1:8000/v1", "--allow-private-network"],
    ["example", "--adapter", "openai-responses", "--base-url", "https://example.test/v1", "--auth-mode", "forward"],
    ["example", "--adapter", "openai-chat", "--base-url", "http://127.0.0.1:8000/v1", "--auth-mode", "local"],
    ["openai", "--auth-mode", "forward", "--allow-private-network"],
    ["openai", "--responses-path", "/other-responses"],
  ])("completed local row refuses owner-invalid overrides: %j", async (...options) => {
    const before = readFileSync(home.path("config.json"), "utf8");
    let discoveries = 0, syncs = 0, requests = 0;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      requests++; throw new Error("fixture network forbidden");
    });
    try {
      await handleProviderCommand(["add", ...options, "--force", "--sync", "--set-default", "--json"], {
        findLiveProxy: async () => { discoveries++; return { port: 19223 } as LiveProxy; },
        syncModels: async () => { syncs++; return receipt("applied", true); },
      });
      expect(process.exitCode).toBe(2);
      expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
      expect({ discoveries, syncs, requests }).toEqual({ discoveries: 0, syncs: 0, requests: 0 });
      expect(printed()).toBe("");
      expect(stderr.mock.calls.flat().join(" ")).toContain("Invalid provider configuration");
    } finally { fetch.mockRestore(); }
  });
  test.each([
    { name: "deepseek", flags: [], authMode: "key" },
    { name: "deepseek", flags: ["--auth-mode", "key"], authMode: "key" },
    { name: "ollama", flags: ["--auth-mode", "local"], authMode: "local" },
    { name: "google-antigravity", flags: ["--auth-mode", "oauth"], authMode: "oauth" },
    { name: "google-antigravity", flags: ["--auth-mode", "key"], authMode: "key" },
    { name: "google-antigravity", flags: ["--auth-mode", "oauth", "--base-url", "https://example.test/v1"], authMode: "oauth" },
    { name: "example", flags: ["--adapter", "openai-chat", "--base-url", "http://127.0.0.1:8000/v1", "--auth-mode", "local", "--allow-private-network"], authMode: "local" },
    { name: "example", flags: ["--adapter", "openai-chat", "--base-url", "https://example.test/v1", "--auth-mode", "oauth"], authMode: "oauth" },
    { name: "example", flags: ["--adapter", "openai-chat", "--base-url", "https://example.test/v1", "--responses-path", "/responses"], authMode: undefined },
  ])("owner-valid completed row remains saveable: $name $authMode", async ({ name, flags, authMode }) => {
    let discoveries = 0;
    await handleProviderCommand(["add", name, ...flags, "--json"], {
      findLiveProxy: async () => { discoveries++; return null; },
    });
    expect(process.exitCode ?? 0).toBe(0);
    expect(configured().providers[name].authMode).toBe(authMode);
    expect(JSON.parse(printed()).action).toBe("added");
    expect(discoveries).toBe(0);
    expect(stderr.mock.calls).toEqual([]);
  });
  test.each(["throw", "unchanged", "refused"])("real backend %s catalog outcome remains distinct from config injection", async kind => {
    const result = await syncModelsToCodex(19223, configured(), null, {
      admitCodexWrite: () => ({ kind: "admitted" }),
      currentExternalCodexModelProvider: () => null,
      refreshReasoningMetadata: async () => {},
      injectCodexConfig: async () => ({ success: true, message: "fixture injection succeeded" }),
      refreshCodexModelCatalog: async () => {
        if (kind === "throw") throw new Error("fixture-private-catalog-failure");
        return { added: 0, path: home.path("catalog.json"), catalogExists: true,
          catalogWritten: false, cacheSynced: false, comboOmissions: [],
          refreshOutcome: kind === "refused" ? "refused" : "committed" };
      },
    });
    expect(result.status).toBe("applied");
    expect(result.ok).toBe(true); // Actual backend truth: config injection, not catalog convergence.
    expect(result.catalogWritten).toBe(false);
    if (kind === "refused") expect(result.refreshOutcome).toBe("refused");
    await handleProviderCommand([...add, "--sync", "--json"], syncDeps(result));
    const expected = kind === "unchanged";
    expect(process.exitCode ?? 0).toBe(expected ? 0 : 1);
    expect(JSON.parse(printed())).toMatchObject({ needsSync: !expected,
      sync: { status: "applied", ok: expected, configApplied: true, catalog: { converged: expected, written: false, cacheSynced: false } } });
    expect(printed()).not.toContain("fixture-private");
    stdout.mockClear();
    await handleProviderCommand([...add, "--force", "--sync"], syncDeps(result));
    expect(printed().includes("Models synced to Codex.")).toBe(expected);
    if (!expected) expect(printed()).toContain("Model catalog did not converge");
  });
  for (const mode of ["applied", "external", "disabled"] as const) {
    test.each([
      { reason: "foreign_owner" as const, warning: FOREIGN_CODEX_HOME_OWNER_MESSAGE },
      { reason: "owner_unknown" as const, warning: UNKNOWN_CODEX_HOME_OWNER_MESSAGE },
      { reason: "unbacked_routed_removal" as const, warning: unbackedRoutedRemovalMessage(2) },
    ])(`${mode} safety refusal preserves $reason guidance through CLI output`, async ({ reason, warning }) => {
      const config = configured();
      if (mode === "disabled") {
        config.clientIntegrations = { codex: false };
        writeFileSync(home.path("config.json"), JSON.stringify(config));
      }
      let invalidations = 0, injections = 0;
      const result = await syncModelsToCodex(19223, config, null, {
        admitCodexWrite: () => ({ kind: "admitted" }),
        currentExternalCodexModelProvider: () => mode === "external" ? "external" : null,
        refreshReasoningMetadata: async () => {},
        injectCodexConfig: async () => { injections++; return { success: true, message: "fixture injection succeeded" }; },
        refreshCodexModelCatalog: async () => refreshCodexModelCatalog(config, {
          existsSync: () => true,
          invalidateCodexModelsCache: () => { invalidations++; return true; },
          syncCatalogModels: async () => ({ added: 0, path: home.path("catalog.json"), catalogWritten: false,
            comboOmissions: [], refreshOutcome: "refused", skippedReason: reason, protectedRoutedNamespaces: 2 }),
        }),
      }, { catalogEvenWhenNotInjected: mode !== "applied" });
      const status = mode === "applied" ? "applied" : "catalog-only";
      expect(result).toMatchObject({ status, ok: true, refreshOutcome: "refused", warning,
        catalogExists: true, catalogWritten: false, cacheSynced: false });
      expect(invalidations).toBe(0);
      expect(injections).toBe(mode === "applied" ? 2 : 0);
      // Only the known safety guidance may survive; appended arbitrary diagnostics stay private.
      const cliResult = { ...result, warning: `${warning} fixture-private-extra-diagnostic` };
      await handleProviderCommand([...add, "--sync", "--json"], syncDeps(cliResult));
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(printed())).toMatchObject({ needsSync: true,
        sync: { status, ok: false, warning, catalog: { converged: false, written: false, cacheSynced: false } } });
      expect(printed()).not.toContain("fixture-private");
      stdout.mockClear();
      await handleProviderCommand([...add, "--force", "--sync"], syncDeps(cliResult));
      expect(process.exitCode).toBe(1);
      expect(printed()).toContain(warning);
      expect(printed()).not.toContain("fixture-private");
      expect(printed()).not.toContain("Models synced to Codex.");
    });
  }
  test.each(["key", "oauth", "local"])("canonical OpenAI refuses new %s auth before saving or syncing", async mode => {
    const before = readFileSync(home.path("config.json"), "utf8");
    let syncCalls = 0;
    await handleProviderCommand(["add", "openai", "--auth-mode", mode, "--force", "--sync", "--json"], {
      findLiveProxy: async () => { syncCalls++; return null; },
    });
    expect(process.exitCode).toBe(2);
    expect(syncCalls).toBe(0);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
    expect(printed()).toBe("");
    expect(stderr.mock.calls.flat().join(" ")).toContain("Canonical OpenAI");
  });
  test.each([{ flags: [] }, { flags: ["--auth-mode", "forward"] }])("canonical default and explicit forward remain valid", async ({ flags }) => {
    await handleProviderCommand(["add", "openai", "--force", "--json", ...flags]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(configured().providers.openai.authMode).toBe("forward");
    expect(validateConfigCandidate(configured()).ok).toBe(true);
    expect(JSON.parse(printed()).action).toBe("added");
  });
  test.each([
    ["applied", true, false, 0], ["catalog-only", true, true, 0],
    ["skipped", true, true, 0], ["refused", false, true, 1], ["catalog-only", false, true, 1],
  ] as const)("%s preserves save and actual sync result", async (status, ok, needsSync, code) => {
    await handleProviderCommand([...add, "--sync", "--json"], syncDeps(receipt(status, ok)));
    expect(process.exitCode ?? 0).toBe(code);
    const result = JSON.parse(printed());
    expect(result.action).toBe("added");
    expect(result.sync).toMatchObject({ status, ok });
    expect(result.needsSync).toBe(needsSync);
    expect(configured().providers.example).toBeDefined();
    expect(printed()).not.toContain("fixture-private");
    expect(stderr.mock.calls).toEqual([]);
  });
  test("no running proxy is a saved-but-unsynced nonzero outcome", async () => {
    let calls = 0;
    await handleProviderCommand([...add, "--sync", "--json"], {
      findLiveProxy: async () => null,
      syncModels: async () => { calls++; throw new Error("must not run"); },
    });
    expect(calls).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(printed())).toMatchObject({ needsSync: true, sync: { status: "not-running", ok: false } });
    expect(configured().providers.example).toBeDefined();
  });
  test("thrown dependency details are not echoed in JSON or stderr", async () => {
    await handleProviderCommand([...add, "--sync", "--json"], {
      ...syncDeps(receipt("applied", true)),
      syncModels: async () => { throw new Error("fixture-private-non-token-value"); },
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(printed()).sync).toEqual({ status: "failed", ok: false });
    expect(printed()).not.toContain("fixture-private");
    expect(stderr.mock.calls).toEqual([]);
  });
  test("save-only JSON retains its old shape without resolving a proxy", async () => {
    await handleProviderCommand([...add, "--json", "--responses-path", "/responses", "--auth-mode", "local"], {
      findLiveProxy: async () => { throw new Error("must not resolve"); },
    });
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(printed())).not.toHaveProperty("sync");
    expect(JSON.parse(printed()).needsSync).toBe(true);
    expect(configured().providers.example).toMatchObject({ responsesPath: "/responses", authMode: "local" });
  });
  test("human skipped output cannot say models synced", async () => {
    await handleProviderCommand([...add, "--sync"], syncDeps(receipt("skipped", true)));
    expect(printed()).toContain("client sync outcome: skipped");
    expect(printed()).not.toContain("Models synced");
  });
  test("malformed or unsupported live selection refuses before any local write", async () => {
    const before = readFileSync(home.path("config.json"), "utf8");
    for (const args of [[...add, "--live", "--live"], [...add, "--live=true"], ["list", "--live"]]) {
      await handleProviderCommand(args, { findLiveProxy: async () => { throw new Error("must not resolve"); } });
      expect(process.exitCode).toBe(2);
      expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
    }
  });
  test("valid live removal refusal reaches numeric dispatch without local fallback", async () => {
    const before = readFileSync(home.path("config.json"), "utf8");
    await handleProviderCommand(["remove", "openai", "--live", "--yes", "--json"], { findLiveProxy: async () => null });
    expect(process.exitCode).toBe(1);
    expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
    expect(printed()).toBe("");
  });
});
