import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_HEAL_MAX_PATH_READS, compareCatalogHealPaths, observeCatalogHealFile } from "../../src/codex/catalog/heal-observation";
import { CATALOG_HEAL_RECHECK_MS, startCodexCatalogSelfHeal } from "../../src/codex/catalog-self-heal";
import type { CatalogPublicationEvent } from "../../src/codex/catalog/publication-observer";
import type { OcxConfig } from "../../src/types";

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-heal-reanchor-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("a leaf symlink retargeted before native resolution stays unknown on every platform", () => {
  const root = fixture(), a = join(root, "a.json"), b = join(root, "b.json"), alias = join(root, "alias.json");
  fs.writeFileSync(a, "A");
  fs.writeFileSync(b, "B");
  fs.symlinkSync(a, alias, "file");
  const native = fs.realpathSync.native;
  let swapped = false;
  const spy = spyOn(fs.realpathSync, "native").mockImplementation((path, options) => {
    if (!swapped) {
      swapped = true;
      fs.unlinkSync(alias);
      fs.symlinkSync(b, alias, "file");
    }
    return native(path, options);
  });
  let relation;
  try { relation = compareCatalogHealPaths(alias, a); }
  finally { spy.mockRestore(); }
  expect(swapped).toBe(true);
  expect(native(alias)).toBe(native(b));
  expect(fs.readFileSync(alias, "utf8")).toBe("B");
  expect(relation).toBe("unknown");
});

test.each([false, true])("a proven selected publication reanchors when the obsolete target is dangling (released=%s)", async released => {
  const root = fixture(), oldPath = join(root, "old.json"), newPath = join(root, "new.json");
  const full = { models: [{ slug: "ark/a", description: "Routed via opencodex → ark/a (owner)." }] };
  fs.writeFileSync(oldPath, JSON.stringify(full));
  fs.writeFileSync(newPath, JSON.stringify(full));
  let selected = oldPath;
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  let converges = 0;
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => selected,
    subscribe: fn => { listener = fn; return () => {}; },
    converge: async (_config, lifecycle) => {
      converges++;
      expect(lifecycle.expectedCatalogPath).toBe(newPath);
      expect(lifecycle.beforeCommit()).toBe(true);
      return { committed: false };
    },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    if (released) listener({ kind: "native-released", path: oldPath });
    fs.renameSync(oldPath, join(root, "saved-old.json"));
    fs.symlinkSync(join(root, "missing.json"), oldPath, "file");
    selected = newPath;
    expect(compareCatalogHealPaths(oldPath, newPath)).toBe("unknown");
    expect(compareCatalogHealPaths(newPath, newPath)).toBe("same");
    listener({ kind: "published", path: newPath, intent: "refresh" });
    fs.writeFileSync(newPath, JSON.stringify({ models: [] }));
    for (let i = 0; i < 3; i++) await handle.tickForTests();
    expect(converges).toBe(1);
  } finally { handle.stop(); }
});

