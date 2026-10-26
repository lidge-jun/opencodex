import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CATALOG_HEAL_MAX_ATTEMPTS, CATALOG_HEAL_MAX_HEALS, CATALOG_HEAL_RECHECK_MS,
  CATALOG_HEAL_TICK_MS, CATALOG_HEAL_WINDOW_MS, startCodexCatalogSelfHeal,
  type CatalogSelfHealDeps, type CatalogSelfHealGates, type CatalogSelfHealHandle,
} from "../../src/codex/catalog-self-heal";
import { CATALOG_HEAL_MAX_BYTES, CATALOG_HEAL_MAX_LINKS, CATALOG_HEAL_MAX_PATH_READS, compareCatalogHealPaths, inspectHealPath, observeCatalogHealFile, sameCatalogHealPath, selectCatalogHealPath } from "../../src/codex/catalog/heal-observation";
import type { CatalogPublicationEvent } from "../../src/codex/catalog/publication-observer";
import type { RawCatalog } from "../../src/codex/catalog/parsing";
import type { OcxConfig } from "../../src/types";
import { reconcileClientStartupBeforeReady, syncCodexBeforeCatalogObservation } from "../../src/cli/claude-agent-startup-sync";
import { syncCodexOnStartIfEnabled } from "../../src/codex/desired-state";
import { createReadinessGate } from "../../src/server/readiness";
import { tryAdmitTurn } from "../../src/server/lifecycle";

