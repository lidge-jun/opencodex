import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncModelsToCodex } from "../src/codex/sync";
import { MANAGED_AGENTS_TABLE_MARKER, MANAGED_SUBAGENT_DEFAULT_MARKER } from "../src/codex/subagent-defaults";
import type { OcxConfig } from "../src/types";
import type { OrcaCodexHomeDiagnostic } from "../src/codex/home";
import { claimOwnedServiceHome, withOwnedServiceHomePreload } from "./helpers/owned-service-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-sync-api");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const TEST_OCX_HOME = join(TEST_DIR, "ocx");
const TEST_HOME = join(TEST_DIR, "home");
const repoRoot = join(import.meta.dir, "..");
let prevCodexHome: string | undefined;
let prevOpenCodexHome: string | undefined;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let serviceManagerEnv: Record<string, string> = {};
let serviceManagerPreloadPath: string | undefined;

const config = {
  port: 0,
  defaultProvider: "fixture",
  providers: {
    fixture: {
      adapter: "openai-chat",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-key",
      allowPrivateNetwork: true,
      models: ["fixture-model"],
    },
  },
} as OcxConfig;

function claimTempHome(codexHome: string, ocxHome: string, home: string): void {
  const fixture = claimOwnedServiceHome(codexHome, ocxHome, home);
  serviceManagerEnv = fixture.env;
  serviceManagerPreloadPath = fixture.preloadPath;
}

function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...process.env, ...serviceManagerEnv, ...overrides } as Record<string, string>;
}

function childArgs(args: readonly string[]): string[] {
  return withOwnedServiceHomePreload(args, serviceManagerPreloadPath);
}

const admittedSync = () => ({ kind: "admitted" as const });

function homeDiagnostic(overrides: Partial<OrcaCodexHomeDiagnostic> = {}): OrcaCodexHomeDiagnostic {
  return {
    applicable: false,
    mismatch: false,
    effectiveCodexHome: "C:\\Users\\[USER]\\.codex",
    appCodexHome: "C:\\Users\\[USER]\\.codex",
    orcaCodexHome: null,
    warning: null,
    action: null,
    ...overrides,
  };
}