test.each(["entry", "parent"] as const)("native %s evidence is revalidated on every platform", kind => {
  const root = fixture(), path = join(root, "catalog.json");
  fs.writeFileSync(path, "catalog");
  const lstat = fs.lstatSync, stat = fs.statSync;
  let entries = 0, parents = 0, changed = false;
  const drift = <T extends fs.BigIntStats | fs.Stats>(value: T): T => {
    changed = true;
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ctimeNs: value.ctimeNs + 1n });
  };
  const spies = [
    spyOn(fs, "lstatSync").mockImplementation((value, options) => {
      const result = lstat(value, options);
      return kind === "entry" && ++entries >= 3 ? drift(result) : result;
    }),
    spyOn(fs, "statSync").mockImplementation((value, options) => {
      const result = stat(value, options);
      return kind === "parent" && ++parents >= 5 ? drift(result) : result;
    }),
  ];
  try {
    expect(compareCatalogHealPaths(path, path)).toBe("unknown");
    expect(changed).toBe(true);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test("native link observations and revalidation share the 64-call budget", () => {
  const root = fixture(), path = join(root, "catalog.json");
  fs.writeFileSync(path, "catalog");
  let alias = path;
  for (let i = 0; i < 9; i++) {
    const next = join(root, `link-${i}.json`);
    fs.symlinkSync(alias, next, "file");
    alias = next;
  }
  const lstat = fs.lstatSync, stat = fs.statSync, readlink = fs.readlinkSync, native = fs.realpathSync.native;
  let reads = 0;
  const spies = [
    spyOn(fs, "lstatSync").mockImplementation((...args) => { reads++; return lstat(...args); }),
    spyOn(fs, "statSync").mockImplementation((...args) => { reads++; return stat(...args); }),
    spyOn(fs, "readlinkSync").mockImplementation((...args) => { reads++; return readlink(...args); }),
    spyOn(fs.realpathSync, "native").mockImplementation((...args) => { reads++; return native(...args); }),
  ];
  try {
    expect(compareCatalogHealPaths(alias, path)).toBe("unknown");
    expect(reads).toBe(CATALOG_HEAL_MAX_PATH_READS);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test.each([false, true])("an unreadable selected publication preserves uncertainty and release fences (released=%s)", async released => {
  const root = fixture(), oldPath = join(root, "old.json"), newPath = join(root, "new.json");
  const full = JSON.stringify({ models: [{ slug: "ark/a", description: "Routed via opencodex → ark/a (owner)." }] });
  fs.writeFileSync(oldPath, full);
  fs.writeFileSync(newPath, "invalid catalog");
  let selected = oldPath;
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  let converges = 0;
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => selected,
    subscribe: fn => { listener = fn; return () => {}; },
    converge: async () => { converges++; return { committed: false }; },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    if (released) listener({ kind: "native-released", path: oldPath });
    fs.renameSync(oldPath, join(root, "saved-old.json"));
    fs.symlinkSync(join(root, "missing.json"), oldPath, "file");
    selected = newPath;
    expect(compareCatalogHealPaths(newPath, newPath)).toBe("same");
    listener({ kind: "published", path: newPath, intent: "refresh" });
    fs.writeFileSync(newPath, full);
    await handle.tickForTests();
    fs.writeFileSync(newPath, JSON.stringify({ models: [] }));
    await handle.tickForTests();
    expect(converges).toBe(0);
    fs.writeFileSync(newPath, full);
    listener({ kind: "published", path: newPath, intent: "refresh" });
    fs.writeFileSync(newPath, JSON.stringify({ models: [] }));
    await handle.tickForTests();
    expect(converges).toBe(1);
  } finally { handle.stop(); }
});

test.each(["corrupt", "unreadable"] as const)("a %s same-target publication preserves the previous loss baseline", async failure => {
  const path = join(fixture(), "catalog.json");
  fs.writeFileSync(path, JSON.stringify({ models: [{ slug: "ark/a", description: "Routed via opencodex → ark/a (owner)." }] }));
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  let unreadable = false, converges = 0;
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => path,
    observe: (selected, content) => unreadable ? null : observeCatalogHealFile(selected, content),
    subscribe: fn => { listener = fn; return () => {}; },
    converge: async () => { converges++; return { committed: false }; },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    if (failure === "corrupt") fs.writeFileSync(path, "invalid catalog");
    else unreadable = true;
    listener({ kind: "published", path, intent: "refresh" });
    unreadable = false;
    fs.writeFileSync(path, JSON.stringify({ models: [] }));
    await handle.tickForTests();
    expect(converges).toBe(1);
  } finally { handle.stop(); }
});

for (const publishedAlias of [false, true]) {
  test.each([false, true])(`a publication cannot adopt a retargeted junction (publishedAlias=${publishedAlias}, released=%s)`, async released => {
    const root = fixture(), a = join(root, "a"), b = join(root, "b"), alias = join(root, "alias");
    fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, "junction");
    const original = join(a, "catalog.json"), redirected = join(b, "catalog.json"), selectedAlias = join(alias, "catalog.json");
    const catalog = (names: string[]) => JSON.stringify({ models: names.map(ns => ({
      slug: `${ns}/a`, description: `Routed via opencodex → ${ns}/a (owner).`,
    })) });
    fs.writeFileSync(original, catalog(["ark"]));
    fs.writeFileSync(redirected, catalog(["ark", "tx"]));
    let selected = original, armed = false, swapped = false, converges = 0;
    let listener: (event: CatalogPublicationEvent) => void = () => {};
    const config = { port: 10100, defaultProvider: "ark", providers: {
      ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      tx: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    } } as OcxConfig;
    const handle = startCodexCatalogSelfHeal({ deps: {
      scheduleFn: () => ({ cancel() {} }), catalogPath: () => selected,
      subscribe: fn => { listener = fn; return () => {}; },
      observe: (path, content) => {
        if (armed && !swapped) {
          swapped = true;
          fs.renameSync(alias, join(root, "saved-alias"));
          fs.symlinkSync(b, alias, "junction");
        }
        return observeCatalogHealFile(path, content);
      },
      converge: async (_config, lifecycle) => {
        converges++;
        expect(lifecycle.beforeCommit()).toBe(true);
        return { committed: false };
      },
      gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
        runtimeOwned: () => true, loadConfig: () => config,
        ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
      log: { warn() {} },
    } });
    try {
      if (released) listener({ kind: "native-released", path: original });
      selected = selectedAlias;
      const published = publishedAlias ? selectedAlias : original;
      expect(compareCatalogHealPaths(published, selected)).toBe("same");
      armed = true;
      listener({ kind: "published", path: published, intent: "refresh" });
      expect(swapped).toBe(true);
      expect(fs.realpathSync.native(selected)).toBe(fs.realpathSync.native(redirected));
      // Rejection retains the old baseline/release fence; a valid publication still re-arms.
      if (!released) {
        selected = original;
        fs.writeFileSync(original, catalog([]));
        await handle.tickForTests();
        expect(converges).toBe(1);
      }
      selected = selectedAlias;
      fs.writeFileSync(redirected, catalog(["ark"]));
      await handle.tickForTests();
      expect(converges).toBe(released ? 0 : 1);
      selected = original;
      if (released) {
        fs.writeFileSync(original, catalog([]));
        await handle.tickForTests();
        expect(converges).toBe(0);
      }
      fs.writeFileSync(original, catalog(["ark"]));
      listener({ kind: "published", path: original, intent: "refresh" });
      fs.writeFileSync(original, catalog([]));
      await handle.tickForTests();
      expect(converges).toBe(released ? 1 : 2);
    } finally { handle.stop(); }
  });
}

test.each([false, true])("publication identity precedes the initial comparisons (released=%s)", async released => {
  const root = fixture(), a = join(root, "a"), b = join(root, "b"), alias = join(root, "alias");
  fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, "junction");
  const original = join(a, "catalog.json"), foreign = join(b, "catalog.json"), published = join(alias, "catalog.json");
  const catalog = (names: string[]) => JSON.stringify({ models: names.map(ns => ({
    slug: `${ns}/a`, description: `Routed via opencodex → ${ns}/a (owner).`,
  })) });
  fs.writeFileSync(original, catalog(["ark"]));
  fs.writeFileSync(foreign, catalog(["ark", "tx"]));
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  let converges = 0, authorized = false;
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    tx: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => published,
    subscribe: fn => { listener = fn; return () => {}; },
    converge: async (_config, lifecycle) => {
      converges++;
      authorized = lifecycle.beforeCommit();
      return { committed: false };
    },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    if (released) listener({ kind: "native-released", path: original });
    const stat = fs.statSync;
    let stats = 0, swapped = false;
    const spy = spyOn(fs, "statSync").mockImplementation((path, options) => {
      const result = stat(path, options);
      // Two native comparisons use eight stat calls each. Retarget after the last
      // returned A evidence, before the old handler began its independent capture.
      // Capture-first must keep A evidence even when this schedule interrupts a comparison.
      if (++stats === 16) {
        fs.renameSync(alias, join(root, "saved-a"));
        fs.symlinkSync(b, alias, "junction");
        swapped = true;
      }
      return result;
    });
    try { listener({ kind: "published", path: published, intent: "refresh" }); }
    finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(fs.realpathSync.native(published)).toBe(fs.realpathSync.native(foreign));
    fs.writeFileSync(foreign, catalog(["ark"]));
    await handle.tickForTests();
    expect(converges).toBe(0);
    expect(authorized).toBe(false);
    // The rejected publication preserves A's baseline and the original release fence.
    fs.renameSync(alias, join(root, "saved-b"));
    fs.renameSync(join(root, "saved-a"), alias);
    fs.writeFileSync(original, catalog([]));
    await handle.tickForTests();
    expect(converges).toBe(released ? 0 : 1);
    expect(authorized).toBe(!released);
    fs.writeFileSync(original, catalog(["ark"]));
    listener({ kind: "published", path: published, intent: "refresh" });
    fs.writeFileSync(original, catalog([]));
    await handle.tickForTests();
    expect(converges).toBe(released ? 1 : 2);
    expect(authorized).toBe(true);
  } finally { handle.stop(); }
});

