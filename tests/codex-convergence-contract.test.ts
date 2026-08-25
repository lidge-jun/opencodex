import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { captureCatalogAdmissionSnapshot } from "../src/codex/catalog-admission";
import {
  commitCodexCatalogCandidate,
  gatherCodexCatalogCandidate,
  type CodexCatalogCandidate,
} from "../src/codex/convergence";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND, resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import {
  persistCodexRuntime,
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
} from "../src/codex/runtime";
import {
  invalidateBundledCatalogCache,
  setBundledCatalogCacheForTests,
} from "../src/codex/catalog/bundled";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { saveConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

let root = "";
let codexHome = "";
let opencodexHome = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

function sourceCatalog(marker = "original"): string {
  return `${JSON.stringify({
    marker,
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Native",
      priority: 1,
      visibility: "list",
      base_instructions: "You are Codex.",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    }],
  }, null, 2)}\n`;
}

function manifest(base: string): string[] {
  const out: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      const name = relative(base, path);
      if (entry.isDirectory()) {
        out.push(`${name}|dir|${stat.mode}|${stat.mtimeNs}`);
        visit(path);
      } else {
        const bytes = readFileSync(path);
        out.push(`${name}|file|${stat.mode}|${stat.mtimeNs}|${bytes.length}|${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  visit(base);
  return out.sort();
}

async function candidate(): Promise<CodexCatalogCandidate> {
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config()));
  expect(gathered.kind).toBe("candidate");
  return (gathered as Extract<typeof gathered, { kind: "candidate" }>).candidate;
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-convergence-")));
  codexHome = join(root, "codex");
  opencodexHome = join(root, "opencodex");
  mkdirSync(codexHome);
  mkdirSync(opencodexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  saveConfig(config());
  writeFileSync(join(codexHome, "opencodex-catalog.json"), sourceCatalog());
});

afterEach(() => {
  const identity = resolveEffectiveUserIdentity();
  const kPath = resolveCodexCatalogSerializationDatabasePath(identity, codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${kPath}${suffix}`, { force: true });
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(root, { recursive: true, force: true });
});

test("T1 gather performs no filesystem write and does not materialize a runtime probe home", async () => {
  process.env.CODEX_CLI_PATH = join(root, "must-not-execute");
  const before = manifest(root);
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config()));
  expect(gathered.kind).toBe("candidate");
  expect(manifest(root)).toEqual(before);
  expect(existsSync(join(root, "probe-home"))).toBe(false);
  delete process.env.CODEX_CLI_PATH;
});

test("commit is fixed-order, receipt-exact, and a consumed candidate cannot be replayed", async () => {
  const gathered = await candidate();
  const first = await commitCodexCatalogCandidate(gathered, 1_000);
  expect(first).toEqual({
    kind: "committed",
    changed: true,
    writes: { keyedBackup: "written", legacyBackup: "written", catalog: "written", cache: "written" },
  });
  const after = manifest(root);
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({
    kind: "stale",
    reason: "candidate-consumed",
  });
  expect(manifest(root)).toEqual(after);
});

test("generation drift rejects before every catalog target write", async () => {
  const gathered = await candidate();
  const before = manifest(codexHome);
  saveConfig(config(20200));
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "generation" });
  expect(manifest(codexHome)).toEqual(before);
});

test("home-selection drift rejects before every catalog target write", async () => {
  const gathered = await candidate();
  const other = join(root, "other-codex");
  mkdirSync(other);
  process.env.CODEX_HOME = other;
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "home-selection" });
  expect(readdirSync(other)).toEqual([]);
});

test("same-inode source drift rejects before every catalog target write", async () => {
  const gathered = await candidate();
  const path = join(codexHome, "opencodex-catalog.json");
  const inode = lstatSync(path).ino;
  writeFileSync(path, sourceCatalog("drifted"));
  expect(lstatSync(path).ino).toBe(inode);
  const drifted = readFileSync(path, "utf8");
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "source-observation" });
  expect(readFileSync(path, "utf8")).toBe(drifted);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("target identity drift wins before source comparison and writes nothing", async () => {
  const gathered = await candidate();
  const path = join(codexHome, "opencodex-catalog.json");
  const moved = join(codexHome, "moved.json");
  renameSync(path, moved);
  writeFileSync(path, readFileSync(moved));
  const before = readFileSync(path, "utf8");
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "target-identity" });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("used process-local authority drift rejects before every catalog target write", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] });
  setBundledCatalogCacheForTests(runtime, JSON.parse(sourceCatalog("bundled")) as never);
  const gathered = await candidate();
  invalidateBundledCatalogCache();
  expect(await commitCodexCatalogCandidate(gathered, 1_000)).toEqual({ kind: "stale", reason: "process-local" });
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("custom catalog runtime-support drift rejects before every catalog target write", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  const customPath = join(codexHome, "custom-catalog.json");
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "custom-catalog.json"\n');
  writeFileSync(customPath, sourceCatalog("custom"));
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] });
  setBundledCatalogCacheForTests(runtime, JSON.parse(sourceCatalog("bundled-support")) as never);

  const gathered = await candidate();
  invalidateBundledCatalogCache();

  expect(await commitCodexCatalogCandidate(gathered, 1_000))
    .toEqual({ kind: "stale", reason: "process-local" });
  expect(readFileSync(customPath, "utf8")).toBe(sourceCatalog("custom"));
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("catalog-only commit never creates the native pair or routing/history artifacts", async () => {
  const gathered = await candidate();
  expect((await commitCodexCatalogCandidate(gathered, 1_000)).kind).toBe("committed");
  const nativeDb = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  expect(existsSync(nativeDb)).toBe(false);
  expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  expect(manifest(root).join("\n")).not.toContain("journal");
  expect(manifest(root).join("\n")).not.toContain("history");
});

