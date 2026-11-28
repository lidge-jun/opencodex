import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClientConfigText, buildClientContribution, buildGithubCopilotClientConfig, EXPORT_CLIENTS, githubCopilotConfigPath, type ExportContext } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import { readIntegrationState } from "../../src/integrations/state";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleExportCommand } from "../../src/cli/export-command";
import { handleManagementAPI } from "../../src/server/management-api";

const config = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
const context: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1", config,
  models: [
    { namespaced: "mock/beta", provider: "mock", id: "beta", displayName: "Beta" },
    { namespaced: "mock/alpha", provider: "mock", id: "alpha", contextWindow: 200000 },
  ],
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-copilot-test-"));
  roots.push(home);
  const path = INTEGRATION_CLIENTS["github-copilot"].configPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  const original = {
    providers: [{ name: "mine", type: "openai", baseUrl: "http://keep-me/v1", apiKey: "user-key" }],
    models: [{ id: "mine", provider: "mine" }],
  };
  const before = JSON.stringify(original, null, 4) + "\n";
  writeFileSync(path, before);
  const input: IntegrationWriteInput = {
    clientId: "github-copilot", config, port: 10100, models: context.models,
    home, env: {}, store: createIntegrationStateStore(join(home, "store")),
  };
  return { path, original, before, input, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

describe("GitHub Copilot client integration", () => {
  test("the provider routes Copilot's OpenAI provider through the proxy with a non-secret placeholder", () => {
    const doc = buildGithubCopilotClientConfig(context);
    expect(doc.providers).toEqual([{
      name: "opencodex", type: "openai", baseUrl: context.baseUrl, apiKey: "opencodex-loopback",
    }]);
    // Sorted by the proxy selector, with the bare slug as the picker id and the
    // selector as the name the CLI sends upstream.
    expect(doc.models).toEqual([
      { id: "alpha", provider: "opencodex", wireModel: "mock/alpha", maxPromptTokens: 200000 },
      { id: "beta", provider: "opencodex", wireModel: "mock/beta" },
    ]);
    const exported = buildClientConfigText("github-copilot", context);
    expect(exported.format).toBe("json");
    expect(exported.mediaType).toContain("application/json");
    expect(JSON.parse(exported.text)).toEqual(doc);
    expect(exported.text).not.toContain("sk-");
    expect(EXPORT_CLIENTS["github-copilot"].summarize(doc)).toEqual({ modelCount: 2, modelsWithoutLimits: 1 });
    expect(INTEGRATION_CLIENTS["github-copilot"].configPath({}, "/home/test")).toBe(join("/home/test", ".copilot", "providers.json"));
    expect(INTEGRATION_CLIENTS["github-copilot"].detectDir({}, "/home/test")).toBe(join("/home/test", ".copilot"));
  });

  test("COPILOT_HOME and COPILOT_PROVIDERS_CONFIG relocate the file, and a relative override is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-copilot-dir-"));
    roots.push(root);
    const relocated = join(root, "relocated-copilot");
    expect(githubCopilotConfigPath({ COPILOT_HOME: relocated }, "/home/test")).toBe(join(relocated, "providers.json"));
    expect(INTEGRATION_CLIENTS["github-copilot"].detectDir({ COPILOT_HOME: relocated }, "/home/test")).toBe(relocated);
    expect(githubCopilotConfigPath({ COPILOT_PROVIDERS_CONFIG: "~/copilot/mine.json" }, "/home/test"))
      .toBe(join("/home/test", "copilot", "mine.json"));
    expect(() => githubCopilotConfigPath({ COPILOT_HOME: "relative/copilot" }, "/home/test")).toThrow("COPILOT_HOME");
    expect(() => githubCopilotConfigPath({ COPILOT_PROVIDERS_CONFIG: "relative.json" }, "/home/test")).toThrow("COPILOT_PROVIDERS_CONFIG");

    mkdirSync(relocated, { recursive: true });
    writeFileSync(join(relocated, "providers.json"), JSON.stringify({ providers: [], models: [] }));
    const input: IntegrationWriteInput = {
      clientId: "github-copilot", config, port: 10100, models: context.models,
      home: root, env: { COPILOT_HOME: relocated }, store: createIntegrationStateStore(join(root, "store")),
    };
    expect(applyIntegration(input).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(relocated, "providers.json"), "utf8")).providers[0].name).toBe("opencodex");
    expect(existsSync(join(root, ".copilot"))).toBe(false);
    expect(disableIntegration(input).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(relocated, "providers.json"), "utf8"))).toEqual({ providers: [], models: [] });
  });

  test("refuses placeholders on remote or wildcard binds, including a loopback dial address", () => {
    for (const hostname of ["0.0.0.0", "::", "192.0.2.1"]) {
      expect(() => buildClientConfigText("github-copilot", { ...context, config: { ...config, hostname } })).toThrow("loopback");
    }
    expect(() => buildGithubCopilotClientConfig({ ...context, baseUrl: "https://example.com/v1" })).toThrow("loopback");
    expect(() => buildGithubCopilotClientConfig({ ...context, config: undefined, baseUrl: "http://[::1]:10100/v1" })).not.toThrow();
  });

  test("apply and refresh keep the user's provider, and disable removes only the owned rows", () => {
    const f = fixture();
    expect(readIntegrationState(f.input).state).toBe("absent");
    expect(applyIntegration(f.input).ok).toBe(true);
    const applied = f.read();
    expect(applied.providers.find((p: { name: string }) => p.name === "mine")).toEqual(f.original.providers[0]);
    expect(applied.models.map((m: { id: string }) => m.id).sort()).toEqual(["alpha", "beta", "mine"]);
    applied.providers.find((p: { name: string }) => p.name === "mine").apiKey = "rotated";
    writeFileSync(f.path, JSON.stringify(applied));
    const updated = { ...f.input, models: [context.models[1]!] };
    expect(refreshIntegration(updated).ok).toBe(true);
    const refreshed = f.read();
    expect(refreshed.models.map((m: { id: string }) => m.id).sort()).toEqual(["alpha", "mine"]);
    expect(refreshed.providers.find((p: { name: string }) => p.name === "mine").apiKey).toBe("rotated");
    expect(disableIntegration({ ...updated, config: { ...config, hostname: "0.0.0.0" } }).ok).toBe(true);
    expect(f.read()).toEqual({
      ...f.original,
      providers: [{ ...f.original.providers[0], apiKey: "rotated" }],
    });
  });

  test("restore recovers the exact prior bytes, and a non-loopback apply writes nothing", () => {
    const f = fixture();
    const refused = applyIntegration({ ...f.input, config: { ...config, hostname: "0.0.0.0" } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("non_loopback");
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
    expect(applyIntegration(f.input).ok).toBe(true);
    const opId = f.input.store!.listOperations("github-copilot")[0]!.opId;
    expect(restoreIntegration({ ...f.input, opId }).ok).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });

  test("an unaddressable model id refuses apply without writing", () => {
    const f = fixture();
    const bad = { ...f.input, models: [{ namespaced: "mock/a]b", provider: "mock", id: "a]b" }] };
    const refused = applyIntegration(bad);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("unsafe");
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
    expect(buildClientContribution("github-copilot", context).fragments.map(fragment => fragment.path)).toEqual([
      ["providers", "[name=opencodex]"],
      ["models", "[id=alpha]"],
      ["models", "[id=beta]"],
    ]);
  });

  test("the export CLI writes Copilot JSON and refuses a remote placeholder without replacing the file", async () => {
    const f = fixture();
    const oldHome = process.env.OPENCODEX_HOME;
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = join(f.input.home!, "ocx");
    process.env.CODEX_HOME = join(f.input.home!, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    const live = (hostname: string) => ({
      ...config, hostname,
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1", liveModels: false, models: ["alpha", "beta"] } },
    }) as OcxConfig;
    let liveConfig = live("127.0.0.1");
    const server = Bun.serve({
      port: 0,
      fetch: async req => await handleManagementAPI(req, new URL(req.url), liveConfig) ?? new Response("not found", { status: 404 }),
    });
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const output = join(f.input.home!, "export.json");
      const deps = { baseUrl: `http://127.0.0.1:${server.port}`, configImpl: () => config };
      expect(await handleExportCommand(["--client", "github-copilot", "--out", output], deps)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).providers[0].baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const before = readFileSync(output, "utf8");
      liveConfig = live("0.0.0.0");
      expect(await handleExportCommand(["--client", "github-copilot", "--out", output, "--force"], deps)).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe(before);
    } finally {
      console.log = log;
      console.error = error;
      server.stop(true);
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });
});
