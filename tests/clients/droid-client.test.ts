import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientConfigText, buildClientContribution, droidConfigPath, droidHomeDir,
  type DroidGeneratedConfig, type ExportModel,
} from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS, resolveIntegrationPaths } from "../../src/integrations/registry";
import { readIntegrationState } from "../../src/integrations/state";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, restoreIntegration } from "../../src/integrations/writer";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CONFIG = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-fable-5-1", provider: "anthropic", id: "claude-fable-5-1", displayName: "Claude Fable 5.1", inputModalities: ["text", "image"] },
  { namespaced: "mock/text", provider: "mock", id: "text", inputModalities: ["text"] },
];
const BASE = "http://127.0.0.1:10100/v1";
let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-droid-home-"));
  store = createIntegrationStateStore(mkdtempSync(join(tmpdir(), "ocx-droid-store-")));
});
afterEach(() => { removeTreeWithRetry(home); removeTreeWithRetry(store.root); });

function install(seed?: string) {
  const dir = INTEGRATION_CLIENTS.droid.detectDir({}, home);
  mkdirSync(dir, { recursive: true });
  const path = INTEGRATION_CLIENTS.droid.configPath({}, home);
  if (seed !== undefined) writeFileSync(path, seed);
  return path;
}
function request(models: ExportModel[] = MODELS) {
  return { clientId: "droid" as const, models, config: CONFIG, port: 10100, env: {}, home, store };
}
function read(path: string): { customModels: Array<Record<string, unknown>>; theme?: string } {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Factory Droid documented personal settings", () => {
  test("exports only supported fields with a keyless loopback gateway", () => {
    const built = buildClientConfigText("droid", { baseUrl: BASE, models: MODELS, config: CONFIG });
    expect(built.format).toBe("json");
    expect(built.document).toEqual({ customModels: [
      { model: "anthropic/claude-fable-5-1", displayName: "OpenCodex: Claude Fable 5.1", baseUrl: BASE, provider: "generic-chat-completion-api", noImageSupport: false },
      { model: "mock/text", displayName: "OpenCodex: Text", baseUrl: BASE, provider: "generic-chat-completion-api", noImageSupport: true },
    ] } satisfies DroidGeneratedConfig);
    expect(JSON.parse(built.text)).toEqual(built.document);
    expect(built.text).not.toContain("apiKey");
    expect(buildClientContribution("droid", { baseUrl: BASE, models: MODELS }).fragments.map(f => f.path)).toEqual([
      ["customModels", "[v2:model=anthropic/claude-fable-5-1,displayName=OpenCodex: Claude Fable 5.1]"],
      ["customModels", "[v2:model=mock/text,displayName=OpenCodex: Text]"],
    ]);
  });

  test("skips models that cannot be addressed by managed selectors", () => {
    const models: ExportModel[] = [
      { namespaced: "mock/a,b", provider: "mock", id: "a,b", inputModalities: ["text"] },
      { namespaced: "mock/c]d", provider: "mock", id: "c]d", inputModalities: ["text"] },
      { namespaced: "mock/comma-label", provider: "mock", id: "comma-label", displayName: "Comma, label" },
      MODELS[1]!,
    ];
    const path = install('{"customModels":[]}\n');
    const input = request(models);
    expect(readIntegrationState(input).state).toBe("absent");
    expect(previewIntegration(input, { operation: "apply" })).toMatchObject({ canApply: true, willChange: true });
    const context = { baseUrl: BASE, models, config: CONFIG };
    const exported = buildClientConfigText("droid", context);
    const document = exported.document as DroidGeneratedConfig;
    const fragments = buildClientContribution("droid", context).fragments;
    expect(document.customModels.map(row => row.model)).toEqual(["mock/text"]);
    expect(JSON.parse(exported.text)).toEqual(document);
    expect(fragments.map(fragment => fragment.value)).toEqual(document.customModels);
    expect(fragments.map(fragment => fragment.path)).toEqual([
      ["customModels", "[v2:model=mock/text,displayName=OpenCodex: Text]"],
    ]);
    expect(applyIntegration(input).ok).toBe(true);
    expect(read(path).customModels.map(row => row.model)).toEqual(["mock/text"]);
  });

  test("resolves macOS and Windows-shaped homes without writing to the real home", () => {
    expect(droidHomeDir({}, home)).toBe(join(home, ".factory"));
    expect(droidConfigPath({}, home)).toBe(join(home, ".factory", "settings.json"));
    expect(droidConfigPath({}, "C:\\Users\\Ada")).toBe("C:\\Users\\Ada\\.factory\\settings.json");
  });

  test("absent client refuses apply and creates no settings", () => {
    expect(applyIntegration(request())).toMatchObject({ ok: false, reason: "not_installed" });
    expect(existsSync(droidConfigPath({}, home))).toBe(false);
  });

  test("apply preserves foreign settings and models; disable removes only owned rows", () => {
    const foreign = { model: "local", displayName: "Local", baseUrl: "http://127.0.0.1:11434/v1", provider: "generic-chat-completion-api" };
    const seed = JSON.stringify({ theme: "dark", customModels: [foreign] }, null, 2) + "\n";
    const path = install(seed);
    expect(applyIntegration(request()).ok).toBe(true);
    expect(read(path).customModels).toEqual([foreign, ...((buildClientConfigText("droid", { baseUrl: BASE, models: MODELS }).document as DroidGeneratedConfig).customModels)]);
    expect(disableIntegration(request()).ok).toBe(true);
    expect(read(path)).toEqual({ theme: "dark", customModels: [foreign] });
  });

  test("catalog refresh touches only an already owned Droid file", async () => {
    const path = install('{"customModels":[]}\n');
    expect(await refreshOwnedCatalogIntegrations({ models: MODELS, config: CONFIG, port: 10100, env: {}, home, store })).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe('{"customModels":[]}\n');
    expect(applyIntegration(request()).ok).toBe(true);
    expect(await refreshOwnedCatalogIntegrations({ models: MODELS.slice(0, 1), config: CONFIG, port: 10100, env: {}, home, store })).toEqual([
      { client: "droid", ok: true, changed: true },
    ]);
    expect(read(path).customModels.map(row => row.model)).toEqual([MODELS[0]!.namespaced]);
  });

  test("restore returns exact prior bytes", () => {
    const seed = '{\n "customModels":[], "theme":"dark"\n}\n';
    const path = install(seed);
    expect(applyIntegration(request()).ok).toBe(true);
    const opId = store.listOperations("droid")[0]!.opId;
    expect(restoreIntegration({ ...request(), opId }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(seed);
  });

  test("IPv6 loopback exports every row and disable/restore round-trip exact bytes", () => {
    const seed = '{\n  "theme": "dark",\n  "customModels": []\n}\n';
    const path = install(seed);
    const input = { ...request(), config: { ...CONFIG, hostname: "::1" } };
    const ipv6Base = "http://[::1]:10100/v1";
    const exported = buildClientConfigText("droid", { baseUrl: ipv6Base, models: MODELS, config: input.config });
    expect((exported.document as DroidGeneratedConfig).customModels.map(row => row.baseUrl)).toEqual([ipv6Base, ipv6Base]);
    expect(readIntegrationState(input).state).toBe("absent");
    expect(previewIntegration(input, { operation: "apply" }).canApply).toBe(true);
    expect(applyIntegration(input).ok).toBe(true);
    const applied = readFileSync(path, "utf8");
    expect(read(path).customModels).toHaveLength(MODELS.length);
    const applyOpId = store.listOperations("droid")[0]!.opId;
    expect(disableIntegration(input).ok).toBe(true);
    expect(read(path).customModels).toEqual([]);
    const disableOpId = store.listOperations("droid")[0]!.opId;
    expect(restoreIntegration({ ...input, opId: disableOpId }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(applied);
    expect(restoreIntegration({ ...input, opId: applyOpId }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(seed);
  });

  test("a foreign row with the same model and different displayName remains untouched", () => {
    const foreign = { model: MODELS[0]!.namespaced, displayName: "Personal", baseUrl: BASE, provider: "generic-chat-completion-api" };
    const path = install(JSON.stringify({ customModels: [foreign] }) + "\n");
    expect(applyIntegration(request()).ok).toBe(true);
    expect(read(path).customModels[0]).toEqual(foreign);
    expect(disableIntegration(request()).ok).toBe(true);
    expect(read(path).customModels).toEqual([foreign]);
  });

  test("a nonempty catalog with no addressable rows refuses before mutation", () => {
    const models: ExportModel[] = [
      { namespaced: "mock/a,b", provider: "mock", id: "a,b" },
      { namespaced: "mock/c]d", provider: "mock", id: "c]d" },
    ];
    const seed = '{"customModels":[]}\n';
    const path = install(seed);
    const input = request(models);
    expect(() => buildClientConfigText("droid", { baseUrl: BASE, models, config: CONFIG })).toThrow("no addressable models");
    expect(readIntegrationState(input).state).toBe("unsafe");
    expect(previewIntegration(input, { operation: "apply" })).toMatchObject({ canApply: false, refusalReason: "unsafe" });
    expect(applyIntegration(input).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(seed);
    expect(store.listOperations("droid")).toHaveLength(0);
    expect(existsSync(join(store.root, "snapshots", "droid"))).toBe(false);
  });

  for (const [name, models] of [
    ["empty", []],
    ["unaddressable", [{ namespaced: "mock/a,b", provider: "mock", id: "a,b" }]],
  ] as const) {
    test(`disable removes recorded rows after the catalog becomes ${name}`, () => {
      const foreign = { model: "personal", displayName: "Personal", baseUrl: "http://localhost:11434/v1" };
      const path = install(JSON.stringify({ customModels: [foreign] }) + "\n");
      expect(applyIntegration(request()).ok).toBe(true);
      const changed = request([...models]);
      expect(readIntegrationState(changed).state).toBe("stale");
      expect(previewIntegration(changed, { operation: "disable" })).toMatchObject({ canApply: true, willChange: true });
      expect(previewIntegration(changed, { operation: "apply" }).canApply).toBe(false);
      expect(disableIntegration(changed)).toMatchObject({ ok: true, changed: true, state: "absent" });
      expect(read(path).customModels).toEqual([foreign]);
    });
  }

  test("catalog loss does not authorize removal of a foreign edit", () => {
    const path = install('{"customModels":[]}\n');
    expect(applyIntegration(request()).ok).toBe(true);
    const edited = read(path);
    edited.customModels[0]!.baseUrl = "http://localhost:11434/v1";
    writeFileSync(path, JSON.stringify(edited));
    expect(disableIntegration(request([]))).toMatchObject({ ok: false, reason: "conflict" });
    expect(read(path).customModels[0]!.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("catalog loss still refuses a legacy row with a recorded model ID", () => {
    const path = install('{"customModels":[]}\n');
    expect(applyIntegration(request()).ok).toBe(true);
    const before = readFileSync(path, "utf8");
    writeFileSync(join(droidHomeDir({}, home), "config.json"), JSON.stringify({ custom_models: [
      { model: MODELS[0]!.namespaced, display_name: "Personal", base_url: "http://localhost:11434/v1" },
    ] }));
    expect(readIntegrationState(request([]))).toMatchObject({ state: "unsafe", reason: "unresolvable-path" });
    expect(previewIntegration(request([]), { operation: "disable" }).canApply).toBe(false);
    expect(disableIntegration(request([])).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses ambiguous rows, symlink targets, and edited managed rows", () => {
    const row = { model: MODELS[0]!.namespaced, displayName: "OpenCodex: Claude Fable 5.1", baseUrl: BASE, provider: "generic-chat-completion-api" };
    const ambiguous = JSON.stringify({ customModels: [row, row] });
    const path = install(ambiguous);
    expect(applyIntegration(request()).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(ambiguous);
    writeFileSync(path, '{"customModels":[]}');
    expect(applyIntegration(request()).ok).toBe(true);
    const edited = read(path);
    edited.customModels[0]!.displayName = "User edit";
    writeFileSync(path, JSON.stringify(edited));
    expect(disableIntegration(request()).ok).toBe(false);
    expect(read(path).customModels[0]!.displayName).toBe("User edit");
    // A fresh installation with a final symlink must never follow that link.
    const other = mkdtempSync(join(tmpdir(), "ocx-droid-link-"));
    try {
      const target = join(other, "settings.json");
      writeFileSync(target, "{}\n");
      const linkedHome = mkdtempSync(join(tmpdir(), "ocx-droid-linked-home-"));
      try {
        mkdirSync(join(linkedHome, ".factory"));
        symlinkSync(target, join(linkedHome, ".factory", "settings.json"));
        expect(applyIntegration({ ...request(), home: linkedHome }).ok).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("{}\n");
      } finally { removeTreeWithRetry(linkedHome); }
      const parentHome = mkdtempSync(join(tmpdir(), "ocx-droid-parent-home-"));
      try {
        symlinkSync(other, join(parentHome, ".factory"), "dir");
        expect(applyIntegration({ ...request(), home: parentHome }).ok).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("{}\n");
      } finally { removeTreeWithRetry(parentHome); }
    } finally { removeTreeWithRetry(other); }
  });

  test("refuses competing local or legacy OpenCodex models before mutation", () => {
    const path = install('{"customModels":[]}\n');
    const dir = droidHomeDir({}, home);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ custom_models: [{ display_name: "OpenCodex: Existing" }] }));
    expect(() => resolveIntegrationPaths("droid", {}, home)).toThrow("config.json");
    expect(applyIntegration(request()).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"customModels":[]}\n');
    writeFileSync(join(dir, "config.json"), '{"custom_models":[]}');
    writeFileSync(join(dir, "settings.local.json"), '{"customModels":[]}');
    expect(() => resolveIntegrationPaths("droid", {}, home)).toThrow("settings.local.json");
  });

  test("a competing local override created after preflight refuses before snapshot or write", () => {
    const seed = '{"customModels":[]}\n';
    const path = install(seed);
    const local = join(droidHomeDir({}, home), "settings.local.json");
    const baseIO = store.io();
    let selectedReads = 0;
    const result = applyIntegration({ ...request(), io: {
      ...baseIO,
      readText(candidate) {
        const read = baseIO.readText(candidate);
        if (candidate === path && ++selectedReads === 2) {
          writeFileSync(local, '{"customModels":[]}\n');
        }
        return read;
      },
    } });
    expect(selectedReads).toBe(2);
    expect(result).toMatchObject({ ok: false, reason: "unsafe" });
    if (!result.ok) expect(result.message).toContain("settings.local.json");
    expect(readFileSync(path, "utf8")).toBe(seed);
    expect(store.listOperations("droid")).toHaveLength(0);
    expect(existsSync(join(store.root, "snapshots", "droid"))).toBe(false);
  });

  for (const [caseName, row] of [
    ["legacy OpenCodex display name", { model: "other", display_name: "OpenCodex: Existing", base_url: "http://example.test/v1" }],
    ["same generated model id", { model: MODELS[0]!.namespaced, display_name: "Personal", base_url: "http://example.test/v1" }],
    ["localhost endpoint with trailing slash", { model: "other", display_name: "Personal", base_url: "http://localhost:10100/v1/" }],
    ["IPv6 loopback endpoint", { model: "other", display_name: "Personal", base_url: "http://[::1]:10100/v1" }],
  ] as const) {
    test(`refuses ${caseName} before snapshot or write`, () => {
      const seed = '{"customModels":[]}\n';
      const path = install(seed);
      writeFileSync(join(droidHomeDir({}, home), "config.json"), JSON.stringify({ custom_models: [row] }));
      const input = caseName === "same generated model id"
        ? { ...request(), resolvedPaths: { configPath: path, detectDir: droidHomeDir({}, home) } }
        : request();
      expect(readIntegrationState(input)).toMatchObject({ state: "unsafe", reason: "unresolvable-path" });
      expect(previewIntegration(input, { operation: "apply" })).toMatchObject({ canApply: false, refusalReason: "unsafe" });
      const result = applyIntegration(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("config.json");
        expect(result.message).not.toContain("http");
      }
      expect(readFileSync(path, "utf8")).toBe(seed);
      expect(store.listOperations("droid")).toHaveLength(0);
      expect(existsSync(join(store.root, "snapshots", "droid"))).toBe(false);
    });
  }

  test("allows a non-colliding legacy model", () => {
    const path = install('{"customModels":[]}\n');
    writeFileSync(join(droidHomeDir({}, home), "config.json"), JSON.stringify({ custom_models: [
      { model: "personal", display_name: "Personal", base_url: "http://localhost:11434/v1/" },
    ] }));
    expect(readIntegrationState(request()).state).toBe("absent");
    expect(previewIntegration(request(), { operation: "apply" }).canApply).toBe(true);
    expect(applyIntegration(request()).ok).toBe(true);
    expect(read(path).customModels).toHaveLength(MODELS.length);
  });
});