test.each([false, true])("a published junction cannot supply foreign bytes during an A-B-A retarget (released=%s)", async released => {
  const root = fixture(), a = join(root, "a"), b = join(root, "b"), alias = join(root, "alias");
  fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, "junction");
  const original = join(a, "catalog.json"), published = join(alias, "catalog.json");
  const catalog = (names: string[]) => JSON.stringify({ models: names.map(ns => ({
    slug: `${ns}/a`, description: `Routed via opencodex → ${ns}/a (owner).`,
  })) });
  fs.writeFileSync(original, catalog(["ark"]));
  fs.writeFileSync(join(b, "catalog.json"), catalog(["ark", "tx"]));
  let armed = false, reads = 0, converges = 0;
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    tx: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => published,
    subscribe: fn => { listener = fn; return () => {}; },
    observe: (path, content) => {
      if (!armed) return observeCatalogHealFile(path, content);
      if (reads++ === 0) {
        fs.renameSync(alias, join(root, "saved-a"));
        fs.symlinkSync(b, alias, "junction");
      }
      const result = observeCatalogHealFile(path, content);
      if (content) {
        fs.renameSync(alias, join(root, "saved-b"));
        fs.renameSync(join(root, "saved-a"), alias);
        armed = false;
      }
      return result;
    },
    converge: async (_config, lifecycle) => {
      converges++;
      expect(lifecycle.beforeCommit()).toBe(true);
      return { committed: false };
    },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    if (released) listener({ kind: "native-released", path: original });
    armed = true;
    listener({ kind: "published", path: published, intent: "refresh" });
    expect(reads).toBe(2);
    expect(compareCatalogHealPaths(original, published)).toBe("same");
    await handle.tickForTests();
    expect(converges).toBe(0);
    fs.writeFileSync(original, catalog([]));
    await handle.tickForTests();
    expect(converges).toBe(released ? 0 : 1);
  } finally { handle.stop(); }
});