const routed = (slug: string) => ({ slug, description: `Routed via opencodex → ${slug} (owner).` });
const native = { slug: "gpt-5.5", description: "native" };
const provider = { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" };
const full: RawCatalog = { models: [native, routed("ark/a"), routed("tx/b")] };
const empty: RawCatalog = { models: [native] };
const handles: CatalogSelfHealHandle[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Heal = NonNullable<CatalogSelfHealDeps["converge"]>;
function harness(options: { path?: string; config?: Partial<OcxConfig>; gates?: Partial<CatalogSelfHealGates>; republish?: RawCatalog; realIdle?: boolean } = {}) {
  let clock = 0;
  let version = 0;
  let catalog: RawCatalog | null = structuredClone(full);
  let path: string | null = options.path ?? "/codex/opencodex-catalog.json";
  let reads = 0;
  let subscriber: ((event: CatalogPublicationEvent) => void) | null = null;
  let timer: (() => void) | null = null;
  let cancelled = 0;
  let configAvailable = true;
  const delays: number[] = [];
  const converges: OcxConfig[] = [];
  const warnings: string[] = [];
  const config = { port: 10100, defaultProvider: "openai", providers: { ark: provider, tx: provider }, ...options.config } as OcxConfig;
  const rewrite = (next: RawCatalog | null) => { catalog = next; version += 1; };
  let heal: Heal = async (_config, lifecycle) => {
    if (!lifecycle.beforeCommit()) return { committed: false };
    rewrite(structuredClone(options.republish ?? full));
    subscriber?.({ kind: "published", path: path!, intent: "refresh" });
    return { committed: true };
  };
  const handle = startCodexCatalogSelfHeal({ port: 10100, deps: {
    scheduleFn: (fn, ms) => { timer = fn; delays.push(ms); return { cancel: () => { cancelled += 1; timer = null; } }; },
    now: () => clock,
    catalogPath: () => path,
    retainPath: () => () => true, // This harness supplies synthetic observations, including virtual paths.
    observe: (_path, content) => {
      if (content) reads += 1;
      return { signature: `v${version}`, catalog: content ? structuredClone(catalog) : null };
    },
    converge: async (driving, lifecycle) => { converges.push(driving); return heal(driving, lifecycle); },
    subscribe: listener => { subscriber = listener; return () => { subscriber = null; }; },
    gates: {
      siblingOfLivePort: () => null, exiting: () => false, runtimeOwned: () => true,
      loadConfig: () => configAvailable ? config : null, ownsCodexHome: () => true, clientConnected: () => false,
      clientJournalOwner: () => false, ...options.gates,
      ...(options.realIdle ? {} : { idle: options.gates?.idle ?? (() => true) }),
    },
    log: { warn: line => warnings.push(line) },
  } });
  handles.push(handle);
  return {
    handle, converges, warnings, config, delays, rewrite,
    advance(ms: number) { clock += ms; },
    reads: () => reads, catalog: () => catalog, cancelled: () => cancelled,
    setPath(next: string | null) { path = next; },
    setConfigAvailable(available: boolean) { configAvailable = available; },
    setHeal(next: Heal) { heal = next; },
    publish(event: CatalogPublicationEvent) { subscriber?.(event); },
    subscribed: () => subscriber !== null,
    fire: () => timer?.(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// These seven scenarios carry source #6537; additional rows cover final040 H1-H4/R1.
describe("Codex catalog self-heal (#6529)", () => {
  test("the baseline is immediate; unchanged stat does not read content again", async () => {
    const h = harness();
    expect(h.reads()).toBe(1);
    expect(CATALOG_HEAL_TICK_MS).toBe(30_000);
    expect(h.delays).toEqual([30_000]);
    await h.handle.tickForTests();
    await h.handle.tickForTests();
    expect(h.reads()).toBe(1);
    expect(h.converges).toEqual([]);
  });

  test("republishes once when enabled routed namespaces disappear before the first tick", async () => {
    const h = harness();
    h.rewrite(empty);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
    expect(h.catalog()?.models?.map(row => row.slug)).toContain("ark/a");
    expect(h.handle.lastHeal()).toMatchObject({ lostNamespaces: 2, committed: true });
    expect(h.warnings).toEqual([expect.stringContaining("2 lost routed provider namespaces")]);
    expect(h.warnings[0]).not.toContain("ark");
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("a namespace the owner's config dropped is a legitimate removal", async () => {
    const h = harness({ config: { providers: { ark: provider, tx: { ...provider, disabled: true } } as OcxConfig["providers"] } });
    h.rewrite({ models: [native, routed("ark/a")] });
    await h.handle.tickForTests();
    expect(h.converges).toEqual([]);
  });

  test("the owner's successful authoritative empty catalog becomes the baseline", async () => {
    const h = harness({ republish: empty });
    h.rewrite(empty);
    await h.handle.tickForTests();
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("closed ownership gate defers until reopened after five minutes", async () => {
    let owner = false;
    const h = harness({ gates: { ownsCodexHome: () => owner } });
    h.rewrite(empty);
    await h.handle.tickForTests();
    owner = true;
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(0);
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("an actual admitted inference turn defers default idle gate until release", async () => {
    const h = harness({ realIdle: true });
    const turn = tryAdmitTurn();
    expect(turn).not.toBeNull();
    try {
      h.rewrite(empty);
      await h.handle.tickForTests();
      expect(h.converges).toHaveLength(0);
    } finally { turn?.release(); }
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("repeated external rewrites pause at three successes until the rolling hour expires", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      h.rewrite(empty);
      await h.handle.tickForTests();
      h.advance(1_000);
    }
    expect(h.converges).toHaveLength(CATALOG_HEAL_MAX_HEALS);
    h.advance(CATALOG_HEAL_WINDOW_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(CATALOG_HEAL_MAX_HEALS + 1);
  });

  test("stop cancels the timer and unsubscribes", async () => {
    const h = harness();
    h.handle.stop();
    h.rewrite(empty);
    h.fire();
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(0);
    expect(h.cancelled()).toBe(1);
    expect(h.subscribed()).toBe(false);
  });

  for (const failure of ["failed", "refused", "thrown", "catalog-success/cache-failure"] as const) {
    test(`retries ${failure} with unchanged stat after backoff`, async () => {
      const h = harness();
      h.setHeal(async () => {
        if (failure === "thrown") throw new Error("failure");
        if (failure === "catalog-success/cache-failure" && h.converges.length === 1) {
          h.rewrite(full);
          h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
        }
        return { committed: false };
      });
      h.rewrite(empty);
      await h.handle.tickForTests();
      expect(h.handle.lastHeal()?.committed).toBe(false);
      await h.handle.tickForTests();
      expect(h.converges).toHaveLength(1);
      h.advance(CATALOG_HEAL_RECHECK_MS);
      await h.handle.tickForTests();
      expect(h.converges).toHaveLength(2);
      const reads = h.reads();
      h.advance(CATALOG_HEAL_RECHECK_MS);
      await h.handle.tickForTests();
      expect(h.converges).toHaveLength(3);
      // Pending retry is tested before the unchanged-signature/no-loss fast path.
      expect(h.reads()).toBe(reads);
    });
  }

  test("six failed attempts consume the hourly cap and resume on expiry", async () => {
    const h = harness();
    h.setHeal(async () => ({ committed: false }));
    h.rewrite(empty);
    for (let i = 0; i < CATALOG_HEAL_MAX_ATTEMPTS + 2; i += 1) {
      await h.handle.tickForTests();
      h.advance(CATALOG_HEAL_RECHECK_MS);
    }
    expect(h.converges).toHaveLength(6);
    h.advance(CATALOG_HEAL_WINDOW_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(7);
  });

  test("configuration deleting every lost namespace clears a failed pending retry", async () => {
    const h = harness();
    h.setHeal(async () => ({ committed: false }));
    h.rewrite(empty);
    await h.handle.tickForTests();
    h.config.providers = {};
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    h.config.providers = { ark: provider, tx: provider } as OcxConfig["providers"];
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("configuration deletion narrows a pending retry to still-enabled namespaces", async () => {
    const h = harness();
    h.setHeal(async () => ({ committed: false }));
    h.rewrite(empty);
    await h.handle.tickForTests();
    delete h.config.providers.tx;
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.handle.lastHeal()?.lostNamespaces).toBe(1);
  });

  test("unavailable config cannot clear or narrow a failed pending retry", async () => {
    const h = harness();
    h.setHeal(async () => ({ committed: false }));
    h.rewrite(empty);
    await h.handle.tickForTests();
    h.setConfigAvailable(false);
    h.config.providers = {}; // A defaults-like value has no file authority.
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    h.config.providers = { ark: provider } as OcxConfig["providers"];
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
    h.config.providers = { ark: provider, tx: provider } as OcxConfig["providers"];
    h.setConfigAvailable(true);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(2);
    expect(h.handle.lastHeal()?.lostNamespaces).toBe(2);
  });

  test("unavailable journal target preserves failed pending retry and baseline", async () => {
    const h = harness();
    h.setHeal(async () => ({ committed: false }));
    h.rewrite(empty);
    await h.handle.tickForTests();
    h.setPath(null);
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    h.setPath("/codex/opencodex-catalog.json");
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(2);
    expect(h.handle.lastHeal()?.lostNamespaces).toBe(2);
  });

  test("the observed target is carried to the convergence commit context", async () => {
    const h = harness();
    let receivedPath: string | undefined;
    h.setHeal(async (_config, lifecycle) => {
      receivedPath = lifecycle.expectedCatalogPath;
      return { committed: false };
    });
    h.rewrite(empty);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
    expect(receivedPath).toBe("/codex/opencodex-catalog.json");
  });

  test("owner empty publication accepts a baseline; unrelated target publication does not", async () => {
    const h = harness();
    h.rewrite(empty);
    h.publish({ kind: "published", path: "/other/catalog.json", intent: "refresh" });
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
    h.rewrite(empty);
    h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  for (const gate of ["idle", "client", "off"] as const) {
    test(`matching owner publication rearms release while ${gate} gate is closed`, async () => {
      let idle = true, client = false;
      const h = harness({ gates: { idle: () => idle, clientConnected: () => client } });
      h.publish({ kind: "native-released", path: "/codex/opencodex-catalog.json" });
      if (gate === "idle") idle = false;
      if (gate === "client") client = true;
      if (gate === "off") h.config.clientIntegrations = { codex: false };
      h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
      expect(h.converges).toHaveLength(0);
      idle = true; client = false; h.config.clientIntegrations = { codex: true };
      h.rewrite(empty);
      await h.handle.tickForTests();
      expect(h.converges).toHaveLength(1);
      expect(h.handle.lastHeal()?.committed).toBe(true);
    });
  }

  test("legitimate owner emptiness observed while busy consumes no heal slot", async () => {
    let idle = false;
    const h = harness({ gates: { idle: () => idle } });
    h.rewrite(empty);
    h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
    await h.handle.tickForTests();
    idle = true;
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(0);
    expect(h.handle.lastHeal()).toBeNull();
    // All three success slots remain available for later genuine losses.
    h.rewrite(full);
    h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
    for (let index = 0; index < CATALOG_HEAL_MAX_HEALS; index++) {
      h.rewrite(empty);
      await h.handle.tickForTests();
    }
    expect(h.converges).toHaveLength(CATALOG_HEAL_MAX_HEALS);
  });

  test("external owner empty publication during failed heal waits for terminal retry acceptance", async () => {
    const h = harness({ republish: empty });
    const entered = deferred(), finish = deferred();
    h.setHeal(async () => { entered.resolve(); await finish.promise; return { committed: false }; });
    h.rewrite(empty);
    const tick = h.handle.tickForTests();
    await entered.promise;
    h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
    finish.resolve();
    await tick;
    h.setHeal(async (_config, lifecycle) => ({ committed: lifecycle.beforeCommit() }));
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    h.advance(CATALOG_HEAL_RECHECK_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(2);
    expect(h.handle.lastHeal()?.committed).toBe(true);
  });

  for (const change of ["stop", "idle", "config-unavailable", "off", "client", "journal-client", "owner", "runtime", "sibling", "exit", "path", "restore", "native-release"] as const) {
    test(`${change} during gather prevents publication and late revival`, async () => {
      let client = false, journalClient = false, owner = true, runtime = true, idle = true, sibling: number | null = null, exiting = false;
      const h = harness({ gates: {
        clientConnected: () => client, clientJournalOwner: () => journalClient,
        ownsCodexHome: () => owner, runtimeOwned: () => runtime,
        siblingOfLivePort: () => sibling, exiting: () => exiting,
        idle: () => idle,
      } });
      const entered = deferred(), finish = deferred();
      let publications = 0;
      h.setHeal(async (_config, lifecycle) => {
        entered.resolve();
        await finish.promise;
        if (!lifecycle.beforeCommit()) return { committed: false };
        publications += 1;
        h.rewrite(full);
        return { committed: true };
      });
      h.rewrite(empty);
      const tick = h.handle.tickForTests();
      await entered.promise;
      if (change === "stop") h.handle.stop();
      if (change === "idle") idle = false;
      if (change === "config-unavailable") h.setConfigAvailable(false);
      if (change === "off") h.config.clientIntegrations = { codex: false };
      if (change === "client") client = true;
      if (change === "journal-client") journalClient = true;
      if (change === "owner") owner = false;
      if (change === "runtime") runtime = false;
      if (change === "sibling") sibling = 9999;
      if (change === "exit") exiting = true;
      if (change === "path") h.setPath("/codex/custom.json");
      if (change === "restore") h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "restore" });
      if (change === "native-release") h.publish({ kind: "native-released", path: null });
      finish.resolve();
      await tick;
      expect(publications).toBe(0);
      if (change === "restore" || change === "native-release") {
        expect(h.handle.lastHeal()).toBeNull();
        h.advance(CATALOG_HEAL_WINDOW_MS);
        await h.handle.tickForTests();
        expect(h.converges).toHaveLength(1);
      }
    });
  }

  test("restore cancels pending retry even after repaired catalog/cache failure", async () => {
    const h = harness();
    h.setHeal(async () => { h.rewrite(full); return { committed: false }; });
    h.rewrite(empty);
    await h.handle.tickForTests();
    h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "restore" });
    h.advance(CATALOG_HEAL_WINDOW_MS);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("owner publication can re-arm after native release with a fresh baseline", async () => {
    const h = harness();
    h.publish({ kind: "native-released", path: null });
    h.rewrite(full);
    h.publish({ kind: "published", path: "/codex/opencodex-catalog.json", intent: "refresh" });
    h.rewrite(empty);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });

  test("unavailable selected catalog retains baseline until a valid replacement arrives", async () => {
    const h = harness();
    h.rewrite(null);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(0);
    const reads = h.reads();
    await h.handle.tickForTests();
    expect(h.reads()).toBe(reads);
    h.rewrite(empty);
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(1);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-catalog-heal-"));
  roots.push(root);
  return root;
}

describe("bounded catalog healing observations", () => {
  test("missing or corrupt selected custom catalog never falls back to valid default bytes", () => {
    const root = temporaryRoot();
    const journal = join(root, "journal.json"), fallback = join(root, "default.json"), custom = join(root, "custom.json");
    writeFileSync(fallback, JSON.stringify(full));
    writeFileSync(journal, JSON.stringify({ version: 1, originalConfig: "", originalProfile: null, injectedCatalogPath: "custom.json" }));
    const select = () => selectCatalogHealPath(journal, fallback, path => join(root, path));
    expect(select()).toBe(custom);
    expect(observeCatalogHealFile(custom, true)).toBeNull();
    writeFileSync(custom, "broken JSON");
    expect(select()).toBe(custom);
    expect(observeCatalogHealFile(custom, true)?.catalog).toBeNull();
  });

  test("unknown journal is unavailable; a genuinely absent journal selects the default", () => {
    const root = temporaryRoot();
    const journal = join(root, "journal.json"), fallback = join(root, "default.json");
    expect(selectCatalogHealPath(journal, fallback, path => path)).toBe(fallback);
    writeFileSync(journal, "broken");
    expect(selectCatalogHealPath(journal, fallback, path => path)).toBeNull();
  });

  test("stat-only observation, regular content, directory and byte cap", () => {
    const root = temporaryRoot(), file = join(root, "catalog.json");
    writeFileSync(file, JSON.stringify(full));
    const quick = observeCatalogHealFile(file, false);
    expect(quick?.catalog).toBeNull();
    expect(observeCatalogHealFile(file, true)).toEqual({ signature: quick!.signature, catalog: full });
    const directory = join(root, "directory");
    mkdirSync(directory);
    expect(observeCatalogHealFile(directory, true)).toBeNull();
    truncateSync(file, CATALOG_HEAL_MAX_BYTES + 1);
    expect(observeCatalogHealFile(file, false)).toBeNull();
    expect(observeCatalogHealFile(file, true)).toBeNull();
  });

  if (process.platform !== "win32") test("symbolic catalog and journal paths supply no authority", () => {
    const root = temporaryRoot(), file = join(root, "catalog.json"), link = join(root, "link.json");
    writeFileSync(file, JSON.stringify(full));
    symlinkSync(file, link);
    expect(observeCatalogHealFile(link, true)).toBeNull();
    expect(selectCatalogHealPath(link, file, path => path)).toBeNull();
  });
});

function aliasPaths(kind: "lexical" | "physical" | "case") {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(home);
  const path = join(home, "catalog.json");
  writeFileSync(path, JSON.stringify(full));
  if (kind === "physical") {
    const aliasHome = join(root, "alias");
    symlinkSync(home, aliasHome, process.platform === "win32" ? "junction" : "dir");
    return { path, alias: join(aliasHome, "catalog.json") };
  }
  return { path, alias: kind === "case" ? path.toUpperCase() : `${home}/./catalog.json` };
}

async function withCatalogPlatform(platform: "win32" | "darwin", run: () => void | Promise<void>) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try { await run(); }
  finally { Object.defineProperty(process, "platform", platformDescriptor); }
}

async function withNativeFileAlias(path: string, alias: string, platform: "win32" | "darwin", run: () => void | Promise<void>) {
  const native = realpathSync.native, stat = fs.lstatSync;
  // Model an OS filename alias, not a second directory entry. Linux need not expose it.
  const aliasStat = spyOn(fs, "lstatSync").mockImplementation((input, options) =>
    input === alias ? stat(path, options) : stat(input, options));
  const aliasPath = spyOn(realpathSync, "native").mockImplementation(input =>
    native(input === alias ? path : input));
  try { await withCatalogPlatform(platform, run); }
  finally {
    aliasPath.mockRestore(); aliasStat.mockRestore();
  }
}

describe("catalog path comparison", () => {
  test.each(["CAFÉ-CATALOG.JSON", "cafe\u0301-catalog.json"])("Mac hardlink alias %s stays unknown without entry-name evidence", async leaf => {
    const root = temporaryRoot(), path = join(root, "café-catalog.json"), alias = join(root, leaf);
    writeFileSync(path, JSON.stringify(full));
    const sibling = join(temporaryRoot(), "catalog.json");
    linkSync(path, sibling);
    await withNativeFileAlias(path, alias, "darwin", () => {
      expect(compareCatalogHealPaths(path, alias)).toBe("unknown");
      expect(compareCatalogHealPaths(alias, path)).toBe("unknown");
      expect(compareCatalogHealPaths(path, path)).toBe("same");
      expect(compareCatalogHealPaths(path, sibling)).toBe("different");
    });
  });

  test("Mac same-parent hardlink names are not guessed distinct or enumerated eagerly", async () => {
    const { path } = aliasPaths("lexical"), sibling = join(dirname(path), "sibling.json");
    linkSync(path, sibling);
    const readdir = spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("Unbounded listing"); });
    const opendir = spyOn(fs, "opendirSync").mockImplementation(() => { throw new Error("Eager Bun opendir"); });
    try {
      await withCatalogPlatform("darwin", () => {
        expect(compareCatalogHealPaths(path, sibling)).toBe("unknown");
        expect(compareCatalogHealPaths(sibling, path)).toBe("unknown");
        expect(readdir).not.toHaveBeenCalled();
        expect(opendir).not.toHaveBeenCalled();
      });
    } finally { readdir.mockRestore(); opendir.mockRestore(); }
  });

  test.each(["input", "parent"] as const)("Mac %s identity drift prevents a same result", async kind => {
    const { path } = aliasPaths("lexical");
    linkSync(path, join(temporaryRoot(), "catalog.json"));
    const lstat = fs.lstatSync, stat = fs.statSync;
    let reads = 0;
    const changed = (value: ReturnType<typeof lstatSync>) => Object.assign(Object.create(Object.getPrototypeOf(value)), value,
      { ctimeNs: typeof value.ctimeNs === "bigint" ? value.ctimeNs + 1n : value.ctimeNs + 1 });
    const input = spyOn(fs, "lstatSync").mockImplementation((value, options) => {
      const result = lstat(value, options);
      return kind === "input" && value === path && ++reads >= 3 ? changed(result) : result;
    });
    const parent = spyOn(fs, "statSync").mockImplementation((value, options) => {
      const result = stat(value, options);
      return kind === "parent" && ++reads >= 5 ? changed(result) : result;
    });
    try { await withCatalogPlatform("darwin", () => { expect(compareCatalogHealPaths(path, path)).toBe("unknown"); }); }
    finally { input.mockRestore(); parent.mockRestore(); }
  });

  test("a new hardlink during native resolution cannot evade Mac identity checks", async () => {
    const { path } = aliasPaths("lexical"), sibling = join(temporaryRoot(), "catalog.json");
    const native = realpathSync.native;
    let calls = 0;
    const nativePath = spyOn(realpathSync, "native").mockImplementation(input => {
      const result = native(input);
      if (input === path && ++calls === 2) linkSync(path, sibling);
      return result;
    });
    try { await withCatalogPlatform("darwin", () => { expect(compareCatalogHealPaths(path, path)).toBe("unknown"); }); }
    finally { nativePath.mockRestore(); }
  });

  test("path lookup stops at its I/O budget and reports unknown", async () => {
    const { path } = aliasPaths("lexical");
    linkSync(path, join(temporaryRoot(), "catalog.json"));
    let alias = path;
    for (let i = 0; i < 20; i += 1) {
      const next = join(dirname(path), `link-${i}.json`);
      symlinkSync(alias, next, "file"); alias = next;
    }
    const lstat = fs.lstatSync, stat = fs.statSync, readlink = fs.readlinkSync, native = realpathSync.native;
    let reads = 0;
    const spies = [
      spyOn(fs, "lstatSync").mockImplementation((...args) => { reads++; return lstat(...args); }),
      spyOn(fs, "statSync").mockImplementation((...args) => { reads++; return stat(...args); }),
      spyOn(fs, "readlinkSync").mockImplementation((...args) => { reads++; return readlink(...args); }),
      spyOn(realpathSync, "native").mockImplementation((...args) => { reads++; return native(...args); }),
    ];
    try {
      await withCatalogPlatform("darwin", () => {
        expect(compareCatalogHealPaths(alias, path)).toBe("unknown");
        expect(reads).toBeLessThanOrEqual(CATALOG_HEAL_MAX_PATH_READS);
      });
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  test.each(["win32", "darwin"] as const)("%s single-link native filename aliases remain equivalent", async platform => {
    const { path } = aliasPaths("lexical");
    const alias = join(dirname(path), platform === "win32" ? "CATALO~9.JSO" : "CATALOG.JSON");
    expect(lstatSync(path).nlink).toBe(1);
    await withNativeFileAlias(path, alias, platform, () => {
      expect(sameCatalogHealPath(path, alias)).toBe(true);
      expect(sameCatalogHealPath(alias, path)).toBe(true);
      expect(sameCatalogHealPath(alias, alias)).toBe(true);
    });
  });

  test("Windows native filename aliases remain equivalent for multiply linked files", async () => {
    const { path } = aliasPaths("lexical");
    const sibling = join(temporaryRoot(), "catalog.json"), alias = join(dirname(path), "CATALO~9.JSO");
    linkSync(path, sibling);
    expect(lstatSync(path).nlink).toBe(2);
    await withNativeFileAlias(path, alias, "win32", () => {
      expect(sameCatalogHealPath(path, alias)).toBe(true);
      expect(sameCatalogHealPath(alias, path)).toBe(true);
      expect(sameCatalogHealPath(alias, sibling)).toBe(false);
      expect(sameCatalogHealPath(sibling, alias)).toBe(false);
    });
  });

  test("hardlink entries remain distinct when native realpath reports their sibling", async () => {
    const { path } = aliasPaths("lexical");
    const sibling = join(temporaryRoot(), "catalog.json");
    linkSync(path, sibling);
    expect(lstatSync(sibling).ino).toBe(lstatSync(path).ino);
    const native = realpathSync.native;
    // macOS Bun can return the other hardlink's name for either opened file.
    const resolvePath = spyOn(realpathSync, "native").mockImplementation(input =>
      input === path || input === sibling ? path : native(input));
    try {
      await withCatalogPlatform("darwin", () => {
        expect(sameCatalogHealPath(path, sibling)).toBe(false);
        expect(sameCatalogHealPath(sibling, path)).toBe(false);
        expect(sameCatalogHealPath(path, path)).toBe(true);
        expect(sameCatalogHealPath(sibling, sibling)).toBe(true);
      });
    } finally { resolvePath.mockRestore(); }
  });

  test("self comparison survives alternating native hardlink names", async () => {
    const { path } = aliasPaths("lexical");
    const sibling = join(temporaryRoot(), "catalog.json");
    linkSync(path, sibling);
    const native = realpathSync.native;
    let calls = 0;
    const resolvePath = spyOn(realpathSync, "native").mockImplementation(input =>
      input === path ? (++calls % 2 ? path : sibling) : native(input));
    try { await withCatalogPlatform("darwin", () => { expect(sameCatalogHealPath(path, path)).toBe(true); }); }
    finally { resolvePath.mockRestore(); }
  });

  test("lexical and directory aliases are symmetric without merging distinct files", () => {
    const { path, alias } = aliasPaths("physical");
    const distinct = join(temporaryRoot(), "catalog.json");
    writeFileSync(distinct, JSON.stringify(full));
    expect(sameCatalogHealPath(path, alias)).toBe(true);
    expect(sameCatalogHealPath(alias, path)).toBe(true);
    expect(sameCatalogHealPath(alias, alias)).toBe(true);
    expect(sameCatalogHealPath(`${dirname(path)}/./catalog.json`, alias)).toBe(true);
    expect(sameCatalogHealPath(alias, distinct)).toBe(false);
    expect(sameCatalogHealPath(distinct, alias)).toBe(false);
  });

  test("relative leaf symlinks use their canonical parent and preserve hardlink names", () => {
    const root = temporaryRoot(), home = join(root, "home"), inner = join(home, "inner");
    mkdirSync(inner, { recursive: true });
    const path = join(home, "catalog.json"), sibling = join(root, "catalog.json");
    writeFileSync(path, JSON.stringify(full));
    linkSync(path, sibling);
    const parentAlias = join(root, "alias");
    symlinkSync(inner, parentAlias, process.platform === "win32" ? "junction" : "dir");
    const leaf = join(parentAlias, "link.json");
    symlinkSync("../catalog.json", join(inner, "link.json"), "file");
    const chain = join(inner, "chain.json");
    symlinkSync("link.json", chain, "file");
    const absolute = join(root, "absolute.json");
    symlinkSync(path, absolute, "file");
    expect(statSync(leaf).ino).toBe(lstatSync(path).ino);
    expect(sameCatalogHealPath(leaf, path)).toBe(true);
    expect(sameCatalogHealPath(path, leaf)).toBe(true);
    expect(sameCatalogHealPath(chain, path)).toBe(true);
    expect(sameCatalogHealPath(path, chain)).toBe(true);
    expect(sameCatalogHealPath(absolute, path)).toBe(true);
    expect(sameCatalogHealPath(path, absolute)).toBe(true);
    expect(sameCatalogHealPath(leaf, sibling)).toBe(false);
    expect(sameCatalogHealPath(sibling, leaf)).toBe(false);
  });

  test("a link target crossing a symlinked directory follows the platform's .. semantics", () => {
    const root = temporaryRoot(), a = join(root, "a"), realHome = join(root, "b", "subdir");
    mkdirSync(realHome, { recursive: true });
    mkdirSync(a, { recursive: true });
    const real = join(root, "b", "catalog.json"), decoy = join(a, "catalog.json");
    writeFileSync(real, "MARKER-B-REAL");
    writeFileSync(decoy, "MARKER-A-DECOY");
    symlinkSync(realHome, join(a, "bridge"), process.platform === "win32" ? "junction" : "dir");
    const link = join(a, "link.json");
    symlinkSync("bridge/../catalog.json", link, "file");
    // Independent OS oracle: Windows normalizes ".." lexically across a reparse
    // point (opens decoy); POSIX climbs the link's real parent (opens real).
    const actual = process.platform === "win32" ? decoy : real;
    const other = process.platform === "win32" ? real : decoy;
    expect(readFileSync(link, "utf8")).toBe(readFileSync(actual, "utf8"));
    expect(realpathSync.native(link)).toBe(realpathSync.native(actual));
    expect(compareCatalogHealPaths(link, actual)).toBe("same");
    expect(compareCatalogHealPaths(actual, link)).toBe("same");
    expect(compareCatalogHealPaths(link, other)).toBe("different");
    expect(compareCatalogHealPaths(other, link)).toBe("different");
  });

  test("a link target crossing a missing directory follows the platform's crossing rules", () => {
    const root = temporaryRoot(), a = join(root, "a");
    mkdirSync(a, { recursive: true });
    const present = join(a, "catalog.json");
    writeFileSync(present, "MARKER-A-PRESENT");
    const link = join(a, "link.json");
    symlinkSync("missing/../catalog.json", link, "file");
    if (process.platform === "win32") {
      // The lexical ".." applies before the missing component is ever opened.
      expect(readFileSync(link, "utf8")).toBe(readFileSync(present, "utf8"));
      expect(realpathSync.native(link)).toBe(realpathSync.native(present));
      expect(compareCatalogHealPaths(link, present)).toBe("same");
      expect(compareCatalogHealPaths(present, link)).toBe("same");
    } else {
      // POSIX refuses to cross a missing intermediate directory.
      expect(() => readFileSync(link)).toThrow();
      expect(() => realpathSync.native(link)).toThrow();
      expect(compareCatalogHealPaths(link, present)).toBe("unknown");
      expect(compareCatalogHealPaths(present, link)).toBe("unknown");
      expect(inspectHealPath(link, read => read())).toEqual({ kind: "unavailable", hardlink: true });
    }
  });

  test.skipIf(process.platform === "win32")("a POSIX link target keeps literal backslashes inside names", () => {
    // Windows has no such filenames; only POSIX must not split on "\\".
    const root = temporaryRoot(), a = join(root, "a");
    const backslashDir = join(a, "we\\ird");
    mkdirSync(backslashDir, { recursive: true });
    const real = join(backslashDir, "catalog.json"), decoy = join(a, "catalog.json");
    writeFileSync(real, "MARKER-BACKSLASH");
    writeFileSync(decoy, "MARKER-A-DECOY");
    const link = join(a, "link.json"), dotdot = join(a, "dot.json");
    symlinkSync("we\\ird/catalog.json", link, "file");
    symlinkSync("we\\ird/../catalog.json", dotdot, "file");
    expect(realpathSync.native(link)).toBe(realpathSync.native(real));
    expect(readFileSync(link, "utf8")).toBe(readFileSync(real, "utf8"));
    expect(compareCatalogHealPaths(link, real)).toBe("same");
    expect(compareCatalogHealPaths(link, decoy)).toBe("different");
    expect(realpathSync.native(dotdot)).toBe(realpathSync.native(decoy));
    expect(compareCatalogHealPaths(dotdot, decoy)).toBe("same");
    expect(compareCatalogHealPaths(dotdot, real)).toBe("different");
  });

  test.skipIf(process.platform === "win32")("a POSIX link target crossing a file-pointing link refuses the traversal", () => {
    // "bridge" resolves to a regular file: POSIX refuses "bridge/.." with ENOTDIR.
    const root = temporaryRoot(), a = join(root, "a");
    mkdirSync(a, { recursive: true });
    const present = join(a, "catalog.json"), fileTarget = join(root, "file-target.json");
    writeFileSync(present, "MARKER-A-PRESENT");
    writeFileSync(fileTarget, "MARKER-FILE");
    symlinkSync(fileTarget, join(a, "bridge"), "file");
    const link = join(a, "link.json");
    symlinkSync("bridge/../catalog.json", link, "file");
    expect(() => readFileSync(link)).toThrow();
    expect(() => realpathSync.native(link)).toThrow();
    expect(compareCatalogHealPaths(link, present)).toBe("unknown");
    expect(compareCatalogHealPaths(present, link)).toBe("unknown");
    expect(inspectHealPath(link, read => read())).toEqual({ kind: "unavailable", hardlink: true });
  });

  test("40-hop exhaustion stays uncertain independently of the comparator read budget", () => {
    const root = temporaryRoot(), cycle = join(root, "cycle.json");
    symlinkSync("cycle.json", cycle, "file");
    let reads = 0;
    const observed = inspectHealPath(cycle, read => { reads += 1; return read(); });
    expect(CATALOG_HEAL_MAX_LINKS).toBe(40);
    expect(CATALOG_HEAL_MAX_PATH_READS).toBe(64);
    expect(reads).toBe(CATALOG_HEAL_MAX_LINKS * 4);
    expect(reads).toBeGreaterThan(CATALOG_HEAL_MAX_PATH_READS);
    // This marker forces compareCatalogHealPaths' unknown branch, never lexical fallback.
    expect(observed).toEqual({ kind: "unavailable", hardlink: true });
  });

  test.each([
    [1, "initial leaf lstat", false],
    [2, "symlink parent stat", true],
    [3, "symlink readlink", true],
    [4, "symlink parent realpath", true],
    [5, "symlink target lstat", true],
    [6, "symlink target realpath", true],
  ] as const)("path failure at %s (%s) preserves observed-symlink uncertainty", (failAt, _stage, uncertain) => {
    const root = temporaryRoot(), target = join(root, "target.json"), alias = join(root, "alias.json");
    writeFileSync(target, JSON.stringify(full));
    symlinkSync(target, alias, "file");
    let reads = 0;
    const observed = inspectHealPath(alias, read => {
      if (++reads === failAt) throw new Error("Fixture filesystem observation failed");
      return read();
    });
    expect(reads).toBe(failAt);
    expect(observed).toEqual({ kind: "unavailable", hardlink: uncertain });
  });

  test("initial unavailable leaves retain lexical equality while observed dangling links stay unknown", () => {
    const root = temporaryRoot(), missing = join(root, "missing.json");
    const dangling = join(root, "dangling.json"), cycle = join(root, "cycle.json");
    symlinkSync("missing.json", dangling, "file");
    symlinkSync("cycle.json", cycle, "file");
    expect(compareCatalogHealPaths(missing, `${root}/./missing.json`)).toBe("same");
    expect(compareCatalogHealPaths(missing, join(root, "other-missing.json"))).toBe("different");
    expect(inspectHealPath(missing, read => read())).toEqual({ kind: "unavailable", hardlink: false });
    expect(compareCatalogHealPaths(dangling, dangling)).toBe("unknown");
    expect(compareCatalogHealPaths(dangling, missing)).toBe("unknown");
    expect(compareCatalogHealPaths(missing, dangling)).toBe("unknown");
    expect(sameCatalogHealPath(dangling, missing)).toBe(false);
    expect(sameCatalogHealPath(missing, dangling)).toBe(false);
    expect(compareCatalogHealPaths(cycle, cycle)).toBe("unknown");
    expect(sameCatalogHealPath(cycle, cycle)).toBe(false);
  });
});

for (const release of ["restore", "native-release"] as const) {
  test(`observed-symlink lookup failure ${release} fences the known target while selection is unavailable`, async () => {
    const root = temporaryRoot(), target = join(root, "target.json"), alias = join(root, "alias.json");
    writeFileSync(target, JSON.stringify(full));
    linkSync(target, join(root, "sibling.json"));
    symlinkSync(target, alias, "file");
    const known = join(root, "missing-known.json"), h = harness({ path: known });
    const entered = deferred(), finish = deferred();
    let committed = false;
    h.setHeal(async (_config, lifecycle) => {
      entered.resolve(); await finish.promise;
      committed = lifecycle.beforeCommit(); return { committed };
    });
    h.rewrite(empty);
    const tick = h.handle.tickForTests();
    await entered.promise;
    const originalReadlink = fs.readlinkSync;
    const readlink = spyOn(fs, "readlinkSync").mockImplementation((path, options) => {
      if (path === alias) throw new Error("Fixture readlink observation failed");
      return originalReadlink(path, options);
    });
    try {
      await withCatalogPlatform("darwin", async () => {
        h.setPath(null);
        const comparison = compareCatalogHealPaths(alias, known);
        h.publish(release === "restore" ? { kind: "published", path: alias, intent: "restore" }
          : { kind: "native-released", path: alias });
        h.setPath(known);
        finish.resolve(); await tick;
        expect(committed).toBe(false);
        expect(comparison).toBe("unknown");
      });
    } finally { finish.resolve(); await tick; readlink.mockRestore(); }
  });
}

test("unknown Mac target identity defers observation reuse and healing", async () => {
  const { path } = aliasPaths("lexical"), alias = join(dirname(path), "CATALOG.JSON");
  linkSync(path, join(temporaryRoot(), "catalog.json"));
  const h = harness({ path });
  h.rewrite(empty);
  await withNativeFileAlias(path, alias, "darwin", async () => {
    h.setPath(alias);
    await h.handle.tickForTests();
    expect(h.reads()).toBe(1);
    expect(h.converges).toHaveLength(0);
  });
});

test("unknown Mac precommit identity refuses a suspended heal", async () => {
  const { path } = aliasPaths("lexical"), alias = join(dirname(path), "CATALOG.JSON");
  linkSync(path, join(temporaryRoot(), "catalog.json"));
  const h = harness({ path });
  const entered = deferred(), finish = deferred();
  let committed = true;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests(); await entered.promise;
  await withNativeFileAlias(path, alias, "darwin", async () => {
    try {
      h.setPath(alias); finish.resolve(); await tick;
      expect(committed).toBe(false);
      expect(h.handle.lastHeal()).toBeNull();
    } finally { finish.resolve(); await tick; }
  });
});

test("a precommit parent race refuses a suspended heal", async () => {
  const { path } = aliasPaths("lexical");
  linkSync(path, join(temporaryRoot(), "catalog.json"));
  const h = harness({ path });
  const entered = deferred(), finish = deferred();
  let committed = true;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests(); await entered.promise;
  const stat = fs.statSync;
  let reads = 0;
  const parent = spyOn(fs, "statSync").mockImplementation((value, options) => {
    const result = stat(value, options);
    return ++reads >= 5 ? Object.assign(Object.create(Object.getPrototypeOf(result)), result, { ctimeNs: result.ctimeNs + 1n }) : result;
  });
  try {
    await withCatalogPlatform("darwin", async () => {
      finish.resolve(); await tick;
      expect(committed).toBe(false);
    });
  } finally { finish.resolve(); await tick; parent.mockRestore(); }
});

test("a release whose lookup exceeds the I/O budget fences a suspended heal", async () => {
  const { path } = aliasPaths("lexical");
  let alias = path;
  for (let i = 0; i < 20; i += 1) {
    const next = join(dirname(path), `release-${i}.json`);
    symlinkSync(alias, next, "file"); alias = next;
  }
  const h = harness({ path });
  const entered = deferred(), finish = deferred();
  let committed = true;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests(); await entered.promise;
  try {
    expect(compareCatalogHealPaths(alias, path)).toBe("unknown");
    h.publish({ kind: "native-released", path: alias });
    finish.resolve(); await tick;
    expect(committed).toBe(false);
  } finally { finish.resolve(); await tick; }
});

for (const release of ["restore", "native-release"] as const) {
  test(`unknown Mac ${release} fences; unknown owner publication cannot rearm`, async () => {
    const { path } = aliasPaths("lexical"), alias = join(dirname(path), "CATALOG.JSON");
    linkSync(path, join(temporaryRoot(), "catalog.json"));
    const h = harness({ path });
    const entered = deferred(), finish = deferred();
    let committed = true;
    h.setHeal(async (_config, lifecycle) => {
      entered.resolve(); await finish.promise;
      committed = lifecycle.beforeCommit(); return { committed };
    });
    h.rewrite(empty);
    const tick = h.handle.tickForTests(); await entered.promise;
    await withNativeFileAlias(path, alias, "darwin", async () => {
      try {
        h.setPath(null);
        h.publish(release === "restore" ? { kind: "published", path: alias, intent: "restore" }
          : { kind: "native-released", path: alias });
        h.setPath(path); finish.resolve(); await tick;
        expect(committed).toBe(false);
        const reads = h.reads();
        h.publish({ kind: "published", path: alias, intent: "refresh" });
        expect(h.reads()).toBe(reads);
        h.advance(CATALOG_HEAL_WINDOW_MS); await h.handle.tickForTests();
        expect(h.converges).toHaveLength(1);
        h.rewrite(full); h.publish({ kind: "published", path, intent: "refresh" });
        h.rewrite(empty); await h.handle.tickForTests();
        expect(h.converges).toHaveLength(2);
        expect(committed).toBe(true);
      } finally { finish.resolve(); await tick; }
    });
  });
}

test("unknown Mac owner publication invalidates pending work without accepting a baseline", async () => {
  const { path } = aliasPaths("lexical"), alias = join(dirname(path), "CATALOG.JSON");
  linkSync(path, join(temporaryRoot(), "catalog.json"));
  const h = harness({ path });
  const entered = deferred(), finish = deferred();
  let committed = true;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests(); await entered.promise;
  await withNativeFileAlias(path, alias, "darwin", async () => {
    try {
      const reads = h.reads();
      h.publish({ kind: "published", path: alias, intent: "refresh" });
      expect(h.reads()).toBe(reads);
      finish.resolve(); await tick;
      expect(committed).toBe(false);
    } finally { finish.resolve(); await tick; }
  });
});

for (const release of ["restore", "native-release"] as const) {
  test(`native filename alias ${release} fences the known target while selection is unavailable`, async () => {
    const { path } = aliasPaths("lexical");
    const alias = join(dirname(path), "CATALO~9.JSO");
    const h = harness({ path });
    const entered = deferred(), finish = deferred();
    let committed = false;
    h.setHeal(async (_config, lifecycle) => {
      entered.resolve(); await finish.promise;
      committed = lifecycle.beforeCommit(); return { committed };
    });
    h.rewrite(empty);
    const tick = h.handle.tickForTests();
    await entered.promise;
    await withNativeFileAlias(path, alias, "win32", async () => {
      try {
        h.setPath(null); // Restore can remove the journal before its notification.
        h.publish(release === "restore" ? { kind: "published", path: alias, intent: "restore" }
          : { kind: "native-released", path: alias });
        h.setPath(path);
        finish.resolve(); await tick;
        expect(committed).toBe(false);
      } finally { finish.resolve(); await tick; }
    });
  });
}

test("native filename alias owner publication accepts the equivalent target", async () => {
  const { path } = aliasPaths("lexical");
  const alias = join(dirname(path), "CATALO~9.JSO");
  const h = harness({ path });
  h.rewrite(empty);
  await withNativeFileAlias(path, alias, "win32", async () => {
    h.publish({ kind: "published", path: alias, intent: "refresh" });
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(0);
  });
});

for (const kind of ["lexical", "physical", ...(process.platform === "win32" ? ["case" as const] : [])] as const) {
  for (const release of ["restore", "native-release"] as const) {
    test(`${kind} alias ${release} during suspended heal fences publication`, async () => {
      const { path, alias } = aliasPaths(kind);
      const h = harness({ path });
      const entered = deferred(), finish = deferred();
      let publications = 0;
      h.setHeal(async (_config, lifecycle) => {
        entered.resolve();
        await finish.promise;
        if (!lifecycle.beforeCommit()) return { committed: false };
        publications++;
        return { committed: true };
      });
      h.rewrite(empty);
      const tick = h.handle.tickForTests();
      await entered.promise;
      h.publish(release === "restore" ? { kind: "published", path: alias, intent: "restore" }
        : { kind: "native-released", path: alias });
      finish.resolve();
      await tick;
      expect(publications).toBe(0);
      expect(h.handle.lastHeal()).toBeNull();
      h.advance(CATALOG_HEAL_WINDOW_MS);
      await h.handle.tickForTests();
      expect(h.converges).toHaveLength(1);
    });
  }
  test(`${kind} target alias preserves baseline, observation reuse, and suspended commit`, async () => {
    const { path, alias } = aliasPaths(kind);
    const h = harness({ path });
    h.setPath(alias);
    await h.handle.tickForTests();
    expect(h.reads()).toBe(1);
    h.rewrite(empty);
    const entered = deferred(), finish = deferred();
    h.setHeal(async (_config, lifecycle) => {
      entered.resolve(); await finish.promise;
      return { committed: lifecycle.beforeCommit() };
    });
    const tick = h.handle.tickForTests();
    await entered.promise;
    h.setPath(path);
    finish.resolve();
    await tick;
    expect(h.handle.lastHeal()?.committed).toBe(true);
  });
  test(`${kind} owner publication accepts the equivalent target`, async () => {
    const { path, alias } = aliasPaths(kind);
    const h = harness({ path });
    h.rewrite(empty);
    h.publish({ kind: "published", path: alias, intent: "refresh" });
    await h.handle.tickForTests();
    expect(h.converges).toHaveLength(0);
  });
}

test("unavailable lexical alias restore fences a pending heal", async () => {
  const h = harness();
  const entered = deferred(), finish = deferred();
  let committed = false;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests();
  await entered.promise;
  h.publish({ kind: "native-released", path: "/codex/./opencodex-catalog.json" });
  finish.resolve(); await tick;
  expect(committed).toBe(false);
});

test.each(["distinct", "hardlink"] as const)("%s restore target remains unrelated", async kind => {
  const { path } = aliasPaths("lexical");
  const unrelated = join(temporaryRoot(), "catalog.json");
  if (kind === "hardlink") linkSync(path, unrelated); else writeFileSync(unrelated, JSON.stringify(full));
  const h = harness({ path });
  const entered = deferred(), finish = deferred();
  let committed = false;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests();
  await entered.promise;
  h.publish({ kind: "native-released", path: unrelated });
  finish.resolve(); await tick;
  expect(committed).toBe(true);
});

test("sibling hardlink release cannot fence a heal when native realpath collapses entries", async () => {
  const { path } = aliasPaths("lexical");
  const sibling = join(temporaryRoot(), "catalog.json");
  linkSync(path, sibling);
  const h = harness({ path });
  const entered = deferred(), finish = deferred();
  let committed = false;
  h.setHeal(async (_config, lifecycle) => {
    entered.resolve(); await finish.promise;
    committed = lifecycle.beforeCommit(); return { committed };
  });
  h.rewrite(empty);
  const tick = h.handle.tickForTests();
  await entered.promise;
  const native = realpathSync.native;
  const resolvePath = spyOn(realpathSync, "native").mockImplementation(input =>
    input === path || input === sibling ? path : native(input));
  try {
    await withCatalogPlatform("darwin", async () => {
      h.publish({ kind: "native-released", path: sibling });
      finish.resolve(); await tick;
      expect(committed).toBe(true);
    });
  } finally {
    finish.resolve(); await tick;
    resolvePath.mockRestore();
  }
});

for (const stage of ["Claude", "Desktop"] as const) {
  test(`startup loss during deferred ${stage} reconciliation is observed after a successful no-op sync`, async () => {
    const gate = createReadinessGate();
    const entered = deferred(), finish = deferred();
    let h: ReturnType<typeof harness> | undefined;
    const config = { providers: {} } as OcxConfig;
    const pause = async () => { entered.resolve(); await finish.promise; };
    const startup = reconcileClientStartupBeforeReady(gate,
      deferredGate => syncCodexBeforeCatalogObservation(deferredGate,
        forwarding => syncCodexOnStartIfEnabled(10100, config, async () => ({ ok: true }), forwarding),
        () => { h = harness(); }),
      stage === "Claude" ? pause : async () => undefined,
      stage === "Desktop" ? pause : undefined);
    try {
      await entered.promise;
      expect(gate.getStatus()).toBe("pending");
      expect(h).toBeDefined();
      h!.rewrite(empty);
      await h!.handle.tickForTests();
      expect(h!.converges).toHaveLength(1);
    } finally { finish.resolve(); await startup; }
    expect(gate.getStatus()).toBe("ready");
  });
}

test.each(["failed", "thrown"] as const)("%s startup sync never adopts a healer baseline", async kind => {
  const gate = createReadinessGate();
  let observations = 0;
  await reconcileClientStartupBeforeReady(gate,
    deferredGate => syncCodexBeforeCatalogObservation(deferredGate,
      forwarding => syncCodexOnStartIfEnabled(10100, { providers: {} } as OcxConfig, async () => {
        if (kind === "thrown") throw new Error("sync failed");
        return { ok: false };
      }, forwarding), () => { observations++; }), async () => undefined);
  expect(observations).toBe(0);
  expect(gate.getStatus()).toBe("failed");
});

test("OFF startup creates gated observation and preserves later enable", async () => {
  const gate = createReadinessGate();
  let h: ReturnType<typeof harness> | undefined;
  const config = { providers: {}, clientIntegrations: { codex: false } } as OcxConfig;
  const result = await reconcileClientStartupBeforeReady(gate,
    deferredGate => syncCodexBeforeCatalogObservation(deferredGate,
      forwarding => syncCodexOnStartIfEnabled(10100, config, async () => { throw new Error("OFF synced"); }, forwarding),
      () => { h = harness({ config: { clientIntegrations: { codex: false } } }); }), async () => undefined);
  expect(result.ran).toBe(false);
  expect(gate.getStatus()).toBe("ready");
  expect(h).toBeDefined();
  h!.rewrite(empty);
  await h!.handle.tickForTests();
  expect(h!.converges).toHaveLength(0);
  h!.config.clientIntegrations = { codex: true };
  h!.advance(CATALOG_HEAL_RECHECK_MS);
  await h!.handle.tickForTests();
  expect(h!.converges).toHaveLength(1);
});