test("management convergence restores omitted natives and retains a configured native alias", async () => {
  const runtime = { command: "/tmp/codex", version: "0.146.0", source: "environment" as const };
  const bundled = JSON.parse(sourceCatalog("bundled")) as { models: Array<Record<string, unknown>> };
  bundled.models.push({
    ...bundled.models[0],
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
  });
  persistCodexRuntime(runtime, { configDir: opencodexHome, now: () => 0 });
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, bundled, { opencodexHome });

  const nativeAlias = {
    ...bundled.models[0],
    display_name: "Nova1 - Sol",
    description: "Routed via opencodex → combo (combo).",
    owned_by: "combo",
    opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    input_modalities: ["text", "image"],
  };
  writeFileSync(join(codexHome, "opencodex-catalog.json"), `${JSON.stringify({
    marker: "active-native-alias",
    models: [nativeAlias],
  }, null, 2)}\n`);

  const liveConfig: OcxConfig = {
    port: 10100,
    defaultProvider: "Nova1",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        liveModels: false,
        models: [],
      },
      Nova1: {
        adapter: "openai-chat",
        baseUrl: "https://nova.example/v1",
        liveModels: false,
        models: [],
      },
    },
    combos: {
      nova: {
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "Nova1 - Sol",
        targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
      },
    },
  };
  saveConfig(liveConfig);

  const beforeGather = manifest(root);
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(liveConfig));
  expect(gathered.kind).toBe("candidate");
  expect(manifest(root)).toEqual(beforeGather);
  if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
  expect(await commitCodexCatalogCandidate(gathered.candidate, 1_000)).toMatchObject({ kind: "committed" });

  const written = JSON.parse(readFileSync(join(codexHome, "opencodex-catalog.json"), "utf8")) as {
    models: Array<Record<string, unknown>>;
  };
  expect(written.models.find(entry => entry.slug === "gpt-5.5")).toMatchObject({
    display_name: "GPT-5.5",
  });
  expect(written.models.filter(entry => entry.slug === "gpt-5.6-sol")).toEqual([
    expect.objectContaining({
      display_name: "Nova1 - Sol",
      owned_by: "combo",
      opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
    }),
  ]);
});

test("the total lazy adapter preserves a persisted-success route when factory construction fails", async () => {
  const live = config();
  const request = new ManagementRequest("http://localhost/api/disabled-models", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: ["gpt-5.6-sol"] }),
  });
  const response = await handleManagementAPI(request, new URL(request.url), live, {
    saveConfigPreservingClaudeCode: () => {},
    createManagementConvergeCodex: () => { throw new Error("factory exploded"); },
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    ok: true,
    disabled: ["gpt-5.6-sol"],
    catalogRefresh: {
      status: "failed",
      // #1784: an escaping factory error is an internal fault, not a disk failure.
      // Reporting "disk" told the operator to check storage for a programming bug.
      reason: "internal",
      phase: "gather",
      partialWrite: false,
      cause: { kind: "unknown" },
    },
  });
});

test("a malformed convergence request is reported as request-invalid, not disk (#1784)", async () => {
  const live = config();
  const request = new ManagementRequest("http://localhost/api/disabled-models", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: ["gpt-5.6-sol"] }),
  });
  const response = await handleManagementAPI(request, new URL(request.url), live, {
    saveConfigPreservingClaudeCode: () => {},
    createManagementConvergeCodex: () => { throw new TypeError("scope must be an object"); },
  });

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    catalogRefresh: {
      status: "failed",
      reason: "request-invalid",
      cause: { kind: "invalid-request" },
    },
  });
});