describe("GUI/CLI Codex sync backend", () => {
  beforeEach(() => {
    prevCodexHome = process.env.CODEX_HOME;
    prevOpenCodexHome = process.env.OPENCODEX_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    mkdirSync(TEST_OCX_HOME, { recursive: true });
    mkdirSync(TEST_HOME, { recursive: true });
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    process.env.OPENCODEX_HOME = TEST_OCX_HOME;
    process.env.HOME = TEST_HOME;
    process.env.USERPROFILE = TEST_HOME;
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    writeFileSync(join(TEST_OCX_HOME, "config.json"), JSON.stringify(config));
    claimTempHome(TEST_CODEX_HOME, TEST_OCX_HOME, TEST_HOME);
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevOpenCodexHome;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    serviceManagerEnv = {};
    serviceManagerPreloadPath = undefined;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });
  test("returns the structured sync result used by POST /api/sync", async () => {
    let injectedPort = 0;
    let injectedCatalogPath: string | null | undefined;

    const logs: string[] = [];
    const errors: string[] = [];
    const result = await syncModelsToCodex(12345, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => ({
        added: 3,
        path: "/tmp/opencodex-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [],
      }),
      injectCodexConfig: async (port, _config, options) => {
        injectedPort = port;
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected" };
      },
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(injectedPort).toBe(12345);
    expect(injectedCatalogPath).toBe("/tmp/opencodex-catalog.json");
    expect(result).toEqual({
      status: "applied",
      ok: true,
      added: 3,
      catalogPath: "/tmp/opencodex-catalog.json",
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
      message: "injected",
    });
    expect(logs).toContain("   Target Codex home: C:\\Users\\[USER]\\.codex");
    expect(errors).toEqual([]);
  });

  test("refuses during injection preflight before catalog or cache mutation", async () => {
    let refreshCalls = 0;
    let injectCalls = 0;
    const logs: string[] = [];
    const errors: string[] = [];
    const refusal = "Codex config injection refused: ambiguous managed defaults; inspect config.toml.";

    const result = await syncModelsToCodex(12345, config, {
      log: line => logs.push(String(line)),
      error: line => errors.push(String(line)),
    }, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => {
        refreshCalls++;
        throw new Error("catalog refresh must not run after a deterministic refusal");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectCalls++;
        expect(options.validateOnly).toBe(true);
        return { success: false, message: refusal };
      },
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(injectCalls).toBe(1);
    expect(refreshCalls).toBe(0);
    expect(result).toEqual({
      status: "applied",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: refusal,
    });
    expect(logs).toEqual(["   Target Codex home: C:\\Users\\[USER]\\.codex"]);
    expect(errors).toEqual([refusal]);
  });

  test("the real successful injection preflight writes no Codex artifacts", () => {
    const configPath = join(TEST_CODEX_HOME, "config.toml");
    const profilePath = join(TEST_CODEX_HOME, "opencodex.config.toml");
    const journalPath = join(TEST_CODEX_HOME, "opencodex-journal.json");
    const before = readFileSync(configPath, "utf8");

    const child = spawnSync(process.execPath, childArgs(["-e", `
      const { injectCodexConfig } = await import("./src/codex/inject.ts");
      const result = await injectCodexConfig(10100, ${JSON.stringify(config)}, { validateOnly: true });
      console.log(JSON.stringify(result));
    `]), {
      cwd: repoRoot,
      env: childEnv({
        HOME: TEST_HOME,
        USERPROFILE: TEST_HOME,
        CODEX_HOME: TEST_CODEX_HOME,
        OPENCODEX_HOME: TEST_OCX_HOME,
      }),
      encoding: "utf8",
    });

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({ success: true });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("returns a policy skip without touching the catalog or config", async () => {
    let refreshed = false;
    let injected = false;
    writeFileSync(join(TEST_OCX_HOME, "config.json"), JSON.stringify({
      ...config,
      clientIntegrations: { codex: false },
    }));
    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async () => {
        injected = true;
        throw new Error("must not inject");
      },
    });

    expect(result).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
    expect(refreshed).toBe(false);
    expect(injected).toBe(false);
  });

  test("explicit sync refreshes the catalog when Codex integration is OFF without injecting", async () => {
    let refreshed = 0;
    let injected = false;
    let refreshOptions: unknown;
    writeFileSync(join(TEST_OCX_HOME, "config.json"), JSON.stringify({
      ...config,
      clientIntegrations: { codex: false },
    }));
    const result = await syncModelsToCodex(12345, config, null, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async (_config: unknown, _deps: unknown, options: unknown) => {
        refreshed++;
        refreshOptions = options;
        return {
          added: 3,
          path: "/tmp/opencodex-catalog.json",
          catalogExists: true,
          catalogWritten: true,
          cacheSynced: true,
          comboOmissions: [],
        };
      },
      injectCodexConfig: async () => {
        injected = true;
        throw new Error("must not inject");
      },
      currentExternalCodexModelProvider: () => null,
    }, { catalogEvenWhenNotInjected: true });

    expect(refreshed).toBe(1);
    expect(refreshOptions).toEqual({ allowWhenDesiredDisabled: true });
    expect(injected).toBe(false);
    expect(result).toMatchObject({
      status: "catalog-only",
      ok: true,
      added: 3,
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
      catalogPath: "/tmp/opencodex-catalog.json",
    });
    expect(result.message).toContain("Codex config untouched");
  });

  test("explicit sync refreshes the catalog without injecting or touching the journal for an external provider", async () => {
    let refreshed = 0;
    let injectCalls = 0;
    const journalPath = join(TEST_CODEX_HOME, "opencodex-journal.json");
    const journalBytes = Buffer.from(JSON.stringify({ injectedOpenaiBaseUrl: "http://127.0.0.1:1/v1" }));
    writeFileSync(journalPath, journalBytes);
    const result = await syncModelsToCodex(10100, config, null, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => {
        refreshed++;
        return {
          added: 2,
          path: "/tmp/opencodex-catalog.json",
          catalogExists: true,
          catalogWritten: true,
          cacheSynced: true,
          comboOmissions: [],
        };
      },
      injectCodexConfig: async () => {
        injectCalls++;
        return { success: true, message: "external provider preserved" };
      },
      currentExternalCodexModelProvider: () => "custom",
    }, { catalogEvenWhenNotInjected: true });

    expect(refreshed).toBe(1);
    expect(injectCalls).toBe(0);
    expect(readFileSync(journalPath)).toEqual(journalBytes);
    expect(result).toMatchObject({
      status: "catalog-only",
      ok: true,
      added: 2,
      catalogExists: true,
      catalogWritten: true,
      cacheSynced: true,
    });
    expect(String(result.message)).toContain("journal untouched");
  });

  /**
   * The lost-transition race, with a REAL second process. The caller's config
   * snapshot says ON; while provider discovery is awaited, another process
   * persists OFF. The under-lock re-read inside the real injector must observe
   * the fresh persisted intent and skip — the snapshot must not win.
   *
   * Runs entirely in a child process with its own temp CODEX_HOME, because the
   * injector resolves its config path at module load: an in-process variant
   * would silently address the suite's isolated home instead of the fixture.
   */
  test("a competing OFF during catalog discovery becomes the discriminated skip", async () => {
    const raceRoot = mkdtempSync(join(tmpdir(), "ocx-sync-lost-transition-"));
    const raceCodexHome = join(raceRoot, ".codex");
    const raceOcxHome = join(raceRoot, ".opencodex");
    const raceHome = join(raceRoot, "home");
    mkdirSync(raceCodexHome, { recursive: true });
    mkdirSync(raceOcxHome, { recursive: true });
    mkdirSync(raceHome, { recursive: true });
    try {
      writeFileSync(join(raceCodexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
      writeFileSync(join(raceOcxHome, "config.json"), JSON.stringify(config));
      claimTempHome(raceCodexHome, raceOcxHome, raceHome);
      const script = [
        'const { spawnSync } = require("node:child_process");',
        'const { loadConfig } = require("./src/config");',
        'const { syncModelsToCodex } = require("./src/codex/sync");',
        'const { injectCodexConfig } = require("./src/codex/inject");',
        '(async () => {',
        '  const snapshot = loadConfig(); // admitted BEFORE the flip: reads as ON',
        '  const result = await syncModelsToCodex(12345, snapshot, null, {',
        '    refreshCodexModelCatalog: async () => {',
        '      // The provider-discovery window: a second real process persists OFF.',
        '      // This child only flips desired state; do not propagate the service-probe flag.',
        '      const flipEnv = { ...process.env }; delete flipEnv.OCX_TEST_SERVICE_HOME_PROBE;',
        '      const flip = spawnSync(process.execPath, ["--eval",',
        '        \'const { setIntegrationEnabled } = require("./src/codex/desired-state");\'',
        '        + \'const r = setIntegrationEnabled("codex", false);\'',
        '        + \'if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }\',',
        '      ], { cwd: process.cwd(), env: flipEnv, encoding: "utf8" });',
        '      if (flip.status !== 0) throw new Error("flip failed: " + flip.stderr);',
        '      return { added: 0, path: "/tmp/none.json", catalogExists: false, catalogWritten: false, cacheSynced: false, comboOmissions: [] };',
        '    },',
        '    injectCodexConfig, // the REAL injector; its under-lock re-read is the claim',
        '  });',
        '  console.log(JSON.stringify({ status: result.status, skippedReason: result.skippedReason, ok: result.ok }));',
        '})();',
      ].join("\n");
      const before = readFileSync(join(raceCodexHome, "config.toml"), "utf8");
      const child = spawnSync(process.execPath, childArgs(["--eval", script]), {
        cwd: repoRoot,
        env: childEnv({
          HOME: raceHome,
          USERPROFILE: raceHome,
          CODEX_HOME: raceCodexHome,
          OPENCODEX_HOME: raceOcxHome,
        }),
        encoding: "utf8",
      });
      expect(child.status).toBe(0);
      const line = child.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
      expect(JSON.parse(line)).toMatchObject({ status: "skipped", skippedReason: "desired_disabled", ok: true });
      // The stale ON snapshot wrote nothing: the fixture config is untouched.
      expect(readFileSync(join(raceCodexHome, "config.toml"), "utf8")).toBe(before);
    } finally {
      removeTreeWithRetry(raceRoot);
    }
  }, 15_000);

  test("surfaces combo catalog omissions in sync result and CLI stderr (#484)", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const omission = {
      id: "k3k3",
      targets: ["kimi/k3", "xianyu/kimi-k3"],
      reason: "incomplete_metadata" as const,
      message: "[opencodex] Combo \"k3k3\" is omitted from the catalog because member capabilities are incomplete: kimi/k3, xianyu/kimi-k3.",
    };
    const result = await syncModelsToCodex(12345, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => ({
        added: 1,
        path: "/tmp/opencodex-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [omission],
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(result.comboOmissions).toEqual([omission]);
    expect(result.warning).toContain("1 combo omitted from the catalog");
    expect(errors).toEqual([
      "1 combo omitted from the catalog because member capabilities are incomplete.",
    ]);
  });

  test("CLI sync summary uses incompatible_modalities reason, not incomplete (#516)", async () => {
    const errors: string[] = [];
    const omission = {
      id: "disjoint",
      targets: ["a/m1", "b/m2"],
      reason: "incompatible_modalities" as const,
      message: "[opencodex] Combo \"disjoint\" is omitted from the catalog because members have no common input modalities: a/m1, b/m2.",
    };
    const result = await syncModelsToCodex(12345, config, { log: () => {}, error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: "/tmp/opencodex-catalog.json",
        catalogExists: true,
        catalogWritten: true,
        cacheSynced: true,
        comboOmissions: [omission],
      }),
      injectCodexConfig: async () => ({ success: true, message: "injected" }),
      currentExternalCodexModelProvider: () => null,
      collectCodexHomeDiagnostic: () => homeDiagnostic(),
    });

    expect(result.comboOmissions).toEqual([omission]);
    expect(result.warning).toBe(
      "1 combo omitted from the catalog because members have no common input modalities.",
    );
    expect(errors).toEqual([
      "1 combo omitted from the catalog because members have no common input modalities.",
    ]);
    expect(errors.join("\n")).not.toContain("member capabilities are incomplete");
  });

  test("keeps injection fallback behavior when catalog refresh throws", async () => {
    let injectedCatalogPath: string | null | undefined = "unset";
    let injectionCalls = 0;

    const result = await syncModelsToCodex(undefined, config, null, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => {
        throw new Error("catalog boom");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectionCalls++;
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "injected fallback" };
      },
      currentExternalCodexModelProvider: () => null,
    });

    expect(injectionCalls).toBe(2);
    expect(injectedCatalogPath).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.catalogPath).toBeNull();
    expect(result.warning).toContain("catalog boom");
  });

  test("returns native subagent default conflicts as structured warnings", async () => {
    const result = await syncModelsToCodex(10100, config, null, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => ({
        added: 0,
        path: "/tmp/opencodex-catalog.json",
        catalogExists: true,
        cacheSynced: true,
      }),
      injectCodexConfig: async () => ({
        success: true,
        message: "injected with a preserved user setting",
        nativeSubagentDefaultsWarning: "Native Codex sub-agent defaults were not injected: user-owned agents.default_subagent_model preserved.",
      }),
      currentExternalCodexModelProvider: () => null,
    });

    expect(result.ok).toBe(true);
    expect(result.nativeSubagentDefaultsWarning).toContain("user-owned agents.default_subagent_model preserved");
  });

  test("POST /api/sync exposes an actionable error when native defaults are ambiguous", () => {
    const ocxHome = join(TEST_DIR, "opencodex");
    mkdirSync(ocxHome, { recursive: true });
    writeFileSync(join(TEST_CODEX_HOME, "config.toml"), [
      MANAGED_AGENTS_TABLE_MARKER,
      "[agents]",
      MANAGED_SUBAGENT_DEFAULT_MARKER,
      "",
      'default_subagent_model = "gpt-5.6-sol"',
      "",
    ].join("\n"), "utf8");

    const child = spawnSync(process.execPath, childArgs(["-e", `
      const { handleManagementAPI } = await import("./src/server/management-api.ts");
      const config = { port: 10100, defaultProvider: "openai", providers: {} };
      const response = await handleManagementAPI(
        new Request("http://localhost/api/sync", { method: "POST", headers: { Host: "localhost" } }),
        new URL("http://localhost/api/sync"),
        config,
      );
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `]), {
      cwd: join(import.meta.dir, ".."),
      env: childEnv({ CODEX_HOME: TEST_CODEX_HOME, OPENCODEX_HOME: ocxHome }),
      encoding: "utf8",
    });

    expect(child.status).toBe(0);
    const payload = JSON.parse(child.stdout.trim()) as {
      status: number;
      body: { ok: boolean; error?: string; message: string };
    };
    expect(payload.status).toBe(500);
    expect(payload.body.ok).toBe(false);
    expect(payload.body.error).toBe(payload.body.message);
    expect(payload.body.error).toContain("inspect");
    expect(payload.body.error).toContain(join(TEST_CODEX_HOME, "config.toml"));
  });

  test("skips catalog refresh before preserving an external provider", async () => {
    let refreshed = false;
    let injectedCatalogPath: string | null | undefined = "unset";
    const logs: string[] = [];
    const errors: string[] = [];
    const mismatch = homeDiagnostic({
      applicable: true,
      mismatch: true,
      effectiveCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      orcaCodexHome: "C:\\Users\\[USER]\\AppData\\Roaming\\orca\\codex-runtime-home\\home",
      warning: "Orca target does not reach the app",
      action: "migrate the installed service",
    });
    const result = await syncModelsToCodex(10100, config, { log: line => logs.push(String(line)), error: line => errors.push(String(line)) }, {
      admitCodexWrite: admittedSync,
      refreshCodexModelCatalog: async () => {
        refreshed = true;
        throw new Error("must not refresh");
      },
      injectCodexConfig: async (_port, _config, options) => {
        injectedCatalogPath = options.catalogPath;
        return { success: true, message: "external provider preserved" };
      },
      currentExternalCodexModelProvider: () => "custom",
      collectCodexHomeDiagnostic: () => mismatch,
    });

    expect(refreshed).toBe(false);
    expect(injectedCatalogPath).toBeUndefined();
    expect(result).toEqual({
      status: "applied",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: "external provider preserved",
    });
    expect(logs).toContain(`   Target Codex home: ${mismatch.effectiveCodexHome}`);
    expect(errors).toEqual([
      `WARNING: ${mismatch.warning}`,
      `Action: ${mismatch.action}`,
    ]);
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
