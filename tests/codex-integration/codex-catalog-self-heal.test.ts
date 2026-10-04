import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_HEAL_MAX_ATTEMPTS, CATALOG_HEAL_MAX_HEALS, CATALOG_HEAL_RECHECK_MS,
  CATALOG_HEAL_TICK_MS, CATALOG_HEAL_WINDOW_MS, startCodexCatalogSelfHeal,
  type CatalogSelfHealDeps, type CatalogSelfHealGates, type CatalogSelfHealHandle,
} from "../../src/codex/catalog-self-heal";
import { CATALOG_HEAL_MAX_BYTES, observeCatalogHealFile, selectCatalogHealPath } from "../../src/codex/catalog/heal-observation";
import type { CatalogPublicationEvent } from "../../src/codex/catalog/publication-observer";
import type { RawCatalog } from "../../src/codex/catalog/parsing";
import type { OcxConfig } from "../../src/types";
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
function harness(options: { config?: Partial<OcxConfig>; gates?: Partial<CatalogSelfHealGates>; republish?: RawCatalog; realIdle?: boolean } = {}) {
  let clock = 0;
  let version = 0;
  let catalog: RawCatalog | null = structuredClone(full);
  let path: string | null = "/codex/opencodex-catalog.json";
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
