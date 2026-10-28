import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildT3CodeClientConfig, t3codeConfigPath, type ExportContext } from "../../src/clients/config-export";
import { PROXY_MARKER } from "../../src/claude/auth-detect";
import { handleExportCommand } from "../../src/cli/export-command";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
const context: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1", config,
  models: [
    { namespaced: "mock/b", provider: "mock", id: "b" },
    { namespaced: "mock/a", provider: "mock", id: "a", displayName: "Model A", fastRowAvailable: true },
  ],
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

/** A settings.json T3 Code wrote itself: its own Codex account beside unrelated settings. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-t3code-test-"));
  roots.push(home);
  const path = t3codeConfigPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  const original = {
    favorites: [{ instanceId: "codex", model: "gpt-5.5" }],
    providerInstances: { codex_personal: { driver: "codex", config: { homePath: "~/.codex", shadowHomePath: "~/.codex_personal" } } },
  };
  const before = JSON.stringify(original, null, 2) + "\n";
  writeFileSync(path, before);
  const input: IntegrationWriteInput = {
    clientId: "t3code", config, port: 10100, models: context.models,
    home, env: {}, store: createIntegrationStateStore(join(home, "store")),
  };
  return { path, original, before, input, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

describe("T3 Code client integration", () => {
  test("the provider instance routes T3 Code's Claude driver through the proxy origin with a non-secret marker", () => {
    const instance = buildT3CodeClientConfig(context).providerInstances.opencodex;
    expect(instance.driver).toBe("claudeAgent");
    // Claude Code appends /v1/messages itself, so the origin must not carry /v1.
    expect(instance.environment).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:10100", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: PROXY_MARKER, sensitive: false },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      { name: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", value: "1", sensitive: false },
    ]);
    // Slugs are the proxy selectors T3 Code sends verbatim, in normalized order with Fast rows.
    expect(instance.config.customModels).toEqual([
      { slug: "mock/a", name: "Model A" },
      { slug: "mock/a--fast", name: "Model A Fast" },
      { slug: "mock/b", name: "mock/b" },
    ]);
  });

  test("refuses any listener that would need an admission header", () => {
    expect(() => buildT3CodeClientConfig({ ...context, config: { ...config, hostname: "0.0.0.0" } })).toThrow("loopback");
    expect(() => buildT3CodeClientConfig({ ...context, baseUrl: "http://192.168.1.4:10100/v1" })).toThrow("loopback");
    // The dedicated unauthenticated listener is what makes a wildcard bind exportable.
    expect(buildT3CodeClientConfig({
      ...context,
      baseUrl: "http://127.0.0.1:10237/v1",
      config: { ...config, hostname: "0.0.0.0", unauthenticatedLoopbackListener: { enabled: true, port: 10237 } },
    }).providerInstances.opencodex.environment[0]!.value).toBe("http://127.0.0.1:10237");
  });

  test("T3CODE_HOME relocates the settings file and detection, and a relative value is refused", () => {
    const home = join(tmpdir(), "ocx-t3code-path-home");
    const relocated = join(tmpdir(), "ocx-t3code-path-override");
    expect(t3codeConfigPath({ T3CODE_HOME: relocated }, home)).toBe(join(relocated, "userdata", "settings.json"));
    expect(t3codeConfigPath({ T3CODE_HOME: "~/t3-work" }, home)).toBe(join(home, "t3-work", "userdata", "settings.json"));
    expect(INTEGRATION_CLIENTS.t3code.detectDir({}, "/home/test")).toBe(join("/home/test", ".t3", "userdata"));
    expect(() => t3codeConfigPath({ T3CODE_HOME: "relative/t3" }, "/home/test")).toThrow("T3CODE_HOME");
  });

  test("apply and refresh keep T3 Code's own instances; disable restores the file it wrote", () => {
    const f = fixture();
    expect(applyIntegration(f.input).ok).toBe(true);
    const applied = f.read();
    expect(applied.favorites).toEqual(f.original.favorites);
    expect(applied.providerInstances.codex_personal).toEqual(f.original.providerInstances.codex_personal);
    expect(applied.providerInstances.opencodex.config.customModels.map((model: { slug: string }) => model.slug))
      .toEqual(["mock/a", "mock/a--fast", "mock/b"]);

    const refreshed = refreshIntegration({ ...f.input, models: [{ namespaced: "mock/c", provider: "mock", id: "c" }] });
    expect(refreshed.ok).toBe(true);
    expect(f.read().providerInstances.opencodex.config.customModels).toEqual([{ slug: "mock/c", name: "mock/c" }]);
    expect(f.read().providerInstances.codex_personal).toEqual(f.original.providerInstances.codex_personal);

    expect(disableIntegration({ ...f.input, models: [{ namespaced: "mock/c", provider: "mock", id: "c" }] }).ok).toBe(true);
    expect(f.read()).toEqual(f.original);
  });

  test("an edit T3 Code makes to our instance is a conflict, never silently overwritten", () => {
    const f = fixture();
    expect(applyIntegration(f.input).ok).toBe(true);
    // Marking a variable sensitive moves its value into T3 Code's secret store and blanks it here.
    const edited = f.read();
    edited.providerInstances.opencodex.environment[1] = { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true };
    writeFileSync(f.path, JSON.stringify(edited, null, 2) + "\n");
    const refreshed = refreshIntegration(f.input);
    expect(refreshed.ok).toBe(false);
    expect(f.read()).toEqual(edited);
    expect(disableIntegration(f.input).ok).toBe(false);
    expect(f.read()).toEqual(edited);
  });

  test("restore recovers exact prior bytes, and a non-loopback apply writes nothing", () => {
    const f = fixture();
    const refused = applyIntegration({ ...f.input, config: { ...config, hostname: "0.0.0.0" } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("non_loopback");
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
    expect(applyIntegration(f.input).ok).toBe(true);
    const opId = f.input.store!.listOperations("t3code")[0]!.opId;
    expect(restoreIntegration({ ...f.input, opId }).ok).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });

  test("the export CLI asks the live server, which refuses a wildcard bind without a loopback listener", async () => {
    const f = fixture();
    const oldHome = process.env.OPENCODEX_HOME;
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = join(f.input.home!, "ocx");
    process.env.CODEX_HOME = join(f.input.home!, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    const live = (overrides: Partial<OcxConfig>) => ({
      ...config,
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1", liveModels: false, models: ["a"] } },
      ...overrides,
    }) as OcxConfig;
    let liveConfig = live({ hostname: "0.0.0.0", unauthenticatedLoopbackListener: { enabled: true, port: 10237 } });
    const server = Bun.serve({
      port: 0,
      fetch: async req => await handleManagementAPI(req, new URL(req.url), liveConfig) ?? new Response("not found", { status: 404 }),
    });
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const output = join(f.input.home!, "t3code-settings.json");
      // The saved config contradicts the live listener port; the live server must win.
      const deps = { baseUrl: `http://127.0.0.1:${server.port}`, configImpl: () => live({ unauthenticatedLoopbackListener: { enabled: true, port: 10999 } }) };
      expect(await handleExportCommand(["--client", "t3code", "--out", output], deps)).toBe(0);
      const exported = JSON.parse(readFileSync(output, "utf8"));
      expect(exported.providerInstances.opencodex.environment[0].value).toBe("http://127.0.0.1:10237");
      const before = readFileSync(output, "utf8");
      liveConfig = live({ hostname: "0.0.0.0" });
      expect(await handleExportCommand(["--client", "t3code", "--out", output, "--force"], deps)).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe(before);
      expect(existsSync(f.path)).toBe(true);
      expect(readFileSync(f.path, "utf8")).toBe(f.before);
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
