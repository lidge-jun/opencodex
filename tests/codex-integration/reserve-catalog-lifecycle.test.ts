import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawCatalog, RawEntry } from "../../src/codex/catalog/parsing";
import { claimOwnedServiceHome, withOwnedServiceHomePreload } from "../helpers/owned-service-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";

const roots: string[] = [];
const SOURCE = "opencodex_reserve_source";
const MARKER = "opencodex_reserve_metadata_source";
const SELECTOR = "personal/gpt-reserve";

interface Sandbox {
  root: string;
  catalogPath: string;
  cachePath: string;
  bundledPath: string;
  env: Record<string, string>;
  preloadPath?: string;
}

function nativeRow(slug = "gpt-5.5"): RawEntry {
  return {
    slug, display_name: "Fixture native", description: "Fixture",
    priority: 9, visibility: "list", supported_in_api: true,
    shell_type: "unified_exec", comp_hash: "fixture-comp-hash",
    base_instructions: "Fixture instructions.",
    model_messages: { instructions_template: "Fixture instructions." },
    supported_reasoning_levels: [{ effort: "medium", description: "Runtime medium" }],
    default_reasoning_level: "medium",
  };
}

function reserveRow(qualified: boolean, efforts = ["high", "xhigh"]): RawEntry {
  const pin = JSON.parse(readFileSync(repoPath("src/codex/data/upstream-models.json"), "utf8")) as RawCatalog;
  const luna = pin.models?.find(row => row.slug === "gpt-5.6-luna");
  if (!luna) throw new Error("Fixture requires the checked-in Luna source");
  return {
    ...structuredClone(luna),
    slug: qualified ? SELECTOR : "gpt-reserve",
    display_name: qualified ? "personal / Genuine Reserve" : "Genuine Reserve",
    supported_in_api: qualified,
    visibility: qualified ? "list" : "hide",
    multi_agent_version: "disabled",
    comp_hash: "genuine-reserve-comp-hash",
    supported_reasoning_levels: efforts.map(effort => ({ effort, description: `Genuine ${effort}` })),
    default_reasoning_level: efforts.at(-1),
    ...(qualified ? { opencodex_catalog_kind: "account-selector-v1", [MARKER]: "gpt-reserve" } : {}),
  };
}

function writeRuntime(sandbox: Sandbox, efforts: string[]): void {
  writeFileSync(sandbox.bundledPath, JSON.stringify({ models: [{
    ...nativeRow(),
    supported_reasoning_levels: efforts.map(effort => ({ effort, description: `Runtime ${effort}` })),
    default_reasoning_level: efforts[0],
  }] }));
}

function makeSandbox(models: RawEntry[] = [nativeRow()], rootFields: RawEntry = {}): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-reserve-lifecycle-")));
  roots.push(root);
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const ocxHome = join(root, "ocx-home");
  const runtime = join(root, "runtime");
  for (const path of [home, codexHome, ocxHome, runtime]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const owned = claimOwnedServiceHome(codexHome, ocxHome, home);
  const bundledPath = join(root, "bundled-models.json");
  const runtimeScript = join(root, "codex-fixture.mjs");
  writeFileSync(runtimeScript, [
    'import { readFileSync } from "node:fs";',
    'if (process.argv.includes("--version")) console.log("codex-cli 0.999.0");',
    `else process.stdout.write(readFileSync(${JSON.stringify(bundledPath)}, "utf8"));`,
  ].join("\n"));
  const command = join(root, process.platform === "win32" ? "codex-fixture.cmd" : "codex-fixture");
  writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${runtimeScript}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${runtimeScript}" "$@"\n`);
  if (process.platform !== "win32") chmodSync(command, 0o700);
  const catalogPath = join(codexHome, "opencodex-catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ ...rootFields, models }));
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n[features]\nmulti_agent_v2 = true\n');
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port: 10100, hostname: "127.0.0.1", defaultProvider: "external",
    codexDesktopAuthless: true, codexAccountPickerEnabled: true,
    codexAccountNamespaces: { personal: "@main" },
    multiAgentMode: "default",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", liveModels: false },
      external: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["model"] },
    },
  }));
  const sandbox: Sandbox = {
    root, catalogPath, cachePath: join(codexHome, "models_cache.json"), bundledPath,
    preloadPath: owned.preloadPath,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...owned.env,
      CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome, CODEX_CLI_PATH: command,
      HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: runtime,
      TMPDIR: runtime, TEMP: runtime, TMP: runtime, LOCALAPPDATA: join(home, "LocalAppData"),
      BUN_OPTIONS: "", OPENAI_API_KEY: "", CODEX_ACCESS_TOKEN: "",
    },
  };
  writeRuntime(sandbox, ["medium"]);
  return sandbox;
}

