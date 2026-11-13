/**
 * #4202 review (Ingwannu, blocking on PR #4203): the pnpm path may resolve a dependency
 * outside the package directory, but the npm verifier must stay confined to the candidate's
 * own tree. Node's resolver walks the ancestor chain, so a global npm candidate can otherwise
 * satisfy its bundled-Bun requirement from a sibling package's install. Three decisions read
 * that verdict — accepting the stage, rolling back after the swap, and reaping the only
 * backup at boot — so a non-self-contained candidate called healthy costs the known-good copy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  bootRestoreProbe,
  verifyInstallTree,
  verifyPnpmInstallTree,
} from "../../src/update/transactional-install.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { readPnpmGlobalPackage, resolvePnpmGlobalOwner } from "../../src/update/pnpm-global-install.mjs";

const PKG = "@bitkyc08/opencodex";
const BUN_BYTES = 10 * 1024 * 1024 + 1024;

/** The global group that exposes a package: the parent of its enclosing node_modules. */
function exposingGroup(path: string): string {
  let dir = dirname(path);
  while (basename(dir) !== "node_modules") dir = dirname(dir);
  return dirname(dir);
}

/** A real pnpm home: the global-store proof refuses an anchor that is missing or reached through a link. */
const STORE_PROOF_HOME = realpathSync(mkdtempSync(join(tmpdir(), "ocx-tree-pnpm-home-")));

/**
 * Owner discovery with the store-proof inputs a global-store owner needs: pnpm 12 and a real pnpm
 * home. Each fixture's own mock still decides what \`store path\` prints and what pnpm lists.
 */
function resolveOwnerWithStoreProof(options: Parameters<typeof resolvePnpmGlobalOwner>[0]) {
  return resolvePnpmGlobalOwner({
    env: { PNPM_HOME: STORE_PROOF_HOME },
    ...options,
    runPnpm: (command, args, capture, owner) => args[0] === "--version"
      ? { status: 0, stdout: "12.16.1" } : options.runPnpm(command, args, capture, owner),
  });
}

/** A dependency directory that would satisfy the manifest if it were ever consulted. */
function writeDependency(dir: string, name: string, opts: { truncated?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  if (name === "bun") {
    writeFileSync(join(dir, "bun.exe"), Buffer.alloc(opts.truncated ? 1024 : BUN_BYTES));
  }
}

/** The package itself, with no dependencies of its own unless the caller adds them. */
function writePackage(packageDir: string, version: string): void {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: PKG, version, dependencies: { bun: "1", zod: "1" },
  }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
}

