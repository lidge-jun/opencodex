/**
 * #8183 / #8331: pnpm 11 and 12 install a global package as a link from the global group into
 * `<store>/v11/links/...`. The updater may accept that layout only when pnpm itself names the store
 * (`store path --dir=<pnpm home>`, never `--store-dir`), the anchor has no symlink component, the
 * pnpm version is one whose behavior was checked, and every link from the listed package path stays
 * inside the global group or that store. Default-store users must keep updating, and legacy groups
 * keep the behavior they had before this change (no store query at all).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { verifyPnpmInstallTree } from "../../src/update/transactional-install.mjs";
import { resolvePnpmGlobalOwner, runPnpmGlobalUpdate } from "../../src/update/pnpm-global-install.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PKG = "@bitkyc08/opencodex";
const BUN_BYTES = 10 * 1024 * 1024 + 1024;
const okShims = () => ({ ok: true });

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "junction");
}

/** One pnpm global-store package instance with its sibling dependencies, as pnpm 12.16.1 writes it. */
function writeInstance(store: string, version: string): string {
  const group = join(store, "links", "@bitkyc08", "opencodex", version, "h" + version.replaceAll(".", ""), "node_modules");
  const pkg = join(group, "@bitkyc08", "opencodex");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PKG, version, dependencies: { bun: "1", zod: "1" } }));
  writeFileSync(join(pkg, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
  for (const name of ["bun", "zod"]) {
    mkdirSync(join(group, name), { recursive: true });
    writeFileSync(join(group, name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  writeFileSync(join(group, "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
  return pkg;
}

type Call = string[];
type Layout = {
  root: string; home: string; store: string; globalDir: string; globalRoot: string; bin: string;
  exposed: string; real: string; env: NodeJS.ProcessEnv; calls: Call[];
  version: string; storeOutput: () => string;
  run: (args: string[]) => { status: number; stdout?: string };
};

function globalStoreLayout(root: string, opts: { pnpmVersion?: string } = {}): Layout {
  const home = join(root, "pnpm-home");
  const store = join(home, "store", "v11");
  const globalDir = join(home, "global");
  const globalRoot = join(globalDir, "v11");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const real = writeInstance(store, "1.0.0");
  const exposed = join(globalRoot, "e36c-0", "node_modules", "@bitkyc08", "opencodex");
  link(real, exposed);
  const layout: Layout = {
    root, home, store, globalDir, globalRoot, bin, exposed, real, calls: [],
    env: { PNPM_HOME: home, HOME: join(root, "user-home") },
    version: "1.0.0",
    storeOutput: () => store,
    run: args => {
      layout.calls.push([...args]);
      const [command] = args;
      if (command === "--version") return { status: 0, stdout: (opts.pnpmVersion ?? "12.16.1") + "\n" };
      if (command === "list") {
        return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: layout.version, path: exposed } } }]) };
      }
      if (command === "root") return { status: 0, stdout: globalRoot + "\n" };
      if (command === "bin") return { status: 0, stdout: bin + "\n" };
      if (command === "config") return { status: 0, stdout: "undefined\n" };
      if (command === "store" && args[1] === "path") {
        if (args.length !== 3 || args[2] !== "--dir=" + home) return { status: 1 };
        return { status: 0, stdout: layout.storeOutput() + "\n" };
      }
      if (command === "add") {
        const spec = args.at(-1) ?? "";
        const target = spec.slice(spec.lastIndexOf("@") + 1);
        unlinkSync(exposed);
        link(writeInstance(store, target), exposed);
        layout.version = target;
        return { status: 0 };
      }
      return { status: 1 };
    },
  };
  return layout;
}

function resolveOwner(layout: Layout, packagePath = layout.exposed) {
  return resolvePnpmGlobalOwner({
    packageName: PKG, packagePath, commandPaths: [join(layout.root, "pnpm")],
    runPnpm: (_command, args) => layout.run(args), env: layout.env,
  });
}

function storeCalls(layout: Layout): Call[] {
  return layout.calls.filter(args => args[0] === "store");
}