function sync(sandbox: Sandbox): RawCatalog {
  const script = `
    const { readFileSync } = await import("node:fs");
    globalThis.fetch = async () => { throw new Error("Unexpected network access in Reserve catalog lifecycle"); };
    const { loadConfig } = await import("./src/config.ts");
    const { refreshCodexModelCatalog } = await import("./src/codex/refresh.ts");
    const { loadBundledCodexCatalog } = await import("./src/codex/catalog/bundled.ts");
    const bundled = loadBundledCodexCatalog();
    const expectedBundle = JSON.parse(readFileSync(${JSON.stringify(sandbox.bundledPath)}, "utf8"));
    if (JSON.stringify(bundled) !== JSON.stringify(expectedBundle)) throw new Error("Expected the isolated runtime catalog");
    if (bundled?.models?.some(row => row.slug === "gpt-reserve")) throw new Error("Fixture must not seed bundled Reserve");
    const config = loadConfig();
    for (const provider of Object.values(config.providers)) provider.fetch = globalThis.fetch;
    const result = await refreshCodexModelCatalog(config, undefined, { allowWhenDesiredDisabled: true });
    if (!result.catalogExists || !result.cacheSynced) throw new Error(JSON.stringify(result));
    console.log("RESERVE_CATALOG_LIFECYCLE_OK");
  `;
  const child = spawnSync(process.execPath, withOwnedServiceHomePreload(["--eval", script], sandbox.preloadPath), {
    cwd: repoRoot(), env: sandbox.env, encoding: "utf8", timeout: 30_000,
  });
  expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toMatchObject({ status: 0, error: undefined });
  expect(child.stdout).toContain("RESERVE_CATALOG_LIFECYCLE_OK");
  return JSON.parse(readFileSync(sandbox.catalogPath, "utf8")) as RawCatalog;
}

function selected(catalog: RawCatalog): RawEntry | undefined {
  return catalog.models?.find(row => row.slug === SELECTOR);
}

function retained(catalog: RawCatalog): RawEntry {
  return catalog[SOURCE] as RawEntry;
}

afterEach(() => {
  const identity = resolveEffectiveUserIdentity();
  for (const root of roots.splice(0)) {
    const database = resolveCodexCatalogSerializationDatabasePath(identity, join(root, "codex-home"));
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    removeTreeWithRetry(root);
  }
});

