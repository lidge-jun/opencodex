/**
 * #4202 review (Ingwannu, blocking on PR #4203): the pnpm path may resolve a dependency
 * outside the package directory, but the npm verifier must stay confined to the candidate's
 * own tree. Node's resolver walks the ancestor chain, so a global npm candidate can otherwise
 * satisfy its bundled-Bun requirement from a sibling package's install. Three decisions read
 * that verdict — accepting the stage, rolling back after the swap, and reaping the only
 * backup at boot — so a non-self-contained candidate called healthy costs the known-good copy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootRestoreProbe,
  verifyInstallTree,
  verifyPnpmInstallTree,
} from "../../src/update/transactional-install.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PKG = "@bitkyc08/opencodex";
const BUN_BYTES = 10 * 1024 * 1024 + 1024;

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
    root = mkdtempSync(join(tmpdir(), "ocx-tree-ownership-"));
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
});