describe("pnpm global virtual-store owner (#8183)", () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-pnpm-global-store-"))); });
  afterEach(() => { removeTreeWithRetry(root); });

  test("a default-store install resolves through pnpm's store path and updates with the lexical store pinned", () => {
    const layout = globalStoreLayout(root);
    const resolved = resolveOwner(layout);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    expect(resolved.owner).toMatchObject({ globalStore: true, storePath: layout.store, store: realpathSync(layout.store) });
    // The query is pnpm's own answer for the pnpm home: no --store-dir, no global flags.
    expect(storeCalls(layout)).toEqual([["store", "path", "--dir=" + layout.home]]);

    layout.calls.length = 0;
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest",
      owner: resolved.owner, runPnpm: args => layout.run(args), verifyShims: okShims,
    });
    expect(result).toMatchObject({ ok: true, version: "2.0.0" });
    const add = layout.calls.find(args => args[0] === "add");
    expect(add).toContain("--store-dir=" + layout.store);
    expect(storeCalls(layout).every(args => args.length === 3 && args[2] === "--dir=" + layout.home)).toBe(true);
  });

  test("an empty node_modules above pnpm home or an unrelated NODE_PATH does not refuse a default-store install", () => {
    const layout = globalStoreLayout(root);
    // A user's ~/node_modules sits above the default pnpm home on macOS and Linux.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const elsewhere = join(root, "elsewhere", "lib", "node_modules");
    mkdirSync(join(elsewhere, "unrelated"), { recursive: true });
    const original = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = elsewhere;
      expect(resolveOwner(layout)).toMatchObject({ ok: true, owner: { globalStore: true } });
    } finally {
      if (original === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = original;
    }
  });

  test("a declared dependency missing from the store still refuses when an outside ancestor could supply it", () => {
    const layout = globalStoreLayout(root);
    rmSync(join(dirname(layout.real), "..", "zod"), { recursive: true, force: true });
    mkdirSync(join(root, "node_modules", "zod"), { recursive: true });
    writeFileSync(join(root, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "1.0.0" }));
    const result = resolveOwner(layout);
    expect(result.ok).toBe(false);
  });

  test("the relative link pnpm itself writes (a ../ climb from the global group into the store) is accepted", () => {
    const layout = globalStoreLayout(root);
    const text = relative(dirname(layout.exposed), layout.real);
    expect(text.startsWith("..")).toBe(true);
    unlinkSync(layout.exposed);
    symlinkSync(text, layout.exposed);
    expect(verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot)).toEqual({ ok: true, failures: [] });
    expect(resolveOwner(layout)).toMatchObject({ ok: true, owner: { globalStore: true, storePath: layout.store } });
  });

  test("a dangling NODE_PATH entry does not refuse a default-store install", () => {
    const layout = globalStoreLayout(root);
    const dangling = join(root, "dangling-node-path");
    symlinkSync(join(root, "missing-target"), dangling);
    const original = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = dangling;
      expect(resolveOwner(layout)).toMatchObject({ ok: true, owner: { globalStore: true } });
    } finally {
      if (original === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = original;
    }
  });

  test("a NODE_PATH link outside the store that points into it is skipped like any outside entry", () => {
    const layout = globalStoreLayout(root);
    const outsideLink = join(root, "node-path-link");
    link(join(layout.store, "links"), outsideLink);
    const original = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = outsideLink;
      expect(resolveOwner(layout)).toMatchObject({ ok: true, owner: { globalStore: true } });
    } finally {
      if (original === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = original;
    }
  });

  test("on Windows a pnpm home or store path with cmd.exe metacharacters is refused before it reaches pnpm", () => {
    for (const name of ["a&calc", "p%USERPROFILE%", "b^c", "q!x"]) {
      const layout = globalStoreLayout(join(root, name));
      expect(resolvePnpmGlobalOwner({
        packageName: PKG, packagePath: layout.exposed, commandPaths: [join(layout.root, "pnpm")],
        runPnpm: (_command, args) => layout.run(args), env: layout.env, platform: "win32",
      })).toEqual({ ok: false, reason: "pnpm path contains a character cmd.exe cannot pass safely" });
      expect(storeCalls(layout)).toEqual([]);
      // No owner-pinned pnpm argv (list --global-dir=..., --version, store path) may carry the character.
      expect(layout.calls.filter(args => args.some(arg => /["%!^&|<>]/.test(arg)))).toEqual([]);
    }
    // The printed store path is checked too, before it can become --store-dir.
    const layout = globalStoreLayout(join(root, "plain"));
    const cmdStore = join(layout.home, "store&calc", "v11");
    mkdirSync(cmdStore, { recursive: true });
    layout.storeOutput = () => cmdStore;
    const result = resolvePnpmGlobalOwner({
      packageName: PKG, packagePath: layout.exposed, commandPaths: [join(layout.root, "pnpm")],
      runPnpm: (_command, args) => layout.run(args), env: layout.env, platform: "win32",
    });
    expect(result).toEqual({ ok: false, reason: "pnpm path contains a character cmd.exe cannot pass safely" });
    expect(storeCalls(layout)).toHaveLength(1);
  });

  test("pnpm 11 uses the same proof", () => {
    const layout = globalStoreLayout(root, { pnpmVersion: "11.20.0" });
    expect(resolveOwner(layout)).toMatchObject({ ok: true, owner: { globalStore: true } });
  });

  test("a legacy hoisted group with an unset store keeps owner discovery without any store query", () => {
    const globalDir = join(root, "global"), globalRoot = join(globalDir, "v11");
    const group = join(globalRoot, "node_modules"), pkg = join(group, ...PKG.split("/"));
    const bin = join(root, "bin"), calls: Call[] = [];
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PKG, version: "2.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(pkg, "bin", "ocx.mjs"), "x".repeat(2048));
    for (const name of ["bun", "zod"]) {
      mkdirSync(join(group, name), { recursive: true });
      writeFileSync(join(group, name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(group, "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
    writeFileSync(join(group, ".modules.yaml"), "nodeLinker: hoisted\n");
    const result = resolvePnpmGlobalOwner({
      packageName: PKG, packagePath: pkg, commandPaths: [join(root, "pnpm")],
      runPnpm: (_command, args) => {
        calls.push([...args]);
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: pkg } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "config" && args[2] === "global-dir") return { status: 0, stdout: globalDir };
        if (args[0] === "config" && args[2] === "global-bin-dir") return { status: 0, stdout: bin };
        if (args[0] === "config") return { status: 0, stdout: "undefined" };
        return { status: 1 };
      },
      env: { PNPM_HOME: join(root, "missing-home") },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.owner.globalStore).toBeUndefined();
    expect(calls.some(args => args[0] === "store" || args[0] === "--version")).toBe(false);
  });

  test("a package link that leaves both roots before entering the store is refused", () => {
    const layout = globalStoreLayout(root);
    expect(resolveOwner(layout)).toMatchObject({ ok: true });
    expect(verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot).ok).toBe(true);

    const relay = join(root, "outside", "relay");
    link(layout.real, relay);
    unlinkSync(layout.exposed);
    link(relay, layout.exposed);
    // pnpm still reports the global-group spelling; only the hop between them moved outside.
    const listed = JSON.parse(layout.run(["list", "-g", "--depth=0", "--json", PKG]).stdout ?? "[]")[0].dependencies[PKG].path;
    expect(listed).toBe(layout.exposed);
    expect(inside(listed, layout.globalRoot)).toBe(true);
    expect(inside(relay, layout.globalRoot) || inside(relay, layout.store)).toBe(false);
    expect(inside(realpathSync(listed), realpathSync(layout.store))).toBe(true);

    const direct = verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot);
    expect(direct.ok).toBe(false);
    expect(direct.failures[0]).toBe("pnpm global links are outside the selected store");
    layout.calls.length = 0;
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm global links are outside the selected store" });
  });

  test("a single package link whose text leaves both roots and returns through .. is refused", () => {
    const layout = globalStoreLayout(root);
    const relay = join(root, "outside", "relay");
    mkdirSync(relay, { recursive: true });
    // One symlink: ../outside/relay/../../<store package>. path.resolve would collapse the detour.
    const fromDir = dirname(layout.exposed);
    const detour = relative(fromDir, relay) + "/../../" + relative(root, layout.real);
    unlinkSync(layout.exposed);
    symlinkSync(detour, layout.exposed);
    expect(realpathSync(layout.exposed)).toBe(realpathSync(layout.real));
    expect(inside(relay, layout.globalRoot) || inside(relay, layout.store)).toBe(false);
    expect(verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot))
      .toEqual({ ok: false, failures: ["pnpm global links are outside the selected store"] });
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm global links are outside the selected store" });
  });

  test("a .. segment in pnpm home, the printed store path or a verifier root cannot hide a link", () => {
    // <root>/link -> <root>/elsewhere/deep, so <root>/link/../pnpm-home resolves to <root>/elsewhere/pnpm-home
    // on disk while path.resolve would read it as <root>/pnpm-home.
    const layout = globalStoreLayout(root);
    mkdirSync(join(root, "elsewhere", "deep"), { recursive: true });
    mkdirSync(join(root, "elsewhere", "pnpm-home"), { recursive: true });
    link(join(root, "elsewhere", "deep"), join(root, "link"));
    const dotted = join(root, "link") + "/../pnpm-home";
    layout.env = { PNPM_HOME: dotted };
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm home is not a canonical path" });
    expect(storeCalls(layout)).toEqual([]);

    layout.env = { PNPM_HOME: layout.home };
    layout.storeOutput = () => layout.home + "/../pnpm-home/store/v11";
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm store path is not a canonical path" });

    expect(verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot, layout.home + "/../pnpm-home/store/v11"))
      .toEqual({ ok: false, failures: ["pnpm store or global group path is not canonical"] });
  });

  test("a pnpm home containing a control character refuses before pnpm runs a store query", () => {
    const layout = globalStoreLayout(root);
    layout.env = { PNPM_HOME: layout.home + "\nrm" };
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm home could not be determined" });
    expect(storeCalls(layout)).toEqual([]);
  });

  test("a symlink in the pnpm home anchor refuses before the store is queried", () => {
    const layout = globalStoreLayout(root);
    const alias = join(root, "alias-home");
    link(layout.home, alias);
    layout.env = { PNPM_HOME: alias };
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm home has a symbolic link component" });
    expect(storeCalls(layout)).toEqual([]);
  });

  test("an unchecked pnpm version refuses before the store is queried", () => {
    for (const version of ["10.12.3", "13.0.0", "not-a-version"]) {
      const layout = globalStoreLayout(join(root, version), { pnpmVersion: version });
      expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm global-store behavior is not verified for this pnpm version" });
      expect(storeCalls(layout)).toEqual([]);
    }
  });

  test("store path output must be one absolute versioned path", () => {
    for (const output of ["undefined", "relative/store/v11", "STORE/v11\nSTORE/v11", "STORE", "STORE/v11-wasm"]) {
      const layout = globalStoreLayout(join(root, String(output.length) + output.replace(/[^a-z]/gi, "")));
      layout.storeOutput = () => output.replaceAll("STORE", dirname(layout.store));
      expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm store path is not one absolute versioned path" });
    }
  });

  test("a listed package outside the store pnpm names is refused", () => {
    const layout = globalStoreLayout(root);
    const other = join(root, "other-store", "v11");
    mkdirSync(other, { recursive: true });
    layout.storeOutput = () => other;
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm global-store package is outside the selected store" });
  });

  test("a store spelling that gains a symbolic link after discovery refuses before pnpm add", () => {
    const layout = globalStoreLayout(root);
    const resolved = resolveOwner(layout);
    if (!resolved.ok) throw new Error(resolved.reason);
    const update = () => runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest",
      owner: resolved.owner, runPnpm: args => layout.run(args), verifyShims: okShims,
    });

    // Same canonical store, different spelling through a link.
    const alias = join(root, "store-alias");
    link(dirname(layout.store), alias);
    layout.storeOutput = () => join(alias, "v11");
    layout.calls.length = 0;
    expect(update()).toMatchObject({ ok: false, phase: "preflight", error: "pnpm store path has a symbolic link component" });
    expect(layout.calls.some(args => args[0] === "add")).toBe(false);

    // Same spelling, different canonical store.
    const moved = layout.root + "/moved-store";
    layout.storeOutput = () => layout.store;
    const resolvedAgain = resolveOwner(layout);
    if (!resolvedAgain.ok) throw new Error(resolvedAgain.reason);
    rmSync(join(root, "pnpm-home", "store"), { recursive: true, force: true });
    writeInstance(join(moved, "v11"), "1.0.0");
    link(moved, join(root, "pnpm-home", "store"));
    layout.calls.length = 0;
    expect(runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest",
      owner: resolvedAgain.owner, runPnpm: args => layout.run(args), verifyShims: okShims,
    })).toMatchObject({ ok: false, phase: "preflight", error: "pnpm store path has a symbolic link component" });
    expect(layout.calls.some(args => args[0] === "add")).toBe(false);
  });

  test("a symbolic link in the store or global group spelling refuses discovery (relay through a linked root)", () => {
    // store/v11 -> elsewhere: a relay under the target would count as inside a canonicalized root.
    const layout = globalStoreLayout(root);
    const moved = join(root, "moved-store");
    writeInstance(join(moved, "v11"), "1.0.0");
    rmSync(join(layout.home, "store"), { recursive: true, force: true });
    link(moved, join(layout.home, "store"));
    unlinkSync(layout.exposed);
    link(join(moved, "v11", "links", "@bitkyc08", "opencodex", "1.0.0", "h100", "node_modules", "@bitkyc08", "opencodex"), layout.exposed);
    expect(resolveOwner(layout)).toEqual({ ok: false, reason: "pnpm store path has a symbolic link component" });

    const other = globalStoreLayout(join(root, "group-case"));
    const realGroup = join(root, "group-case", "real-global-v11");
    mkdirSync(dirname(realGroup), { recursive: true });
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(other.globalRoot, realGroup);
    link(realGroup, other.globalRoot);
    expect(resolveOwner(other)).toEqual({ ok: false, reason: "pnpm global group has a symbolic link component" });
  });
});