describe("Reserve actual catalog finalization lifecycle", () => {
  test("default Luna v1 survives the actual write and repeated cache invalidation", () => {
    const sandbox = makeSandbox();
    const first = sync(sandbox);
    expect(selected(first)).toMatchObject({ multi_agent_version: "v1", [MARKER]: "gpt-5.6-luna" });
    expect(first[SOURCE]).toBeUndefined();
    expect(first.models?.some(row => row.slug === "external/model")).toBe(true);
    const second = sync(sandbox);
    expect(selected(second)).toEqual(selected(first));
  }, 70_000);

  test("genuine bare active on-disk metadata wins over a bundled-only build base", () => {
    const sandbox = makeSandbox([nativeRow(), reserveRow(false, ["medium"])]);
    const result = sync(sandbox);
    expect(selected(result)).toMatchObject({ multi_agent_version: "disabled", [MARKER]: "gpt-reserve", comp_hash: "genuine-reserve-comp-hash" });
    expect(retained(result)).toMatchObject({ slug: "gpt-reserve", multi_agent_version: "disabled" });
    expect(retained(result)[MARKER]).toBeUndefined();
  }, 40_000);

  test("historical cached A cannot replace fresh active B on the following sync", () => {
    const cachedA = {
      ...reserveRow(false, ["medium"]),
      display_name: "Historical A",
      comp_hash: "historical-a-hash",
      opencodex_account_observed_native: true,
      opencodex_account_observed_selectors: ["personal"],
    };
    const activeB = {
      ...reserveRow(false, ["high"]),
      display_name: "Fresh B",
      comp_hash: "fresh-b-hash",
    };
    const sandbox = makeSandbox([nativeRow(), activeB]);
    writeRuntime(sandbox, ["medium", "high"]);
    writeFileSync(sandbox.cachePath, JSON.stringify({ models: [cachedA] }));

    const first = sync(sandbox);
    expect(selected(first)).toMatchObject({
      display_name: "personal / Fresh B", comp_hash: "fresh-b-hash",
      supported_reasoning_levels: [{ effort: "high", description: "Genuine high" }],
    });
    expect(retained(first)).toMatchObject({ display_name: "Fresh B", comp_hash: "fresh-b-hash" });
    const cacheAfterFirst = JSON.parse(readFileSync(sandbox.cachePath, "utf8")) as RawCatalog;
    // Prove the obsolete carried observation actually survives cache invalidation and
    // competes with retained B on the next real CLI-process sync.
    expect(cacheAfterFirst.models?.find(row => row.slug === "gpt-reserve")).toMatchObject({
      comp_hash: "historical-a-hash", opencodex_account_observed_native: true,
    });
    expect(first.models?.some(row => row.slug === "gpt-reserve")).toBe(false);

    const second = sync(sandbox);
    expect(retained(second)).toEqual(retained(first));
    expect(selected(second)).toEqual(selected(first));
    expect(second.models?.some(row => row.slug === "external/model")).toBe(true);
  }, 70_000);

  test("qualified-only source survives omission, cache invalidation and effort recovery without Luna fallback", () => {
    const sandbox = makeSandbox([nativeRow(), reserveRow(true)]);
    const first = sync(sandbox);
    expect(selected(first)).toBeUndefined();
    expect(retained(first)).toMatchObject({
      slug: "gpt-reserve", display_name: "Genuine Reserve", multi_agent_version: "disabled",
      supported_reasoning_levels: [
        { effort: "high", description: "Genuine high" }, { effort: "xhigh", description: "Genuine xhigh" },
      ],
    });
    expect(retained(first)[MARKER]).toBeUndefined();
    expect(retained(first).opencodex_catalog_kind).toBeUndefined();
    const cache = JSON.parse(readFileSync(sandbox.cachePath, "utf8")) as RawCatalog;
    expect(cache.models?.some(row => row.slug === SELECTOR || row.slug === "gpt-reserve")).toBe(false);
    const second = sync(sandbox);
    expect(selected(second)).toBeUndefined();
    expect(retained(second)).toEqual(retained(first));

    writeRuntime(sandbox, ["high"]);
    const partial = sync(sandbox);
    expect(selected(partial)).toMatchObject({
      multi_agent_version: "disabled", [MARKER]: "gpt-reserve", default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "high", description: "Genuine high" }],
    });
    expect(retained(partial)).toEqual(retained(first));

    writeRuntime(sandbox, ["high", "xhigh"]);
    const restored = sync(sandbox);
    expect(selected(restored)).toMatchObject({ default_reasoning_level: "xhigh", supported_reasoning_levels: retained(first).supported_reasoning_levels });
    const replacement = reserveRow(false, ["low"]);
    replacement.display_name = "Fresh source";
    writeFileSync(sandbox.catalogPath, JSON.stringify({ ...restored, models: [...restored.models!, replacement] }));
    writeRuntime(sandbox, ["low"]);
    const refreshed = sync(sandbox);
    expect(selected(refreshed)).toMatchObject({ display_name: "personal / Fresh source", default_reasoning_level: "low" });
    expect(retained(refreshed).supported_reasoning_levels).toEqual([{ effort: "low", description: "Genuine low" }]);
  }, 170_000);

  test("a retained adaptation is rejected rather than promoted to genuine source", () => {
    const adapted = { ...reserveRow(false, ["medium"]), [MARKER]: "gpt-5.6-luna" };
    const sandbox = makeSandbox([nativeRow()], { [SOURCE]: adapted });
    const result = sync(sandbox);
    expect(selected(result)).toMatchObject({ multi_agent_version: "v1", [MARKER]: "gpt-5.6-luna" });
    expect(result[SOURCE]).toBeUndefined();
  }, 40_000);
});