test("a failure cause never carries message text, paths or identifiers (#1784)", async () => {
  const live = config();
  const request = new ManagementRequest("http://localhost/api/disabled-models", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: ["gpt-5.6-sol"] }),
  });
  const secret = "sk-ant-api03-" + "A".repeat(40);
  const response = await handleManagementAPI(request, new URL(request.url), live, {
    saveConfigPreservingClaudeCode: () => {},
    createManagementConvergeCodex: () => {
      const homePath = ["", "Users", "someone", ".codex", "config.toml"].join("/");
      throw new Error(`failed writing ${homePath} for ${secret}`);
    },
  });

  const body = JSON.stringify(await response?.json());
  // The cause is rebuilt from closed vocabularies, so none of this can ride out.
  expect(body).not.toContain(secret);
  expect(body).not.toContain(["", "Users", "someone"].join("/"));
  expect(body).not.toContain("failed writing");
});

test("the route inventory contains exactly the specified 7 + 13 + 2 + 2 convergence calls", () => {
  const counts = Object.fromEntries([
    ["provider-routes.ts", 7],
    ["model-routes.ts", 13],
    ["combo-routes.ts", 2],
    ["agent-settings-routes.ts", 2],
  ].map(([file, expected]) => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "server", "management", file as string), "utf8");
    const count = source.match(/await convergeCodexCatalog\(\)/g)?.length ?? 0;
    expect(count).toBe(expected);
    expect(source).not.toContain("refreshCodexCatalogBestEffort");
    return [file, count];
  }));
  expect(counts).toEqual({
    "provider-routes.ts": 7,
    "model-routes.ts": 13,
    "combo-routes.ts": 2,
    "agent-settings-routes.ts": 2,
  });
});

test("both model-discovery write paths converge the Codex catalog", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "server", "management", "model-routes.ts"), "utf8");
  const settings = source.slice(source.indexOf('url.pathname === "/api/model-discovery" && req.method === "PUT"'), source.indexOf('url.pathname === "/api/model-discovery/acknowledge"'));
  // Sliced to the NEXT route rather than to /api/catalog: the alias routes (#2463) landed
  // between them, so a fixed far boundary would swallow their convergence calls and count
  // them as this route's.
  const acknowledge = source.slice(source.indexOf('url.pathname === "/api/model-discovery/acknowledge"'), source.indexOf('url.pathname === "/api/aliases"'));
  expect(settings.match(/await convergeCodexCatalog\(\)/g)?.length).toBe(1);
  expect(acknowledge.match(/await convergeCodexCatalog\(\)/g)?.length).toBe(1);
});

test("all three alias write routes converge the Codex catalog", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "server", "management", "model-routes.ts"), "utf8");
  for (const marker of ["providerAliasMatch && req.method", "modelAliasMatch && req.method", 'url.pathname === "/api/default-aliases"']) {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf("\n  if (", start + 1))).toContain("await convergeCodexCatalog()");
  }
});

/**
 * Same discipline as the reload-route assertion below: the count above went 6 -> 8 for the
 * model-preset routes (#2465), and a bare count that only ever rises stops being a contract.
 * Assert those two calls specifically, so a later bump cannot pass while some OTHER route
 * quietly gained one, or while a preset route lost its own convergence.
 *
 * Both are write paths that change which models ship to the catalog — applying a preset
 * narrows it, clearing back to "all" widens it — so each must converge for exactly the same
 * reason `PUT /api/selected-models` does.
 */
test("both model-preset write paths converge the Codex catalog", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "server", "management", "model-routes.ts"),
    "utf8",
  );
  const handlerStart = source.indexOf('url.pathname === "/api/model-presets" && req.method === "PUT"');
  expect(handlerStart).toBeGreaterThan(-1);
  const handlerBody = source.slice(handlerStart, source.indexOf("url.pathname ===", handlerStart + 1));
  // The "all" branch and the materialize branch each converge; "custom" only moves the marker,
  // so it deliberately does not.
  expect(handlerBody.match(/await convergeCodexCatalog\(\)/g)?.length).toBe(2);
});

/**
 * The inventory above is a bare count, so raising it is the obvious way to make this file
 * green again — and a count that only ever gets raised stops being a contract. #1541's
 * seventh call is legitimate: the attested reload route adopts a provider from disk into the
 * live config, so it invalidates the same caches as the other write paths and must converge
 * the catalog for the same reason. Assert that specific call directly, so a future bump
 * cannot pass while some OTHER route quietly gained one, or while the reload route lost its own.
 */
test("the attested reload route converges the Codex catalog like the other write paths", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "server", "management", "provider-routes.ts"),
    "utf8",
  );
  const handlerStart = source.indexOf("LOCAL_PROVIDER_RELOAD_PATH && req.method === \"POST\"");
  expect(handlerStart).toBeGreaterThan(-1);
  // The reload handler returns before the next route check; scope the search to its body.
  const handlerBody = source.slice(handlerStart, source.indexOf("url.pathname ===", handlerStart + 1));
  expect(handlerBody).toContain("await convergeCodexCatalog()");
});