test("publication entry drift preserves a pending retry and its five-minute backoff", async () => {
  const root = fixture(), path = join(root, "catalog.json");
  const full = JSON.stringify({ models: [{ slug: "ark/a", description: "Routed via opencodex → ark/a (owner)." }] });
  fs.writeFileSync(path, full);
  let now = 0, armed = false, converges = 0;
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    now: () => now, scheduleFn: () => ({ cancel() {} }), catalogPath: () => path,
    subscribe: fn => { listener = fn; return () => {}; },
    observe: (selected, content) => {
      const result = observeCatalogHealFile(selected, content);
      if (armed && content) {
        armed = false;
        fs.renameSync(path, join(root, "saved.json"));
        fs.writeFileSync(path, full);
      }
      return result;
    },
    converge: async () => { converges++; return { committed: false }; },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    fs.writeFileSync(path, JSON.stringify({ models: [] }));
    await handle.tickForTests();
    expect(converges).toBe(1);
    fs.writeFileSync(path, full);
    armed = true;
    listener({ kind: "published", path, intent: "refresh" });
    expect(armed).toBe(false);
    now = CATALOG_HEAL_RECHECK_MS - 1;
    await handle.tickForTests();
    expect(converges).toBe(1);
    now++;
    await handle.tickForTests();
    expect(converges).toBe(2);
  } finally { handle.stop(); }
});

test.each([false, true])("an accepted publication retains the validated post-read selection (released=%s)", async released => {
  const root = fixture(), a = join(root, "a"), b = join(root, "b"), alias = join(root, "alias");
  fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, "junction");
  const published = join(a, "catalog.json"), initialSelection = join(alias, "catalog.json");
  const full = JSON.stringify({ models: [{ slug: "ark/a", description: "Routed via opencodex → ark/a (owner)." }] });
  fs.writeFileSync(published, full);
  fs.writeFileSync(join(b, "catalog.json"), full);
  let selected = initialSelection, armed = false, swapped = false, converges = 0;
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => selected,
    subscribe: fn => { listener = fn; return () => {}; },
    observe: (path, content) => {
      if (armed && !swapped) {
        swapped = true;
        fs.renameSync(alias, join(root, "saved-alias"));
        fs.symlinkSync(b, alias, "junction");
        selected = published;
      }
      return observeCatalogHealFile(path, content);
    },
    converge: async (_config, lifecycle) => {
      converges++;
      expect(lifecycle.expectedCatalogPath).toBe(published);
      expect(lifecycle.beforeCommit()).toBe(true);
      return { committed: false };
    },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    if (released) listener({ kind: "native-released", path: published });
    armed = true;
    listener({ kind: "published", path: published, intent: "refresh" });
    expect(swapped).toBe(true);
    expect(compareCatalogHealPaths(initialSelection, selected)).toBe("different");
    fs.writeFileSync(published, JSON.stringify({ models: [] }));
    await handle.tickForTests();
    expect(converges).toBe(1);
  } finally { handle.stop(); }
});
