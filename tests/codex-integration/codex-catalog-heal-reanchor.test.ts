import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_HEAL_MAX_PATH_READS, compareCatalogHealPaths, observeCatalogHealFile } from "../../src/codex/catalog/heal-observation";
import { startCodexCatalogSelfHeal } from "../../src/codex/catalog-self-heal";
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
