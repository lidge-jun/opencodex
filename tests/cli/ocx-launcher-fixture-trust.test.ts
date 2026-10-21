import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPathBun, type PathBunIo } from "../../src/lib/bun-path-runtime.mjs";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { TRUSTED_FIXTURE_DIR_ENV, fixtureBaseCandidates, trustedFixtureRoot, untrustedFixtureAncestor } from "../helpers/trusted-fixture-root";

// #7402: a checkout under group-writable directories (macOS external volumes) made every
// real PATH-Bun fixture fail, because the fixtures sat beside the checkout. These cases
// rebuild that ancestry with chmod 0775 inside a private root and pin both halves of the
// fix: the product check still refuses such a tree, and fixture placement steps around it.
const roots: string[] = [];
afterAll(() => { for (const root of roots) removeTreeWithRetry(root); });

function privateRoot(prefix: string): string {
  const root = trustedFixtureRoot(prefix);
  roots.push(root);
  return root;
}

function plantBun(directory: string): string {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, "bun"), "fixture");
  chmodSync(join(bin, "bun"), 0o755);
  return bin;
}

// Real filesystem trust walk; only the binary identity and version probe are stubbed.
function probe(binDir: string) {
  let spawns = 0;
  const io: PathBunIo = {
    lstat: lstatSync, readlink: readlinkSync, realpath: realpathSync.native, stat: statSync,
    geteuid: () => process.geteuid?.(), access: () => {}, isRealBunBinary: () => true,
    spawnSync: () => { spawns++; return { status: 0, stdout: "1.4.2" }; },
  };
  const selected = findPathBun({ env: { PATH: binDir }, pinnedVersion: "1.4.2", io });
  return { selected, spawns };
}

describe.skipIf(process.platform === "win32")("PATH-Bun fixture trust under a group-writable ancestor", () => {
  test("the product check rejects a Bun whose ancestor is only group-writable", () => {
    const shared = join(privateRoot("ocx-7402-reject-"), "shared");
    mkdirSync(shared, { mode: 0o700 });
    const binDir = plantBun(join(shared, "checkout"));
    chmodSync(shared, 0o775);
    expect(probe(binDir)).toEqual({ selected: null, spawns: 0 });
    // Same tree with only the group bit cleared is accepted, so that bit alone drove the rejection.
    chmodSync(shared, 0o755);
    expect(probe(binDir).selected?.path).toBe(realpathSync.native(join(binDir, "bun")));
  });

  test("fixture placement skips the group-writable candidate and lands where the product check passes", () => {
    const outer = privateRoot("ocx-7402-select-");
    const shared = join(outer, "shared");
    mkdirSync(shared, { mode: 0o700 });
    chmodSync(shared, 0o775);
    const sibling = join(shared, ".tmp", "path-bun-fixtures");
    const trusted = join(outer, "private-base");
    expect(untrustedFixtureAncestor(sibling)).toContain("group/other-writable (mode 775)");
    const root = trustedFixtureRoot("ocx-7402-fixture-", [sibling, trusted]);
    expect(root.startsWith(realpathSync.native(trusted) + "/")).toBe(true);
    expect(existsSync(sibling)).toBe(false);
    const binDir = plantBun(root);
    expect(probe(binDir).selected?.path).toBe(realpathSync.native(join(binDir, "bun")));
  });

  test("a candidate beneath an ancestor node_modules/bun is refused", () => {
    const outer = privateRoot("ocx-7402-provenance-");
    mkdirSync(join(outer, "node_modules", "bun"), { recursive: true, mode: 0o700 });
    const candidate = join(outer, "inner");
    expect(untrustedFixtureAncestor(candidate)).toBe(`${outer} contains node_modules/bun`);
    expect(() => trustedFixtureRoot("ocx-7402-leak-", [candidate])).toThrow(TRUSTED_FIXTURE_DIR_ENV);
    expect(existsSync(candidate)).toBe(false);
  });

  // Root ignores directory permission bits, so the uncreatable candidate only exists for other users.
  test.skipIf(process.geteuid?.() === 0)("a trusted but uncreatable candidate is recorded and the next one is tried", () => {
    const outer = privateRoot("ocx-7402-readonly-");
    const readonly = join(outer, "readonly");
    mkdirSync(readonly, { mode: 0o700 });
    chmodSync(readonly, 0o500);
    try {
      const blocked = join(readonly, "base");
      const fallback = join(outer, "fallback");
      expect(untrustedFixtureAncestor(blocked)).toBeNull();
      expect(trustedFixtureRoot("ocx-7402-next-", [blocked, fallback]).startsWith(realpathSync.native(fallback) + "/")).toBe(true);
      expect(() => trustedFixtureRoot("ocx-7402-none-", [blocked])).toThrow(`${blocked}: cannot create (EACCES)`);
    } finally { chmodSync(readonly, 0o700); }
  });

  test("candidates keep the override first and include the per-user runtime dir", () => {
    const candidates = fixtureBaseCandidates({ [TRUSTED_FIXTURE_DIR_ENV]: "/override", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(candidates[0]).toBe("/override");
    expect(candidates).toContain("/run/user/1000/opencodex-path-bun-fixtures");
    expect(fixtureBaseCandidates({ [TRUSTED_FIXTURE_DIR_ENV]: "relative", XDG_RUNTIME_DIR: "" })).not.toContain("relative");
  });
});
