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
import { pnpmPackageUsesGlobalStoreLinks, verifyPnpmInstallTree } from "../../src/update/transactional-install.mjs";
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

/** Every refusal of a store-like install carries guidance on why and what to run (owner decision B on #8331). */
const STORE_HINT = "; this install's path looks like a pnpm global store (a store links directory or pnpm store markers), "
  + "so the updater accepts it only when pnpm 11 or 12 names that store. Update with pnpm itself: "
  + "pnpm add -g @bitkyc08/opencodex@latest";
function storeRefusal(reason: string) {
  return { ok: false, reason: reason + STORE_HINT };
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

  test("a NODE_PATH entry spelled inside the store whose link leaves it is refused", () => {
    const layout = globalStoreLayout(root);
    const outside = join(root, "outside-modules");
    mkdirSync(join(outside, "foreign"), { recursive: true });
    const inStore = join(layout.store, "links", "node-path-escape");
    link(outside, inStore);
    const original = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = inStore;
      const result = verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot);
      expect(result.ok).toBe(false);
      expect(result.failures).toContain("pnpm global dependency lookup root is outside the selected store");
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
      })).toEqual(storeRefusal("pnpm path contains a character cmd.exe cannot pass safely"));
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
    expect(result).toEqual(storeRefusal("pnpm path contains a character cmd.exe cannot pass safely"));
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
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm global links are outside the selected store"));
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
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm global links are outside the selected store"));
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
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm home is not a canonical path"));
    expect(storeCalls(layout)).toEqual([]);

    layout.env = { PNPM_HOME: layout.home };
    layout.storeOutput = () => layout.home + "/../pnpm-home/store/v11";
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm store path is not a canonical path"));

    expect(verifyPnpmInstallTree(layout.exposed, "1.0.0", layout.store, layout.globalRoot, layout.home + "/../pnpm-home/store/v11"))
      .toEqual({ ok: false, failures: ["pnpm store or global group path is not canonical"] });
  });

  test("a listed package spelling with .. that hides an outside relay is refused", () => {
    const layout = globalStoreLayout(root);
    // <group>/relay -> <root>/outside/deep, so the OS reads <group>/relay/../node_modules as
    // <root>/outside/node_modules while path.resolve reads it as <group>/node_modules.
    const group = dirname(dirname(dirname(layout.exposed)));
    link(join(root, "outside", "deep"), join(group, "relay"));
    mkdirSync(join(root, "outside", "deep"), { recursive: true });
    link(layout.real, join(root, "outside", "node_modules", "@bitkyc08", "opencodex"));
    const dotted = join(group, "relay") + "/../node_modules/@bitkyc08/opencodex";
    expect(realpathSync(dotted)).toBe(realpathSync(layout.real));
    const run = layout.run;
    layout.run = args => args[0] === "list"
      ? { status: 0, stdout: JSON.stringify([{ path: layout.globalRoot, dependencies: { [PKG]: { version: layout.version, path: dotted } } }]) }
      : run(args);
    expect(verifyPnpmInstallTree(dotted, "1.0.0", layout.store, layout.globalRoot))
      .toEqual({ ok: false, failures: ["pnpm package path is not canonical"] });
    expect(resolveOwner(layout, dotted)).toEqual(storeRefusal("pnpm package path is not canonical"));
  });

  test("an unmarked layout under a store directory keeps the released legacy verifier (rule 5)", () => {
    // store/v11/alternate/<hash>/node_modules with .modules.yaml and no pnpm store markers or links.
    // Without a store query this cannot be told apart from a legacy group, and origin/dev accepts it on
    // the legacy verifier; markers only classify (rule 1) and legacy groups keep dev behavior (rule 5).
    const layout = globalStoreLayout(root);
    const group = join(layout.store, "alternate", "h1", "node_modules");
    const pkg = join(group, "@bitkyc08", "opencodex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(pkg, "bin", "ocx.mjs"), "x".repeat(2048));
    for (const name of ["bun", "zod"]) {
      mkdirSync(join(group, name), { recursive: true });
      writeFileSync(join(group, name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(group, "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
    writeFileSync(join(group, ".modules.yaml"), "nodeLinker: hoisted\n");
    unlinkSync(layout.exposed);
    link(pkg, layout.exposed);
    const result = resolveOwner(layout);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.owner.globalStore).toBeUndefined();
    expect(layout.calls.some(args => args[0] === "--version" || args[0] === "store")).toBe(false);
  });

  // <root>/v1/external/g/node_modules is a versioned name that is not a pnpm store, and origin/dev accepts it:
  // with no store links or pnpm store markers it is not classified, so it keeps the released verifier with no
  // query (rule 5 covers unclassified legacy groups). <root>/v1/links/g/node_modules is spelled like store links,
  // and a spelling is never proof (rule 1), so it must earn pnpm's store answer; without one it is refused
  // with guidance (owner decision B on #8331).
  for (const [label, segments] of [["external", ["v1", "external", "g"]], ["links", ["v1", "links", "g"]]] as const) {
    test(`a legacy group under a v<N>/${label} directory: ${label === "links" ? "store proof required, refused with guidance" : "released verifier, no store query"}`, () => {
      const globalDir = join(root, "global"), globalRoot = join(globalDir, "v11"), bin = join(root, "bin");
      const group = join(root, ...segments, "node_modules"), pkg = join(group, ...PKG.split("/"));
      const exposed = join(globalRoot, "node_modules", ...PKG.split("/"));
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
      // An entry with a store-like name beside the versioned directory is not store evidence either.
      mkdirSync(join(root, "v1", "files"), { recursive: true });
      link(pkg, exposed);
      const calls: Call[] = [];
      const result = resolvePnpmGlobalOwner({
        packageName: PKG, packagePath: exposed, commandPaths: [join(root, "pnpm")], env: { PNPM_HOME: join(root, "missing-home") },
        runPnpm: (_command, args) => {
          calls.push([...args]);
          if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: exposed } } }]) };
          if (args[0] === "root") return { status: 0, stdout: globalRoot };
          if (args[0] === "config" && args[2] === "global-dir") return { status: 0, stdout: globalDir };
          if (args[0] === "config" && args[2] === "global-bin-dir") return { status: 0, stdout: bin };
          if (args[0] === "config") return { status: 0, stdout: "undefined" };
          return { status: 1 };
        },
      });
      if (label === "external") {
        expect(result).toMatchObject({ ok: true });
        if (result.ok) expect(result.owner.globalStore).toBeUndefined();
        expect(calls.some(args => args[0] === "store" || args[0] === "--version")).toBe(false);
        expect(verifyPnpmInstallTree(exposed, "2.0.0")).toMatchObject({ ok: true });
        return;
      }
      // This fixture's pnpm answers no --version, so the store proof is unavailable.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.startsWith("pnpm global-store behavior is not verified")).toBe(true);
        expect(result.reason).toContain("looks like a pnpm global store");
        expect(result.reason).toContain("pnpm add -g @bitkyc08/opencodex@latest");
      }
      expect(calls.some(args => args[0] === "store")).toBe(false);
      expect(verifyPnpmInstallTree(exposed, "2.0.0")).toMatchObject({ ok: false, failures: ["pnpm global links are outside the selected store"] });
    });
  }

  // Same hoisted tree as the legacy v1/links case, but listed at its own path with no symlink in between. A
  // node_modules/.pnpm segment ABOVE the links directory does not make it an isolated install.
  for (const prefix of [["v1", "links", "g"], ["node_modules", ".pnpm", "host", "v1", "links", "g"]]) {
  test(`a package pnpm lists directly inside ${prefix.join("/")} must earn the store proof (decision B)`, () => {
    const globalRoot = join(root, ...prefix), bin = join(root, "bin");
    const group = join(globalRoot, "node_modules"), pkg = join(group, ...PKG.split("/"));
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
    const calls: Call[] = [];
    const result = resolvePnpmGlobalOwner({
      packageName: PKG, packagePath: pkg, commandPaths: [join(root, "pnpm")], env: { PNPM_HOME: join(root, "missing-home") },
      runPnpm: (_command, args) => {
        calls.push([...args]);
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: pkg } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "config" && args[2] === "global-dir") return { status: 0, stdout: dirname(globalRoot) };
        if (args[0] === "config" && args[2] === "global-bin-dir") return { status: 0, stdout: bin };
        if (args[0] === "config") return { status: 0, stdout: "undefined" };
        return { status: 1 };
      },
    });
    expect(result).toEqual(storeRefusal("pnpm global-store behavior is not verified for this pnpm version"));
    expect(calls.some(args => args[0] === "--version")).toBe(true);
    expect(calls.some(args => args[0] === "store")).toBe(false);
    expect(verifyPnpmInstallTree(pkg, "2.0.0")).toMatchObject({ ok: false, failures: ["pnpm global links are outside the selected store"] });
  });
  }

  test("a store-like running package that no pnpm candidate lists is refused with the remedy", () => {
    const layout = globalStoreLayout(root);
    const run = layout.run;
    layout.run = args => args[0] === "list" ? { status: 1 } : run(args);
    expect(resolveOwner(layout)).toEqual(storeRefusal("no pnpm global installation owns the running package"));
  });

  test("markers of an enclosing store are found past a nested v<N> directory", () => {
    // store/v11 carries pnpm's files and index markers; the package sits in a nested v2 directory below it.
    const layout = globalStoreLayout(root);
    mkdirSync(join(layout.store, "files"), { recursive: true });
    writeFileSync(join(layout.store, "index.db"), "");
    const group = join(layout.store, "custom", "v2", "slot", "node_modules"), pkg = join(group, ...PKG.split("/"));
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(pkg, "bin", "ocx.mjs"), "x".repeat(2048));
    for (const name of ["bun", "zod"]) {
      mkdirSync(join(group, name), { recursive: true });
      writeFileSync(join(group, name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(group, "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
    writeFileSync(join(group, ".modules.yaml"), "nodeLinker: hoisted\n");
    unlinkSync(layout.exposed);
    link(pkg, layout.exposed);
    expect(pnpmPackageUsesGlobalStoreLinks(layout.exposed)).toBe(true);
    // Classified, so the owner must come from pnpm's store answer; the package lies inside the named store.
    const result = resolveOwner(layout);
    expect(result).toMatchObject({ ok: true, owner: { globalStore: true, storePath: layout.store } });
    expect(storeCalls(layout)).toEqual([["store", "path", "--dir=" + layout.home]]);
  });

  test("a listed path below a marked store whose package link points elsewhere still demands the store proof", () => {
    const layout = globalStoreLayout(root);
    mkdirSync(join(layout.store, "files"), { recursive: true });
    writeFileSync(join(layout.store, "index.db"), "");
    // A self-contained package outside the store, reached from a slot spelled inside the marked store.
    const outsideGroup = join(root, "outside", "node_modules"), outside = join(outsideGroup, ...PKG.split("/"));
    mkdirSync(join(outside, "bin"), { recursive: true });
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(outside, "bin", "ocx.mjs"), "x".repeat(2048));
    for (const name of ["bun", "zod"]) {
      mkdirSync(join(outside, "node_modules", name), { recursive: true });
      writeFileSync(join(outside, "node_modules", name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(outside, "node_modules", "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
    const slot = join(layout.store, "custom", "slot", "node_modules", ...PKG.split("/"));
    link(outside, slot);
    unlinkSync(layout.exposed);
    link(slot, layout.exposed);
    expect(verifyPnpmInstallTree(outside, "1.0.0")).toMatchObject({ ok: true });
    expect(pnpmPackageUsesGlobalStoreLinks(layout.exposed)).toBe(true);
    const result = resolveOwner(layout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.endsWith(STORE_HINT)).toBe(true);
    expect(storeCalls(layout)).toEqual([["store", "path", "--dir=" + layout.home]]);
  });

  test("owner refusals before the store proof also carry the remedy for a store-like install", () => {
    // pnpm reports a different global root than its listing: the group and bin directory cannot be bound.
    const unbound = globalStoreLayout(join(root, "unbound"));
    const run = unbound.run;
    unbound.run = args => args[0] === "root" ? { status: 0, stdout: join(unbound.root, "elsewhere", "v11") + "\n" } : run(args);
    expect(resolveOwner(unbound)).toEqual(storeRefusal("pnpm owns the running package but did not report its global group and bin directory"));
    // The process was entered through a command shim outside the global bin directory.
    const shim = globalStoreLayout(join(root, "shim"));
    expect(resolvePnpmGlobalOwner({
      packageName: PKG, packagePath: shim.exposed, commandPaths: [join(shim.root, "pnpm")], runningShimPath: join(shim.root, "other-bin", "ocx"),
      runPnpm: (_command, args) => shim.run(args), env: shim.env,
    })).toEqual(storeRefusal("pnpm package owner did not match the running global shim"));
    expect([...storeCalls(unbound), ...storeCalls(shim)]).toEqual([]);
  });

  test("re-resolving a store-pinned owner runs the store proof even for a tree its spelling would not classify", () => {
    // store/v11/alternate/<hash>/node_modules: unmarked, so plain discovery keeps the released verifier. The
    // orchestrated post-update check re-resolves a store-pinned owner with requireStoreProof and must re-prove it.
    const layout = globalStoreLayout(root);
    const group = join(layout.store, "alternate", "h1", "node_modules");
    const pkg = join(group, "@bitkyc08", "opencodex");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(pkg, "bin", "ocx.mjs"), "x".repeat(2048));
    for (const name of ["bun", "zod"]) {
      mkdirSync(join(group, name), { recursive: true });
      writeFileSync(join(group, name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(group, "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
    writeFileSync(join(group, ".modules.yaml"), "nodeLinker: hoisted\n");
    unlinkSync(layout.exposed);
    link(pkg, layout.exposed);
    const pinned = resolvePnpmGlobalOwner({
      packageName: PKG, packagePath: layout.exposed, commandPaths: [join(layout.root, "pnpm")],
      runPnpm: (_command, args) => layout.run(args), env: layout.env, requireStoreProof: true,
    });
    expect(pinned).toMatchObject({ ok: true, owner: { globalStore: true, store: realpathSync(layout.store), storePath: layout.store } });
    expect(storeCalls(layout)).toEqual([["store", "path", "--dir=" + layout.home]]);
  });

  test("a pnpm home containing a control character refuses before pnpm runs a store query", () => {
    const layout = globalStoreLayout(root);
    layout.env = { PNPM_HOME: layout.home + "\nrm" };
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm home could not be determined"));
    expect(storeCalls(layout)).toEqual([]);
  });

  test("a symlink in the pnpm home anchor refuses before the store is queried", () => {
    const layout = globalStoreLayout(root);
    const alias = join(root, "alias-home");
    link(layout.home, alias);
    layout.env = { PNPM_HOME: alias };
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm home has a symbolic link component"));
    expect(storeCalls(layout)).toEqual([]);
  });

  test("an unchecked pnpm version refuses before the store is queried", () => {
    for (const version of ["10.12.3", "13.0.0", "not-a-version"]) {
      const layout = globalStoreLayout(join(root, version), { pnpmVersion: version });
      expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm global-store behavior is not verified for this pnpm version"));
      expect(storeCalls(layout)).toEqual([]);
    }
  });

  test("store path output must be one absolute versioned path", () => {
    for (const output of ["undefined", "relative/store/v11", "STORE/v11\nSTORE/v11", "STORE", "STORE/v11-wasm"]) {
      const layout = globalStoreLayout(join(root, String(output.length) + output.replace(/[^a-z]/gi, "")));
      layout.storeOutput = () => output.replaceAll("STORE", dirname(layout.store));
      expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm store path is not one absolute versioned path"));
    }
  });

  test("a listed package outside the store pnpm names is refused", () => {
    const layout = globalStoreLayout(root);
    const other = join(root, "other-store", "v11");
    mkdirSync(other, { recursive: true });
    layout.storeOutput = () => other;
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm global-store package is outside the selected store"));
  });

  test("a global group that becomes a link during pnpm add is never rolled back through", () => {
    const layout = globalStoreLayout(root);
    const resolved = resolveOwner(layout);
    if (!resolved.ok) throw new Error(resolved.reason);
    const run = layout.run;
    layout.run = args => {
      const result = run(args);
      if (args[0] === "add") {
        // The add leaves the group behind a link to the same tree.
        const { renameSync } = require("node:fs") as typeof import("node:fs");
        const real = join(root, "moved-global-v11");
        renameSync(layout.globalRoot, real);
        link(real, layout.globalRoot);
      }
      return result;
    };
    layout.calls.length = 0;
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest",
      owner: resolved.owner, runPnpm: args => layout.run(args), verifyShims: okShims,
    });
    expect(result).toMatchObject({ ok: false, phase: "install", rolledBack: false,
      error: "pnpm global group has a symbolic link component" + STORE_HINT });
    expect(layout.calls.filter(args => args[0] === "add")).toHaveLength(1);
  });

  test("a listed v<N>/links spelling whose package link leaves that directory still demands the store proof", () => {
    // v7/links/group/node_modules/<pkg> is itself a link to a self-contained package elsewhere.
    const layout = globalStoreLayout(root);
    const outsideGroup = join(root, "elsewhere", "node_modules"), outside = join(outsideGroup, ...PKG.split("/"));
    mkdirSync(join(outside, "bin"), { recursive: true });
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", dependencies: { bun: "1", zod: "1" } }));
    writeFileSync(join(outside, "bin", "ocx.mjs"), "x".repeat(2048));
    for (const name of ["bun", "zod"]) {
      mkdirSync(join(outside, "node_modules", name), { recursive: true });
      writeFileSync(join(outside, "node_modules", name, "package.json"), JSON.stringify({ name }));
    }
    writeFileSync(join(outside, "node_modules", "bun", "bun.exe"), Buffer.alloc(BUN_BYTES));
    const slot = join(root, "v7", "links", "group", "node_modules", ...PKG.split("/"));
    link(outside, slot);
    unlinkSync(layout.exposed);
    link(slot, layout.exposed);
    expect(verifyPnpmInstallTree(outside, "1.0.0")).toMatchObject({ ok: true });
    expect(pnpmPackageUsesGlobalStoreLinks(slot)).toBe(true);
    expect(pnpmPackageUsesGlobalStoreLinks(layout.exposed)).toBe(true);
    const result = resolveOwner(layout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.endsWith(STORE_HINT)).toBe(true);
  });

  test("a global group replaced by another directory before rollback is never rolled back through", () => {
    const layout = globalStoreLayout(root);
    const resolved = resolveOwner(layout);
    if (!resolved.ok) throw new Error(resolved.reason);
    const run = layout.run;
    let lists = 0;
    layout.run = args => {
      // Post-install listing fails, so the updater would roll back; the add swapped the group for a copy.
      if (args[0] === "list" && ++lists === 2) return { status: 1 };
      const result = run(args);
      if (args[0] === "add" && lists === 1) {
        const { renameSync, cpSync } = require("node:fs") as typeof import("node:fs");
        const old = join(root, "old-global-v11");
        renameSync(layout.globalRoot, old);
        cpSync(old, layout.globalRoot, { recursive: true, verbatimSymlinks: true });
      }
      return result;
    };
    layout.calls.length = 0;
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest",
      owner: resolved.owner, runPnpm: args => layout.run(args), verifyShims: okShims,
    });
    expect(result).toMatchObject({ ok: false, phase: "rollback", rolledBack: false,
      error: "pnpm global group was replaced or could not be read" + STORE_HINT });
    expect(layout.calls.filter(args => args[0] === "add")).toHaveLength(1);
  });

  test("a store replaced by another directory at the same path before rollback is never rolled back into", () => {
    const layout = globalStoreLayout(root);
    const resolved = resolveOwner(layout);
    if (!resolved.ok) throw new Error(resolved.reason);
    const run = layout.run;
    let lists = 0;
    layout.run = args => {
      // Post-install listing fails, so the updater would roll back; the add swapped the store for a copy.
      if (args[0] === "list" && ++lists === 2) return { status: 1 };
      const result = run(args);
      if (args[0] === "add" && lists === 1) {
        const { renameSync, cpSync } = require("node:fs") as typeof import("node:fs");
        const old = join(root, "old-store-v11");
        renameSync(layout.store, old);
        cpSync(old, layout.store, { recursive: true, verbatimSymlinks: true });
      }
      return result;
    };
    layout.calls.length = 0;
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest",
      owner: resolved.owner, runPnpm: args => layout.run(args), verifyShims: okShims,
    });
    expect(result).toMatchObject({ ok: false, phase: "rollback", rolledBack: false,
      error: "pnpm configured store was replaced or could not be read" + STORE_HINT });
    expect(layout.calls.filter(args => args[0] === "add")).toHaveLength(1);
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
    expect(update()).toMatchObject({ ok: false, phase: "preflight", error: "pnpm store path has a symbolic link component" + STORE_HINT });
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
    })).toMatchObject({ ok: false, phase: "preflight", error: "pnpm store path has a symbolic link component" + STORE_HINT });
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
    expect(resolveOwner(layout)).toEqual(storeRefusal("pnpm store path has a symbolic link component"));

    const other = globalStoreLayout(join(root, "group-case"));
    const realGroup = join(root, "group-case", "real-global-v11");
    mkdirSync(dirname(realGroup), { recursive: true });
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    renameSync(other.globalRoot, realGroup);
    link(realGroup, other.globalRoot);
    expect(resolveOwner(other)).toEqual(storeRefusal("pnpm global group has a symbolic link component"));
  });
});