describe("#4202 install-tree dependency ownership", () => {
  let root: string;

  beforeEach(() => {
    // Canonical spelling: link targets below are compared with the canonical store and group.
    root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-tree-ownership-")));
  });

  afterEach(() => {
    removeTreeWithRetry(root);
  });

  /** Global npm layout: <prefix>/lib/node_modules/{@scope/pkg,bun,zod}. */
  function globalNpmFixture(opts: { ownBun?: "intact" | "truncated" } = {}): string {
    const globalRoot = join(root, "lib", "node_modules");
    const packageDir = join(globalRoot, ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    // An unrelated global installation that happens to bundle the same dependencies.
    writeDependency(join(globalRoot, "bun"), "bun");
    writeDependency(join(globalRoot, "zod"), "zod");
    if (opts.ownBun) {
      writeDependency(join(packageDir, "node_modules", "bun"), "bun", {
        truncated: opts.ownBun === "truncated",
      });
    }
    return packageDir;
  }

  test("an npm candidate missing its own dependencies is not saved by an ancestor install", () => {
    const packageDir = globalNpmFixture();
    const result = verifyInstallTree(packageDir, "2.0.0");
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("sentinel dependency missing: bun");
    expect(result.failures).toContain("sentinel dependency missing: zod");
  });

  test("an npm candidate with a truncated own Bun is not rescued by an intact ancestor Bun", () => {
    const packageDir = globalNpmFixture({ ownBun: "truncated" });
    const result = verifyInstallTree(packageDir, "2.0.0");
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("bundled Bun binary missing or truncated (< 10MB)");
    // zod still has no copy inside the candidate, and the ancestor's does not count.
    expect(result.failures).toContain("sentinel dependency missing: zod");
  });

  test("a self-contained npm candidate still verifies", () => {
    const packageDir = globalNpmFixture({ ownBun: "intact" });
    writeDependency(join(packageDir, "node_modules", "zod"), "zod");
    expect(verifyInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("a half-extracted Bun directory is size-gated even when Bun is not a sentinel", () => {
    // Sentinels are the bun/zod subset when it is non-empty, so a manifest that declares
    // zod but not bun leaves bun out of the sentinel loop entirely. The size gate has to
    // key on the directory, as it did before the pnpm carry, or a truncated binary with no
    // package.json rides through and the tree is called healthy.
    const packageDir = join(root, "lib", "node_modules", ...PKG.split("/"));
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: PKG, version: "2.0.0", dependencies: { zod: "1" },
    }));
    writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
    writeDependency(join(packageDir, "node_modules", "zod"), "zod");
    // Interrupted extraction: the binary landed, the manifest did not.
    mkdirSync(join(packageDir, "node_modules", "bun"), { recursive: true });
    writeFileSync(join(packageDir, "node_modules", "bun", "bun.exe"), Buffer.alloc(1024));

    const result = verifyInstallTree(packageDir, "2.0.0");

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("bundled Bun binary missing or truncated (< 10MB)");
  });

  test("boot restore keeps the backup when the live tree only resolves through an ancestor", () => {
    // Live tree in a global npm layout, its dependencies supplied only by the sibling install.
    const globalRoot = join(root, "lib", "node_modules");
    const scopeDir = join(globalRoot, "@bitkyc08");
    const packageDir = join(scopeDir, "opencodex");
    writePackage(packageDir, "2.0.0");
    writeDependency(join(globalRoot, "bun"), "bun");
    writeDependency(join(globalRoot, "zod"), "zod");
    // A known-good backup from the previous swap, sitting where bootRestoreProbe looks.
    const backup = join(scopeDir, ".ocx-backup-2026-01-01T00-00-00-000Z", "opencodex");
    writePackage(backup, "1.0.0");
    writeDependency(join(backup, "node_modules", "bun"), "bun");
    writeDependency(join(backup, "node_modules", "zod"), "zod");

    const probe = bootRestoreProbe(packageDir);

    expect(probe.action).toBe("restored");
    expect(existsSync(join(packageDir, "node_modules", "bun", "package.json"))).toBe(true);
  });

  test("boot restore still reaps the backup for a genuinely self-contained live tree", () => {
    const scopeDir = join(root, "lib", "node_modules", "@bitkyc08");
    const packageDir = join(scopeDir, "opencodex");
    writePackage(packageDir, "2.0.0");
    writeDependency(join(packageDir, "node_modules", "bun"), "bun");
    writeDependency(join(packageDir, "node_modules", "zod"), "zod");
    const backupRoot = join(scopeDir, ".ocx-backup-2026-01-01T00-00-00-000Z");
    writePackage(join(backupRoot, "opencodex"), "1.0.0");

    const probe = bootRestoreProbe(packageDir);

    expect(probe.action).toBe("reaped");
    expect(existsSync(backupRoot)).toBe(false);
  });

  test("the pnpm verifier refuses an ancestor root that carries no pnpm bookkeeping", () => {
    // Same shape as the npm escape: a bare ancestor node_modules is somebody else's install.
    const packageDir = globalNpmFixture();
    const result = verifyPnpmInstallTree(packageDir, "2.0.0");
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("sentinel dependency missing: bun");
  });

  test("the pnpm verifier accepts a hoisted group that pnpm's own metadata claims", () => {
    const groupRoot = join(root, "global", "v11", "node_modules");
    const packageDir = join(groupRoot, ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    writeDependency(join(groupRoot, "bun"), "bun");
    writeDependency(join(groupRoot, "zod"), "zod");
    writeFileSync(join(groupRoot, ".modules.yaml"), "nodeLinker: hoisted\n");
    expect(verifyPnpmInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("the pnpm verifier accepts a virtual-store link reached through the package's own tree", () => {
    const store = join(root, "store", "v11", "node_modules", ".pnpm", "registry", "node_modules");
    const packageDir = join(root, "global", "v11", "node_modules", ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    writeDependency(join(store, "bun"), "bun");
    writeDependency(join(store, "zod"), "zod");
    // pnpm's isolated linker links each declared dependency into the package's node_modules.
    symlinkSync(join(store, "bun"), join(packageDir, "node_modules", "bun"), "dir");
    symlinkSync(join(store, "zod"), join(packageDir, "node_modules", "zod"), "dir");
    expect(verifyPnpmInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("the npm verifier accepts the same virtual-store link, because the candidate owns it", () => {
    // The link lives inside the candidate's own node_modules, which is the npm contract too.
    const store = join(root, "store", "node_modules");
    const packageDir = join(root, "global", "node_modules", ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    writeDependency(join(store, "bun"), "bun");
    writeDependency(join(store, "zod"), "zod");
    symlinkSync(join(store, "bun"), join(packageDir, "node_modules", "bun"), "dir");
    symlinkSync(join(store, "zod"), join(packageDir, "node_modules", "zod"), "dir");
    expect(verifyInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("a package root that is itself a pnpm symlink resolves through its realpath", () => {
    const target = join(root, "store", "v11", "node_modules", ".pnpm", "pkg", "node_modules", ...PKG.split("/"));
    writePackage(target, "2.0.0");
    writeDependency(join(target, "node_modules", "bun"), "bun");
    writeDependency(join(target, "node_modules", "zod"), "zod");
    const exposed = join(root, "global", "v11", "node_modules", ...PKG.split("/"));
    mkdirSync(join(root, "global", "v11", "node_modules", "@bitkyc08"), { recursive: true });
    symlinkSync(target, exposed, "dir");
    expect(verifyPnpmInstallTree(exposed, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("the pnpm verifier accepts the default isolated store, where deps are siblings", () => {
    // pnpm's isolated linker puts each dependency of X beside X inside
    // .pnpm/<X>@<ver>/node_modules, not inside X/node_modules, and the physical
    // dependency lives in its own .pnpm/<dep>@<ver> entry. The dependency is therefore
    // neither in the package's own tree nor a child of the group root, which is why
    // ownership has to be probed through the link farm rather than the resolved realpath.
    const virtualStore = join(root, "global", "v11", "node_modules", ".pnpm");
    const instance = join(virtualStore, "@bitkyc08+opencodex@2.0.0", "node_modules");
    const packageDir = join(instance, ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    writeDependency(join(virtualStore, "bun@1.0.0", "node_modules", "bun"), "bun");
    writeDependency(join(virtualStore, "zod@1.0.0", "node_modules", "zod"), "zod");
    symlinkSync(join(virtualStore, "bun@1.0.0", "node_modules", "bun"), join(instance, "bun"), "dir");
    symlinkSync(join(virtualStore, "zod@1.0.0", "node_modules", "zod"), join(instance, "zod"), "dir");
    expect(verifyPnpmInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("accepts an isolated pnpm group whose dependency links stay within that group", () => {
    const store = join(root, "selected", "v11"), globalRoot = join(root, "global", "v11");
    const virtualStore = join(globalRoot, "node_modules", ".pnpm");
    const group = join(virtualStore, "pkg", "node_modules"), pkg = join(group, ...PKG.split("/"));
    mkdirSync(store, { recursive: true }); writePackage(pkg, "2.0.0");
    for (const name of ["bun", "zod"]) {
      const dependency = join(virtualStore, name, "node_modules", name); writeDependency(dependency, name);
      symlinkSync(dependency, join(group, name), "dir");
    }
    expect(verifyPnpmInstallTree(pkg, "2.0.0", store, globalRoot)).toEqual({ ok: true, failures: [] });
  });

  test("an isolated pnpm install below an unrelated versioned links directory remains valid", () => {
    const instance = join(root, "releases", "v2", "links", "global", "node_modules", ".pnpm", "pkg", "node_modules");
    const packageDir = join(instance, ...PKG.split("/"));
    const store = join(root, "configured-store", "v11");
    mkdirSync(store, { recursive: true });
    writePackage(packageDir, "2.0.0");
    writeDependency(join(instance, "bun"), "bun");
    writeDependency(join(instance, "zod"), "zod");
    expect(verifyPnpmInstallTree(packageDir, "2.0.0", store)).toEqual({ ok: true, failures: [] });
    const exposed = join(root, "releases", "v2", "links", "global", "node_modules", ...PKG.split("/"));
    mkdirSync(join(exposed, ".."), { recursive: true });
    symlinkSync(packageDir, exposed, "dir");
    expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
    // The same isolated install reached through a link to its group classifies the same way as the direct path.
    const alias = join(root, "group-alias");
    symlinkSync(join(root, "releases", "v2", "links", "global"), alias, "dir");
    const viaAlias = join(alias, "node_modules", ".pnpm", "pkg", "node_modules", ...PKG.split("/"));
    expect(verifyPnpmInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
    expect(verifyPnpmInstallTree(viaAlias, "2.0.0")).toEqual({ ok: true, failures: [] });
    // An isolated install below a directory spelled like the default store/v<N>/links stays unclassified too.
    const storeSpelled = join(root, "store", "v2", "links", "global", "node_modules", ".pnpm", "pkg", "node_modules");
    const storeSpelledPackage = join(storeSpelled, ...PKG.split("/"));
    writePackage(storeSpelledPackage, "2.0.0");
    writeDependency(join(storeSpelled, "bun"), "bun");
    writeDependency(join(storeSpelled, "zod"), "zod");
    expect(verifyPnpmInstallTree(storeSpelledPackage, "2.0.0")).toEqual({ ok: true, failures: [] });
  });

  test("a sibling entry in the same virtual store cannot vouch for an unrelated group", () => {
    // The instance directory is per package@version, so a dependency parked in a DIFFERENT
    // instance's link farm is not reachable from this one and must not satisfy it.
    const virtualStore = join(root, "global", "v11", "node_modules", ".pnpm");
    const instance = join(virtualStore, "@bitkyc08+opencodex@2.0.0", "node_modules");
    const packageDir = join(instance, ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    const otherInstance = join(virtualStore, "something-else@1.0.0", "node_modules");
    writeDependency(join(otherInstance, "bun"), "bun");
    writeDependency(join(otherInstance, "zod"), "zod");
    const result = verifyPnpmInstallTree(packageDir, "2.0.0");
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("sentinel dependency missing: bun");
  });

  /**
   * #8183: pnpm 11's global virtual store. The exposed package is a symlink into
   * <store>/v11/links/<pkg>/<version>/<hash>/node_modules/<pkg>, whose dependencies are
   * linked beside it in that group. The group carries no `.pnpm` or `.modules.yaml`.
   */
  function globalStoreLinksFixture(opts: { depsInOwnGroup: boolean }): string {
    const links = join(root, "pnpm", "store", "v11", "links");
    const group = join(links, ...PKG.split("/"), "2.0.0", "h1", "node_modules");
    const target = join(group, ...PKG.split("/"));
    writePackage(target, "2.0.0");
    for (const name of ["bun", "zod"]) {
      const physical = join(links, name, "1.0.0", "h2", "node_modules", name);
      writeDependency(physical, name);
      if (opts.depsInOwnGroup) symlinkSync(physical, join(group, name), "dir");
    }
    const exposedGroup = join(root, "pnpm", "global", "v11", "g1", "node_modules");
    mkdirSync(join(exposedGroup, "@bitkyc08"), { recursive: true });
    const exposed = join(exposedGroup, ...PKG.split("/"));
    symlinkSync(target, exposed, "dir");
    return exposed;
  }

  test("the pnpm verifier accepts a global virtual-store links group reached through the realpath", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    expect(verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
    const globalRoot = join(root, "pnpm", "global", "v11", "g1"), store = join(root, "pnpm", "store", "v11");
    const result = resolveOwnerWithStoreProof({ packageName: PKG, packagePath: exposed, commandPaths: [join(root, "pnpm-executable")],
      runPnpm: (_command, args) => {
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: exposed } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: store };
        if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2])) return { status: 0, stdout: "undefined" };
        if (args[2] === "global-dir") return { status: 0, stdout: join(root, "pnpm", "global", "v11") };
        if (args[2] === "global-bin-dir") return { status: 0, stdout: join(root, "bin") };
        return { status: 1 };
      },
    });
    expect(result).toMatchObject({ ok: true, owner: { store: realpathSync(store), globalStore: true } });
  });

  test("refuses a registered lookalike links group outside the selected pnpm store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const globalRoot = join(root, "pnpm", "global", "v11", "g1");
    const globalDir = join(root, "pnpm", "global", "v11");
    const bin = join(root, "pnpm", "bin");
    const store = join(root, "actual-custom-store", "v11");
    mkdirSync(store, { recursive: true });
    const result = resolveOwnerWithStoreProof({ packageName: PKG, packagePath: exposed,
      commandPaths: [join(root, "pnpm-executable")],
      runPnpm: (_command, args) => {
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: exposed } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: store };
        if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2])) return { status: 0, stdout: "undefined" };
        if (args[2] === "global-dir") return { status: 0, stdout: globalDir };
        if (args[2] === "global-bin-dir") return { status: 0, stdout: bin };
        return { status: 1 };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("outside the selected store");
  });

  test("refuses a directly listed foreign custom-store package registered as the running package", () => {
    const store = join(root, "selected", "v11"), globalRoot = join(root, "global", "v11");
    const foreign = join(root, "custom", "v11", "links", ...PKG.split("/"), "2.0.0", "hash", "node_modules", ...PKG.split("/"));
    const exposed = join(globalRoot, "node_modules", ...PKG.split("/"));
    mkdirSync(store, { recursive: true }); writePackage(foreign, "2.0.0");
    for (const name of ["bun", "zod"]) {
      const outside = join(root, "outside", name); writeDependency(outside, name);
      symlinkSync(outside, join(foreign, "node_modules", name), "dir");
    }
    mkdirSync(join(exposed, ".."), { recursive: true }); symlinkSync(foreign, exposed, "dir");
    const result = resolveOwnerWithStoreProof({ packageName: PKG, packagePath: exposed, commandPaths: [join(root, "pnpm-executable")],
      runPnpm: (_command, args) => {
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: foreign } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: store };
        if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2])) return { status: 0, stdout: "undefined" };
        if (args[2] === "global-dir") return { status: 0, stdout: join(root, "global") };
        if (args[2] === "global-bin-dir") return { status: 0, stdout: join(root, "bin") };
        return { status: 1 };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("outside the selected store");
  });

  test("a pinned global-store owner refuses readback of a package moved outside its store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = realpathSync(join(root, "pnpm", "store", "v11"));
    const globalRoot = join(root, "pnpm", "global", "v11", "g1"), outside = join(root, "plain", "node_modules", ...PKG.split("/"));
    writePackage(outside, "2.0.0");
    const owner = { commandPath: join(root, "pnpm-executable"), packagePath: exposed, globalDir: join(root, "pnpm", "global", "v11"),
      globalRoot, globalBinDir: join(root, "bin"), store, globalStore: true, homeAnchor: STORE_PROOF_HOME };
    const result = readPnpmGlobalPackage(PKG, args => {
      if (args[0] === "--version") return { status: 0, stdout: "12.16.1" };
      if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: outside } } }]) };
      if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: store };
        if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2])) return { status: 0, stdout: "undefined" };
      return { status: 1 };
    }, () => ({ ok: true }), { owner, checkShims: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("outside the selected store");
  });

  test("refuses a registered lookalike hidden in an intermediate package symlink", () => {
    const store = join(root, "actual-store", "v11"), globalRoot = join(root, "global", "v11");
    const exposed = join(globalRoot, "node_modules", ...PKG.split("/"));
    const intermediate = join(root, "lookalike", "store", "v2", "links", "pkg", "node_modules", ...PKG.split("/"));
    const target = join(root, "plain", "node_modules", ...PKG.split("/"));
    mkdirSync(store, { recursive: true });
    writePackage(target, "2.0.0");
    writeDependency(join(target, "node_modules", "bun"), "bun");
    writeDependency(join(target, "node_modules", "zod"), "zod");
    mkdirSync(join(intermediate, ".."), { recursive: true });
    mkdirSync(join(exposed, ".."), { recursive: true });
    symlinkSync(target, intermediate, "dir");
    symlinkSync(intermediate, exposed, "dir");
    for (const listed of [exposed, target]) {
      const result = resolveOwnerWithStoreProof({ packageName: PKG, packagePath: exposed,
        commandPaths: [join(root, "pnpm-executable")],
        runPnpm: (_command, args) => {
          if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: listed } } }]) };
          if (args[0] === "root") return { status: 0, stdout: globalRoot };
          if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: store };
        if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2])) return { status: 0, stdout: "undefined" };
          if (args[2] === "global-dir") return { status: 0, stdout: join(root, "global") };
          if (args[2] === "global-bin-dir") return { status: 0, stdout: join(root, "bin") };
          return { status: 1 };
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("outside the selected store");
    }
  });

  test("refuses a package escaping through the selected custom store without marker files", () => {
    const store = join(root, "custom", "v11"), intermediate = join(store, "links", "pkg", "node_modules", ...PKG.split("/"));
    const exposed = join(root, "global", "node_modules", ...PKG.split("/"));
    const target = join(root, "plain", "node_modules", ...PKG.split("/"));
    writePackage(target, "2.0.0");
    writeDependency(join(target, "node_modules", "bun"), "bun");
    writeDependency(join(target, "node_modules", "zod"), "zod");
    mkdirSync(join(intermediate, ".."), { recursive: true });
    mkdirSync(join(exposed, ".."), { recursive: true });
    symlinkSync(target, intermediate, "dir");
    symlinkSync(intermediate, exposed, "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm global links are outside the selected store");
  });

  test("refuses a package reached through an unmarked foreign custom links path", () => {
    const store = join(root, "selected", "v11"), foreign = join(root, "foreign", "v11", "links", "pkg", "node_modules", ...PKG.split("/"));
    const exposed = join(root, "global", "node_modules", ...PKG.split("/")), target = join(root, "plain", "node_modules", ...PKG.split("/"));
    mkdirSync(store, { recursive: true });
    writePackage(target, "2.0.0");
    writeDependency(join(target, "node_modules", "bun"), "bun");
    writeDependency(join(target, "node_modules", "zod"), "zod");
    mkdirSync(join(foreign, ".."), { recursive: true }); mkdirSync(join(exposed, ".."), { recursive: true });
    symlinkSync(target, foreign, "dir"); symlinkSync(foreign, exposed, "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm global links are outside the selected store");
  });

  test("refuses a non-sentinel dependency link outside the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const target = realpathSync(exposed), group = join(target, "..", "..");
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: PKG, version: "2.0.0", dependencies: { bun: "1", zod: "1", other: "1" } }));
    const outside = join(root, "outside", "other"); writeDependency(outside, "other");
    symlinkSync(outside, join(group, "other"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: other");
  });

  test("refuses a dependency link that leaves the selected store and returns through an outside bridge", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11"), group = join(realpathSync(exposed), "..", "..");
    const original = join(group, "zod"), target = realpathSync(original), bridge = join(root, "bridge");
    rmSync(original); symlinkSync(target, bridge, "dir"); symlinkSync(bridge, original, "dir");
    expect(realpathSync(original)).toBe(target);
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed));
    expect(result.ok).toBe(false);
  });

  test("refuses a package link that leaves the selected store and returns through an outside bridge", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11"), target = realpathSync(exposed);
    const bridge = join(root, "package-bridge"), link = join(store, "links", "package-alias");
    symlinkSync(target, bridge, "dir"); symlinkSync(bridge, link, "dir");
    rmSync(exposed); symlinkSync(link, exposed, "dir");
    expect(realpathSync(exposed)).toBe(target);
    expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed)).ok).toBe(false);
  });

  test.each(["package entry", "binary"])("refuses a %s link that returns through an outside bridge", kind => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11"), target = realpathSync(exposed);
    const file = join(target, "bin", "inside.js"), bridge = join(root, "bridge-file");
    writeFileSync(file, "module.exports = 1;\n"); symlinkSync(file, bridge);
    const dir = kind === "binary" ? join(target, "node_modules", ".bin") : join(target, "bin");
    mkdirSync(dir, { recursive: true }); symlinkSync(bridge, join(dir, "tool"));
    expect(realpathSync(join(dir, "tool"))).toBe(realpathSync(file));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed));
    expect(result.ok).toBe(false);
  });

  test("refuses a lexical store spelling that is a symbolic link, even when links use it", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = realpathSync(join(root, "pnpm", "store", "v11")), alias = join(root, "store-alias");
    symlinkSync(store, alias, "dir");
    const link = join(realpathSync(exposed), "..", "..", "zod"), target = realpathSync(link);
    rmSync(link); symlinkSync(join(alias, relative(store, target)), link, "dir");
    const bun = join(realpathSync(exposed), "..", "..", "bun"), bunTarget = realpathSync(bun);
    rmSync(bun); symlinkSync(bunTarget, bun, "dir");
    // A linked spelling would let its target, and any relay beneath it, count as inside the store.
    expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed), alias))
      .toEqual({ ok: false, failures: ["pnpm store or global group path is not canonical"] });
  });

  test("refuses a dangling package-local dependency link despite a valid group link", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    symlinkSync(join(root, "missing-zod"), join(realpathSync(exposed), "node_modules", "zod"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link could not be resolved: zod");
  });

  test("refuses a dangling scoped dependency directory link", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const target = realpathSync(exposed);
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: PKG, version: "2.0.0", dependencies: { bun: "1", zod: "1", "@scope/other": "1" } }));
    symlinkSync(join(root, "missing-scope"), join(target, "node_modules", "@scope"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link could not be resolved: @scope/other");
  });

  test("refuses a transitive dependency link that escapes the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", dependencies: { foreign: "1" } }));
    mkdirSync(join(zod, "node_modules"));
    const outside = join(root, "outside", "foreign"); writeDependency(outside, "foreign");
    symlinkSync(outside, join(zod, "node_modules", "foreign"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: foreign");
  });

  test("refuses an undeclared but reachable transitive dependency link outside the store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    mkdirSync(join(zod, "node_modules"));
    const outside = join(root, "outside", "foreign"); writeDependency(outside, "foreign");
    symlinkSync(outside, join(zod, "node_modules", "foreign"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: foreign");
  });

  test("refuses an escaping dependency link under a nested package directory", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const nested = join(zod, "lib", "node_modules"); mkdirSync(nested, { recursive: true });
    const outside = join(root, "outside", "foreign"); writeDependency(outside, "foreign");
    writeFileSync(join(outside, "index.js"), "module.exports = 1;\n");
    symlinkSync(outside, join(nested, "foreign"), "dir");
    expect(realpathSync(createRequire(join(zod, "lib", "entry.js")).resolve("foreign"))).toBe(realpathSync(join(outside, "index.js")));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: foreign");
  });

  test("refuses a dependency entry point linked outside the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const outside = join(root, "outside-entry.js"); writeFileSync(outside, "module.exports = 1;\n");
    symlinkSync(outside, join(zod, "index.js"));
    const resolved = createRequire(join(realpathSync(exposed), "entry.js")).resolve("zod");
    expect(realpathSync(resolved)).toBe(realpathSync(outside));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm package link escapes the selected store");
  });

  test("accepts a nested dependency link inside the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11");
    const zod = join(store, "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const nested = join(zod, "lib", "node_modules"); mkdirSync(nested, { recursive: true });
    const inside = join(store, "links", "nested", "1", "h3", "node_modules", "nested"); writeDependency(inside, "nested");
    symlinkSync(inside, join(nested, "nested"), "dir");
    expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
  });

  test("refuses a dangling nested dependency root", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    mkdirSync(join(zod, "lib")); symlinkSync(join(root, "missing"), join(zod, "lib", "node_modules"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency root could not be resolved");
  });

  test("refuses a hidden dependency link outside the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    mkdirSync(join(zod, "node_modules"));
    const outside = join(root, "outside", "hidden"); writeDependency(outside, "hidden");
    writeFileSync(join(outside, "index.js"), "module.exports = 1;\n");
    symlinkSync(outside, join(zod, "node_modules", ".hidden"), "dir");
    expect(realpathSync(createRequire(join(zod, "entry.js")).resolve(".hidden"))).toBe(realpathSync(join(outside, "index.js")));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: .hidden");
  });

  test("refuses a pnpm binary link that escapes the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const target = realpathSync(exposed), bin = join(target, "node_modules", ".bin");
    mkdirSync(bin); const outside = join(root, "outside-executable"); writeFileSync(outside, "binary");
    symlinkSync(outside, join(bin, "tool"));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm binary link escapes the selected store: tool");
  });

  test.each(["dangling", "outside"])("refuses an existing %s package dependency root", kind => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const target = realpathSync(exposed), ownRoot = join(target, "node_modules");
    rmSync(ownRoot, { recursive: true });
    const outside = join(root, "outside-root");
    if (kind === "outside") mkdirSync(outside);
    symlinkSync(outside, ownRoot, "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures.some(message => message.includes("pnpm dependency root"))).toBe(true);
  });

  test("global-store dependency graph handles cycles and absent optional dependencies", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const target = realpathSync(exposed), zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", dependencies: { [PKG]: "1" }, optionalDependencies: { absent: "1" } }));
    mkdirSync(join(zod, "node_modules", "@bitkyc08"), { recursive: true });
    symlinkSync(target, join(zod, "node_modules", ...PKG.split("/")), "dir");
    expect(verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
  });

  test("verifies a shared global-store group without repeatedly walking every sibling", () => {
    const store = join(root, "pnpm", "store", "v11"), group = join(store, "links", "large", "node_modules");
    const pkg = join(group, ...PKG.split("/")); writePackage(pkg, "2.0.0");
    writeDependency(join(group, "bun"), "bun"); writeDependency(join(group, "zod"), "zod");
    for (let index = 0; index < 300; index += 1) writeDependency(join(group, `dep${index}`), `dep${index}`);
    const started = performance.now();
    expect(verifyPnpmInstallTree(pkg, "2.0.0", store)).toEqual({ ok: true, failures: [] });
    expect(performance.now() - started).toBeLessThan(10_000);
    const last = join(group, "dep299", "node_modules"), outside = join(root, "outside", "foreign");
    mkdirSync(last); writeDependency(outside, "foreign"); symlinkSync(outside, join(last, "foreign"), "dir");
    expect(verifyPnpmInstallTree(pkg, "2.0.0", store).ok).toBe(false);
  }, 20_000);

  test("checks an unshadowed shared-group dependency even if the first importer shadows it", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11"), pkg = realpathSync(exposed), group = join(pkg, "..", "..");
    const shadow = join(pkg, "node_modules", "evil"), dep = join(group, "dep"), evil = join(group, "evil");
    const outside = join(root, "outside.js");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PKG, version: "2.0.0", dependencies: { bun: "1", zod: "1", dep: "1" } }));
    writeDependency(shadow, "evil"); writeDependency(dep, "dep"); writeDependency(evil, "evil");
    writeFileSync(outside, "module.exports = 1;\n");
    writeFileSync(join(evil, "package.json"), JSON.stringify({ name: "evil", main: relative(evil, outside) }));
    expect(realpathSync(createRequire(join(dep, "entry.js")).resolve("evil"))).toBe(realpathSync(outside));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm package entry point is outside the selected store");
  });

  test("accepts repeated in-store aliases of the same dependency group", () => {
    const store = join(root, "pnpm", "store", "v11"), group = join(store, "links", "app", "node_modules");
    const pkg = join(group, ...PKG.split("/")); writePackage(pkg, "2.0.0");
    writeDependency(join(group, "bun"), "bun"); writeDependency(join(group, "zod"), "zod");
    for (let index = 0; index < 30; index += 1) {
      const dep = join(group, `dep${index}`); writeDependency(dep, `dep${index}`);
      symlinkSync(group, join(dep, "node_modules"), "dir");
    }
    expect(realpathSync(createRequire(join(group, "dep0", "entry.js")).resolve("dep1/package.json")))
      .toBe(realpathSync(join(group, "dep1", "package.json")));
    expect(verifyPnpmInstallTree(pkg, "2.0.0", store)).toEqual({ ok: true, failures: [] });
  });

  test("refuses a required transitive dependency resolved through an outside ancestor", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", dependencies: { foreign: "1" } }));
    const outside = join(root, "node_modules", "foreign"); writeDependency(outside, "foreign");
    writeFileSync(join(outside, "index.js"), "module.exports = 1;\n");
    expect(realpathSync(createRequire(join(zod, "entry.js")).resolve("foreign"))).toBe(realpathSync(join(outside, "index.js")));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm required dependency is missing from the selected store: foreign");
  });

  test("an outside ancestor node_modules that supplies only undeclared names does not refuse a store-proven tree", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const outside = join(root, "outside", "foreign"); writeDependency(outside, "foreign");
    writeFileSync(join(outside, "index.js"), "module.exports = 1;\n");
    mkdirSync(join(root, "node_modules")); symlinkSync(outside, join(root, "node_modules", "foreign"), "dir");
    expect(realpathSync(createRequire(join(zod, "entry.js")).resolve("foreign"))).toBe(realpathSync(join(outside, "index.js")));
    // Above the store the ancestor walk stops: a user's own node_modules is not part of the package.
    expect(verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
  });

  test("refuses an escaping dependency link in an ancestor root inside the store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11");
    const zod = join(store, "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const outside = join(root, "outside", "foreign"), ancestor = join(store, "links", "node_modules");
    writeDependency(outside, "foreign"); writeFileSync(join(outside, "index.js"), "module.exports = 1;\n");
    mkdirSync(ancestor); symlinkSync(outside, join(ancestor, "foreign"), "dir");
    expect(realpathSync(createRequire(join(zod, "entry.js")).resolve("foreign"))).toBe(realpathSync(join(outside, "index.js")));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed));
    expect(result.ok).toBe(false);
  });

  test("refuses a package main entry outside the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const outside = join(root, "outside-entry.js"); writeFileSync(outside, "module.exports = 1;\n");
    const zodLink = join(realpathSync(exposed), "..", "..", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", main: relative(zodLink, outside) }));
    const node = Bun.which("node"); if (!node) throw new Error("Node is required for this resolution fixture");
    const probe = spawnSync(node, ["-e", "process.stdout.write(require('node:module').createRequire(process.argv[1]).resolve('zod'))", join(realpathSync(exposed), "entry.js")], { encoding: "utf8" });
    expect({ status: probe.status, stderr: probe.stderr }).toMatchObject({ status: 0 });
    expect(realpathSync(probe.stdout)).toBe(realpathSync(outside));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm package entry point is outside the selected store");
  });

  test("refuses a nested package main entry outside the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11");
    const zod = join(store, "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const nested = join(zod, "lib"), outside = join(root, "outside-entry.js");
    mkdirSync(nested); writeFileSync(outside, "module.exports = 1;\n");
    const nestedLink = join(realpathSync(exposed), "..", "..", "zod", "lib");
    writeFileSync(join(nested, "package.json"), JSON.stringify({ main: relative(nestedLink, outside) }));
    const node = Bun.which("node"); if (!node) throw new Error("Node is required for this resolution fixture");
    const probe = spawnSync(node, ["-e", "process.stdout.write(require('node:module').createRequire(process.argv[1]).resolve('zod/lib'))", join(realpathSync(exposed), "entry.js")], { encoding: "utf8" });
    expect({ status: probe.status, stderr: probe.stderr }).toMatchObject({ status: 0 });
    expect(realpathSync(probe.stdout)).toBe(realpathSync(outside));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm package entry point is outside the selected store");
  });

  test("accepts an in-store nested package main entry", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11");
    const nested = join(store, "links", "zod", "1.0.0", "h2", "node_modules", "zod", "lib");
    mkdirSync(nested); writeFileSync(join(nested, "index.js"), "module.exports = 1;\n");
    writeFileSync(join(nested, "package.json"), JSON.stringify({ main: "./index.js" }));
    expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
  });

  test("accepts in-store package main, exports and binary paths", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = join(root, "pnpm", "store", "v11");
    const zod = join(store, "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "index.js"), "module.exports = 1;\n");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", main: "./index.js", exports: { ".": "./index.js" }, bin: { zod: "./index.js" } }));
    expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
  });

  test("an outside NODE_PATH that supplies only undeclared names does not refuse a store-proven tree", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    const fallback = join(root, "fallback"), foreign = join(fallback, "foreign"); writeDependency(foreign, "foreign");
    writeFileSync(join(foreign, "index.js"), "module.exports = 1;\n");
    const node = Bun.which("node"); if (!node) throw new Error("Node is required for this resolution fixture");
    const probe = spawnSync(node, ["-e", "process.stdout.write(require('node:module').createRequire(process.argv[1]).resolve('foreign'))", join(zod, "entry.js")],
      { encoding: "utf8", env: { ...process.env, NODE_PATH: fallback } });
    expect({ status: probe.status, stderr: probe.stderr }).toMatchObject({ status: 0 });
    expect(realpathSync(probe.stdout)).toBe(realpathSync(join(foreign, "index.js")));
    const original = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = fallback;
      expect(verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
    } finally {
      if (original === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = original;
    }
  });

  test("accepts an in-store NODE_PATH whose links stay inside the store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const store = realpathSync(join(root, "pnpm", "store", "v11")), lookup = join(root, "pnpm", "store", "v11", "lookup");
    mkdirSync(lookup); const original = process.env.NODE_PATH;
    try {
      process.env.NODE_PATH = lookup;
      expect(verifyPnpmInstallTree(exposed, "2.0.0", store, exposingGroup(exposed), join(root, "pnpm", "store", "v11"))).toEqual({ ok: true, failures: [] });
    } finally {
      if (original === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = original;
    }
  });

  test("refuses a manifestless dependency with an escaping nested link", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", dependencies: { phantom: "1" } }));
    const phantom = join(root, "pnpm", "store", "v11", "links", "phantom", "1", "h3", "node_modules", "phantom");
    mkdirSync(join(phantom, "node_modules"), { recursive: true });
    writeFileSync(join(phantom, "index.js"), "module.exports = 1;\n");
    const outside = join(root, "outside", "foreign"); writeDependency(outside, "foreign");
    symlinkSync(outside, join(phantom, "node_modules", "foreign"), "dir");
    mkdirSync(join(zod, "node_modules")); symlinkSync(phantom, join(zod, "node_modules", "phantom"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency manifest could not be read: phantom");
  });

  test("refuses an optional dependency when Node can resolve it from an outside ancestor", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", optionalDependencies: { foreign: "1" } }));
    const outside = join(root, "node_modules", "foreign"); writeDependency(outside, "foreign");
    writeFileSync(join(outside, "index.js"), "module.exports = 1;\n");
    expect(realpathSync(createRequire(join(zod, "entry.js")).resolve("foreign"))).toBe(realpathSync(join(outside, "index.js")));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency can resolve outside the selected store: foreign");
  });

  test("accepts absent peers, including non-optional peers pnpm may leave uninstalled", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    // Models auto-install-peers=false and strict-peer-dependencies=false; no pnpm runs.
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", peerDependencies: { required: "1", optional: "1" }, peerDependenciesMeta: { optional: { optional: true } } }));
    expect(verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed))).toEqual({ ok: true, failures: [] });
  });

  test("refuses an existing peer link that escapes the selected store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", peerDependencies: { peer: "1" } }));
    const outside = join(root, "outside", "peer"); writeDependency(outside, "peer");
    mkdirSync(join(zod, "node_modules")); symlinkSync(outside, join(zod, "node_modules", "peer"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: peer");
  });

  test("still requires a direct dependency also declared as a peer", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const zod = join(root, "pnpm", "store", "v11", "links", "zod", "1.0.0", "h2", "node_modules", "zod");
    writeFileSync(join(zod, "package.json"), JSON.stringify({ name: "zod", dependencies: { missing: "1" }, peerDependencies: { missing: "1" } }));
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm required dependency is missing from the selected store: missing");
  });

  test("global-store dependency links cannot escape the canonical configured store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const group = join(root, "pnpm", "store", "v11", "links", ...PKG.split("/"), "2.0.0", "h1", "node_modules");
    const outside = join(root, "outside", "zod");
    writeDependency(outside, "zod");
    rmSync(join(group, "zod"));
    symlinkSync(outside, join(group, "zod"), "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("sentinel dependency missing: zod");
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: zod");
  });

  test("a global-store package cannot borrow dependencies from its exposed lexical group", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: false });
    const exposedGroup = join(root, "pnpm", "global", "v11", "g1", "node_modules");
    const links = join(root, "pnpm", "store", "v11", "links");
    writeFileSync(join(exposedGroup, ".modules.yaml"), "nodeLinker: hoisted\n");
    for (const name of ["bun", "zod"]) {
      symlinkSync(join(links, name, "1.0.0", "h2", "node_modules", name), join(exposedGroup, name), "dir");
    }
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("sentinel dependency missing: zod");
    expect(result.failures).toContain("pnpm dependency root is outside the selected store: zod");
  });

  test("accepts links in a custom store and refuses them with no resolved store", () => {
    const group = join(root, "custom-cache", "v11", "links", "instance", "node_modules");
    const packageDir = join(group, ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    writeDependency(join(group, "bun"), "bun");
    writeDependency(join(group, "zod"), "zod");
    expect(verifyPnpmInstallTree(packageDir, "2.0.0", join(root, "custom-cache", "v11")).ok).toBe(true);
    expect(verifyPnpmInstallTree(packageDir, "2.0.0").ok).toBe(false);
  });

  test("accepts an alternate virtual-store directory inside the configured store", () => {
    const store = join(root, "custom-store", "v11"), group = join(store, "custom-links", "pkg", "node_modules");
    const packageDir = join(group, ...PKG.split("/"));
    writePackage(packageDir, "2.0.0");
    // pnpm's own store markers: they route this layout to the store proof (they do not prove it).
    mkdirSync(join(store, "files"), { recursive: true }); mkdirSync(join(store, "index"), { recursive: true });
    writeDependency(join(group, "bun"), "bun"); writeDependency(join(group, "zod"), "zod");
    expect(verifyPnpmInstallTree(packageDir, "2.0.0", store)).toEqual({ ok: true, failures: [] });
    const globalRoot = join(root, "global", "v11"), configured = join(store, "custom-links");
    mkdirSync(globalRoot, { recursive: true });
    const owner = resolveOwnerWithStoreProof({ packageName: PKG, packagePath: packageDir, commandPaths: [join(root, "pnpm")],
      runPnpm: (_command, args) => {
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: packageDir } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "store-dir") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === "virtual-store-dir") return { status: 0, stdout: configured };
        if (args[0] === "config" && args[2] === "global-virtual-store-dir") return { status: 0, stdout: "undefined" };
        if (args[2] === "global-dir") return { status: 0, stdout: join(root, "global") };
        if (args[2] === "global-bin-dir") return { status: 0, stdout: join(root, "bin") };
        return { status: 1 };
      },
    });
    expect(owner).toMatchObject({ ok: true, owner: { globalStore: true, virtualStoreDirs: [realpathSync(configured)] } });
    const outside = join(root, "outside", "zod"); writeDependency(outside, "zod");
    rmSync(join(group, "zod"), { recursive: true }); symlinkSync(outside, join(group, "zod"), "dir");
    const result = verifyPnpmInstallTree(packageDir, "2.0.0", store);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm dependency link escapes the selected store: zod");
  });

  test.each(["virtual-store-dir", "global-virtual-store-dir"])("refuses %s outside the selected store", setting => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const globalRoot = join(root, "pnpm", "global", "v11", "g1"), store = join(root, "pnpm", "store", "v11");
    const outside = join(root, "outside-virtual");
    mkdirSync(outside, { recursive: true });
    const result = resolveOwnerWithStoreProof({ packageName: PKG, packagePath: exposed, commandPaths: [join(root, "pnpm")],
      runPnpm: (_command, args) => {
        if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ path: globalRoot, dependencies: { [PKG]: { version: "2.0.0", path: exposed } } }]) };
        if (args[0] === "root") return { status: 0, stdout: globalRoot };
        if (args[0] === "store") return { status: 0, stdout: store };
        if (args[0] === "config" && args[2] === setting) return { status: 0, stdout: outside };
        if (args[0] === "config" && ["virtual-store-dir", "global-virtual-store-dir"].includes(args[2])) return { status: 0, stdout: "undefined" };
        if (args[2] === "global-dir") return { status: 0, stdout: join(root, "pnpm", "global", "v11") };
        if (args[2] === "global-bin-dir") return { status: 0, stdout: join(root, "bin") };
        return { status: 1 };
      },
    });
    expect(result.ok).toBe(false);
    // The refusal also tells the user why a store-like install needs pnpm's store answer.
    if (!result.ok) expect(result.reason.startsWith("pnpm virtual-store directory is outside the selected store; this install's path looks like a pnpm global store")).toBe(true);
  });

  test("refuses preserved symlink mode when the exposed group can resolve outside the store", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: true });
    const exposedGroup = join(root, "pnpm", "global", "v11", "g1", "node_modules");
    const outside = join(root, "outside", "foreign"); writeDependency(outside, "foreign");
    writeFileSync(join(outside, "index.js"), "module.exports = 1;\n"); symlinkSync(outside, join(exposedGroup, "foreign"), "dir");
    const node = Bun.which("node"); if (!node) throw new Error("Node is required for this resolution fixture");
    const probe = spawnSync(node, ["--preserve-symlinks", "--preserve-symlinks-main", "-e",
      "process.stdout.write(require('node:module').createRequire(process.argv[1]).resolve('foreign'))", join(exposed, "entry.js")], { encoding: "utf8" });
    expect({ status: probe.status, stderr: probe.stderr }).toMatchObject({ status: 0 });
    expect(realpathSync(probe.stdout)).toBe(realpathSync(join(outside, "index.js")));
    const original = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main";
      const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
      expect(result.ok).toBe(false);
      expect(result.failures).toContain("pnpm preserved-symlink lookup root is outside the selected store");
    } finally {
      if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original;
    }
  });

  test("another links group in the same global store cannot vouch for the package", () => {
    const exposed = globalStoreLinksFixture({ depsInOwnGroup: false });
    const result = verifyPnpmInstallTree(exposed, "2.0.0", join(root, "pnpm", "store", "v11"), exposingGroup(exposed));
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("sentinel dependency missing: bun");
    expect(result.failures).toContain("sentinel dependency missing: zod");
  });

  test("a store-links spelling on the exposed path alone does not vouch for the package", () => {
    // Only the realpath group is trusted by layout; the lexical group still needs pnpm metadata.
    const target = join(root, "plain", "node_modules", ...PKG.split("/"));
    writePackage(target, "2.0.0");
    const lexicalGroup = join(root, "pnpm", "store", "v11", "links", "x", "1.0.0", "h1", "node_modules");
    writeDependency(join(lexicalGroup, "bun"), "bun");
    writeDependency(join(lexicalGroup, "zod"), "zod");
    mkdirSync(join(lexicalGroup, "@bitkyc08"), { recursive: true });
    const exposed = join(lexicalGroup, ...PKG.split("/"));
    symlinkSync(target, exposed, "dir");
    const result = verifyPnpmInstallTree(exposed, "2.0.0");
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("pnpm global links are outside the selected store");
  });
});
