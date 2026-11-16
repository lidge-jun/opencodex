import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_OWNERSHIP_LOCK,
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
  recordOwnedConfigPath,
  removeOwnedConfigState,
  uninstallPrivilegeRefusal,
} from "../../src/lib/config-ownership";
import {
  ELEVATED_UNINSTALL_REFUSAL,
  elevatedRemovalRefusal,
  setOwnedDirectoryListedHookForTests,
  setUninstallElevationProbeForTests,
  UNKNOWN_ELEVATION_UNINSTALL_REFUSAL,
  uninstallRunsElevated,
} from "../../src/lib/config-ownership-removal";
import { setWindowsElevationProbeForTests } from "../../src/lib/windows-elevation";
import { setWindowsOwnerAclRunnerForTests, windowsOwnerAclDefaultRunnerForTests, type WindowsAclEntry } from "../../src/lib/windows-owner-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const posix = process.platform === "win32" ? test.skip : test;
const windows = process.platform === "win32" ? test : test.skip;
const darwin = process.platform === "darwin" ? test : test.skip;
const unprivilegedPosix = process.platform === "win32" || process.geteuid?.() === 0 ? test.skip : test;

function ownedHome(prefix: string): { parent: string; dir: string } {
  // Under the canonical temporary directory: macOS reaches tmpdir() through the /var link.
  const parent = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const dir = join(parent, "config");
  expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
  writeFileSync(join(dir, "config.json"), "owned");
  return { parent, dir };
}

function withPlatform<T>(platform: string, arch: string, run: () => T): T {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  Object.defineProperty(process, "arch", { ...archDescriptor, value: arch });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
}

describe("owned path removal stays inside the config root", () => {
  afterEach(() => {
    setUninstallElevationProbeForTests(null);
    setOwnedDirectoryListedHookForTests(null);
    setWindowsOwnerAclRunnerForTests(null);
    setWindowsElevationProbeForTests(null);
  });

  windows("elevated uninstall refuses a junction before changing owned state", () => {
    const { parent, dir } = ownedHome("ocx-removal-windows-junction-");
    const target = join(parent, "external"), link = join(dir, "artifacts");
    try {
      mkdirSync(target);
      writeFileSync(join(target, "keep.txt"), "keep");
      expect(recordOwnedConfigPath(dir, link)).toBe(true);
      const manifest = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      const owner = readFileSync(join(dir, CONFIG_OWNER_FILE), "utf8");
      const ownedConfig = readFileSync(join(dir, "config.json"), "utf8");
      const lock = join(dir, CONFIG_OWNERSHIP_LOCK);
      expect(existsSync(lock)).toBe(true);
      unlinkSync(lock);
      setUninstallElevationProbeForTests(() => true);
      const sid = "S-1-5-21-9-9-9-1001";
      const passing = (count: number) => [`U|${sid}|${sid}|False`,
        ...Array.from({ length: count }, (_, index) => [`E|${index}|${sid}|4100|1`, `A|${index}|0|3|2032127|${sid}|False`]).flat(),
        "END", ""].join("\n");
      let calls = 0;
      setWindowsOwnerAclRunnerForTests(entries => { calls++; return { success: true, timedOut: false, stdout: passing(entries.length) }; });
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      expect(calls).toBeGreaterThan(0);
      symlinkSync(target, link, "junction");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      const linkTarget = readlinkSync(link);
      const entries = readdirSync(dir).sort();
      calls = 0;
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(calls).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      calls = 0;
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("refused");
      expect(result.reason).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(result.residualPaths).toEqual([dir]);
      expect(calls).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(entries);
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(manifest);
      expect(readFileSync(join(dir, CONFIG_OWNER_FILE), "utf8")).toBe(owner);
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(ownedConfig);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(linkTarget);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
    } finally { removeTreeWithRetry(parent); }
  });

  posix("an elevated run refuses a recorded parent another account can write, before writing anything", () => {
    const { parent, dir } = ownedHome("ocx-removal-shared-parent-");
    const nested = join(dir, "nested");
    try {
      expect(recordOwnedConfigPath(dir, join(nested, "owned.txt"))).toBe(true);
      mkdirSync(nested);
      writeFileSync(join(nested, "owned.txt"), "owned");
      chmodSync(nested, 0o777);
      const manifest = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(removeOwnedConfigState(dir)).toEqual({ status: "refused", reason: ELEVATED_UNINSTALL_REFUSAL, residualPaths: [dir] });
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(manifest);
      expect(existsSync(join(dir, "config.json"))).toBe(true);
      expect(existsSync(join(nested, "owned.txt"))).toBe(true);
    } finally {
      chmodSync(nested, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run refuses a root whose ancestor another account can write", () => {
    const { parent, dir } = ownedHome("ocx-removal-shared-ancestor-");
    try {
      chmodSync(parent, 0o777);
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(existsSync(join(dir, "config.json"))).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run refuses a config tree with a link that leads outside it, before any teardown", () => {
    const { parent, dir } = ownedHome("ocx-removal-tree-link-");
    const external = join(parent, "external");
    try {
      mkdirSync(external, { mode: 0o700 });
      writeFileSync(join(external, "records.json"), "keep");
      // An unrecorded directory that teardown steps before the remover read and write through.
      symlinkSync(external, join(dir, "integrations"), "dir");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(join(external, "records.json"), "utf8")).toBe("keep");
      unlinkSync(join(dir, "integrations"));
      symlinkSync(join(external, "records.json"), join(dir, "records.json"), "file");
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      unlinkSync(join(dir, "records.json"));
      symlinkSync(join(parent, "missing"), join(dir, "dangling"), "file");
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      unlinkSync(join(dir, "dangling"));
      // A link that stays inside the root is fine.
      mkdirSync(join(dir, "inner"), { mode: 0o700 });
      symlinkSync(join(dir, "inner"), join(dir, "inner-alias"), "dir");
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("a root replaced by a link once removal has started is never followed", () => {
    const { parent, dir } = ownedHome("ocx-removal-root-link-swap-");
    const decoy = join(parent, "decoy");
    try {
      mkdirSync(decoy, { mode: 0o700 });
      writeFileSync(join(decoy, "config.json"), "keep");
      chmodSync(dir, 0o700);
      let calls = 0;
      // The third elevation read happens under the lock, after the root was resolved once.
      setUninstallElevationProbeForTests(() => {
        calls += 1;
        if (calls === 3) {
          renameSync(dir, join(parent, "moved"));
          symlinkSync(decoy, dir, "dir");
        }
        return true;
      });
      const result = removeOwnedConfigState(dir);
      expect(result.status).not.toBe("removed");
      expect(readFileSync(join(decoy, "config.json"), "utf8")).toBe("keep");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("a root replaced by another real directory before the tombstone is refused untouched", () => {
    const { parent, dir } = ownedHome("ocx-removal-root-dir-swap-");
    const moved = join(parent, "moved");
    try {
      chmodSync(dir, 0o700);
      let calls = 0;
      setUninstallElevationProbeForTests(() => {
        calls += 1;
        if (calls === 3) {
          renameSync(dir, moved);
          mkdirSync(dir, { mode: 0o700 });
          for (const name of [CONFIG_OWNER_FILE, CONFIG_UNINSTALL_MANIFEST]) copyFileSync(join(moved, name), join(dir, name));
          writeFileSync(join(dir, "config.json"), "keep");
        }
        return true;
      });
      const manifest = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("refused");
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("keep");
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(manifest);
      expect(existsSync(join(moved, "config.json"))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("a link in the tree that reaches the root through a shared directory outside it is refused", () => {
    const { parent, dir } = ownedHome("ocx-removal-tree-hop-");
    const shared = join(parent, "shared");
    try {
      chmodSync(dir, 0o700);
      mkdirSync(join(dir, "inner"), { mode: 0o700 });
      mkdirSync(shared);
      symlinkSync(join(dir, "inner"), join(shared, "hop"), "dir");
      symlinkSync(join(shared, "hop"), join(dir, "alias"), "dir");
      setUninstallElevationProbeForTests(() => true);
      chmodSync(shared, 0o777);
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      chmodSync(shared, 0o700);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      // A link to the root itself is inside the root too.
      unlinkSync(join(dir, "alias"));
      symlinkSync(dir, join(dir, "self"), "dir");
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      // So is a link to a regular file in the tree, directly or through another link.
      writeFileSync(join(dir, "inner", "target.txt"), "owned");
      symlinkSync(join(dir, "inner", "target.txt"), join(dir, "file-alias"), "file");
      symlinkSync(join(dir, "file-alias"), join(dir, "file-alias-2"), "file");
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      // A path that continues past a file never resolves, and is refused.
      symlinkSync(join(dir, "inner", "target.txt", "x"), join(dir, "past-file"), "file");
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      chmodSync(shared, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated Windows run refuses any link in the config tree before reading an ACL", () => {
    const { parent, dir } = ownedHome("ocx-removal-windows-tree-link-");
    let aclReads = 0;
    try {
      mkdirSync(join(dir, "inner"));
      symlinkSync(join(dir, "inner"), join(dir, "alias"), "dir");
      setUninstallElevationProbeForTests(() => true);
      setWindowsOwnerAclRunnerForTests(() => {
        aclReads += 1;
        return { success: true, timedOut: false, stdout: "" };
      });
      expect(withPlatform("win32", process.arch, () => elevatedRemovalRefusal(dir))).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(aclReads).toBe(0);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("removal through an aliased spelling stays on the root it resolved first", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-removal-lexical-"));
    const real = join(parent, "real");
    const decoy = join(parent, "decoy");
    const dir = join(real, "config");
    const alias = join(parent, "alias");
    try {
      mkdirSync(real);
      mkdirSync(join(decoy, "config"), { recursive: true });
      expect(recordOwnedConfigPath(dir, join(dir, "artifacts"))).toBe(true);
      mkdirSync(join(dir, "artifacts"));
      for (const name of [CONFIG_OWNER_FILE, CONFIG_UNINSTALL_MANIFEST, "config.json"]) {
        if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(decoy, "config", name));
      }
      writeFileSync(join(decoy, "config", "config.json"), "keep");
      symlinkSync(real, alias, "dir");
      // Once removal has started, the alias is pointed somewhere else.
      setOwnedDirectoryListedHookForTests(() => {
        unlinkSync(alias);
        symlinkSync(decoy, alias, "dir");
      });
      expect(removeOwnedConfigState(join(alias, "config"))).toEqual({ status: "removed", residualPaths: [] });
      expect(existsSync(dir)).toBe(false);
      expect(readFileSync(join(decoy, "config", "config.json"), "utf8")).toBe("keep");
      expect(existsSync(join(decoy, "config", CONFIG_UNINSTALL_MANIFEST))).toBe(true);
      expect(existsSync(join(decoy, "config", CONFIG_OWNER_FILE))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run checks again under the lock and refuses before the tombstone", () => {
    const { parent, dir } = ownedHome("ocx-removal-locked-recheck-");
    const nested = join(dir, "nested");
    try {
      expect(recordOwnedConfigPath(dir, join(nested, "owned.txt"))).toBe(true);
      mkdirSync(nested, { mode: 0o700 });
      const manifest = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      let calls = 0;
      // The unlocked check passes; the directory becomes shared before the locked one.
      setUninstallElevationProbeForTests(() => {
        calls += 1;
        if (calls === 3) chmodSync(nested, 0o777);
        return true;
      });
      expect(removeOwnedConfigState(dir)).toEqual({ status: "refused", reason: ELEVATED_UNINSTALL_REFUSAL, residualPaths: [dir] });
      expect(calls).toBe(3);
      expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(manifest);
      expect(existsSync(join(dir, "config.json"))).toBe(true);
    } finally {
      chmodSync(nested, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  test("a Windows token the native probe cannot read is checked as elevated and refused with its own reason", () => {
    const { parent, dir } = ownedHome("ocx-removal-unknown-token-");
    try {
      setWindowsElevationProbeForTests(() => null);
      setWindowsOwnerAclRunnerForTests(() => ({ success: false, timedOut: false, stdout: "" }));
      withPlatform("win32", "arm64", () => {
        expect(uninstallRunsElevated()).toBe(true);
        expect(elevatedRemovalRefusal(dir)).toBe(UNKNOWN_ELEVATION_UNINSTALL_REFUSAL);
      });
      setWindowsElevationProbeForTests(() => false);
      withPlatform("win32", "arm64", () => expect(elevatedRemovalRefusal(dir)).toBeNull());
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  darwin("an elevated run refuses an ACL grant on a directory reached only through a link target", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "ocx-removal-hop-acl-"));
    const hop = join(parent, "hop");
    const dir = join(parent, "real", "config");
    try {
      mkdirSync(hop, { mode: 0o755 });
      mkdirSync(join(parent, "real"), { mode: 0o700 });
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      symlinkSync(join(parent, "real"), join(hop, "second"), "dir");
      symlinkSync(join(hop, "second"), join(parent, "first"), "dir");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(join(parent, "first", "config"))).toBeNull();
      expect(Bun.spawnSync(["/bin/chmod", "+a", "everyone allow add_file,add_subdirectory,delete_child", hop]).success).toBe(true);
      expect(uninstallPrivilegeRefusal(join(parent, "first", "config"))).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
    } finally {
      Bun.spawnSync(["/bin/chmod", "-N", hop]);
      removeTreeWithRetry(parent);
    }
  });

  darwin("an elevated run refuses an ACL grant on a link the spelling passes through", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "ocx-removal-link-acl-"));
    const link = join(parent, "alias");
    const dir = join(parent, "real", "config");
    try {
      mkdirSync(join(parent, "real"), { mode: 0o700 });
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      symlinkSync(join(parent, "real"), link, "dir");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(join(link, "config"))).toBeNull();
      expect(Bun.spawnSync(["/bin/chmod", "-h", "+a", "everyone allow delete", link]).success).toBe(true);
      expect(uninstallPrivilegeRefusal(join(link, "config"))).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      Bun.spawnSync(["/bin/chmod", "-h", "-N", link]);
      removeTreeWithRetry(parent);
    }
  });

  darwin("an elevated run with no config root refuses an ACL grant on the directory it would appear in", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "ocx-removal-missing-acl-"));
    try {
      chmodSync(parent, 0o700);
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(join(parent, "config"))).toBeNull();
      expect(Bun.spawnSync(["/bin/chmod", "+a", "everyone allow add_subdirectory", parent]).success).toBe(true);
      expect(uninstallPrivilegeRefusal(join(parent, "config"))).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      Bun.spawnSync(["/bin/chmod", "-N", parent]);
      removeTreeWithRetry(parent);
    }
  });

  test("an elevated Windows run reads the tree in bounded ACL batches", () => {
    const { parent, dir } = ownedHome("ocx-removal-windows-tree-");
    const calls: number[] = [];
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "artifacts"))).toBe(true);
      for (let index = 0; index < 48; index += 1) mkdirSync(join(dir, "artifacts", `d${index}`), { recursive: true });
      setUninstallElevationProbeForTests(() => true);
      setWindowsOwnerAclRunnerForTests(entries => {
        calls.push(entries.length);
        return { success: false, timedOut: true, stdout: "" };
      });
      expect(withPlatform("win32", process.arch, () => elevatedRemovalRefusal(dir))).toBe(ELEVATED_UNINSTALL_REFUSAL);
      // A tree larger than one batch is read in several, each with its own deadline.
      for (let index = 48; index < 600; index += 1) mkdirSync(join(dir, "artifacts", `d${index}`));
      expect(withPlatform("win32", process.arch, () => elevatedRemovalRefusal(dir))).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      removeTreeWithRetry(parent);
    }
    // The small tree fits one read; the large one starts with a full batch (and fails closed there).
    expect(calls[0]).toBeGreaterThan(50);
    expect(calls[1]).toBe(256);
  });

  test("an elevated Windows run checks every ACL batch, not only the first", () => {
    const { parent, dir } = ownedHome("ocx-removal-windows-later-batch-");
    const sid = "S-1-5-21-9-9-9-1001";
    // A read every entry of the batch passes: the token user owns it with a protected DACL.
    const passing = (count: number) => [`U|${sid}|${sid}|False`,
      ...Array.from({ length: count }, (_, index) => [`E|${index}|${sid}|4100|1`, `A|${index}|0|3|2032127|${sid}|False`]).flat(),
      "END", ""].join("\n");
    const calls: number[] = [];
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "artifacts"))).toBe(true);
      for (let index = 0; index < 400; index += 1) mkdirSync(join(dir, "artifacts", `d${index}`), { recursive: true });
      setUninstallElevationProbeForTests(() => true);
      setWindowsOwnerAclRunnerForTests(entries => {
        calls.push(entries.length);
        return calls.length === 1
          ? { success: true, timedOut: false, stdout: passing(entries.length) }
          : { success: false, timedOut: true, stdout: "" };
      });
      expect(withPlatform("win32", process.arch, () => elevatedRemovalRefusal(dir))).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      removeTreeWithRetry(parent);
    }
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe(256);
  });

  (process.platform === "linux" ? test : test.skip)("a chain of links within the kernel's limit is followed (Linux allows 40)", () => {
    const { parent, dir } = ownedHome("ocx-removal-link-chain-");
    try {
      chmodSync(dir, 0o700);
      mkdirSync(join(dir, "inner"), { mode: 0o700 });
      let previous = join(dir, "inner");
      for (let index = 0; index < 36; index += 1) {
        const link = join(dir, `l${index}`);
        symlinkSync(previous, link, "dir");
        previous = link;
      }
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("a link cycle in the tree is refused", () => {
    const { parent, dir } = ownedHome("ocx-removal-link-cycle-");
    try {
      chmodSync(dir, 0o700);
      symlinkSync(join(dir, "b"), join(dir, "a"), "dir");
      symlinkSync(join(dir, "a"), join(dir, "b"), "dir");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run accepts a root and a tree link spelled in another case on a case-insensitive volume", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "ocx-removal-case-spelling-"));
    try {
      chmodSync(parent, 0o700);
      const stored = join(parent, "Config");
      mkdirSync(stored, { mode: 0o700 });
      // A case-sensitive volume (most Linux runners) cannot show this; there is nothing to check.
      if (!existsSync(join(parent, "config"))) return;
      const dir = join(parent, "config");
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      mkdirSync(join(stored, "inner"), { mode: 0o700 });
      writeFileSync(join(stored, "inner", "Target.txt"), "owned");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      symlinkSync(join(dir, "inner", "target.txt"), join(stored, "file-alias"), "file");
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run refuses a directory deep inside a recorded directory that another account can write", () => {
    const { parent, dir } = ownedHome("ocx-removal-shared-descendant-");
    const deep = join(dir, "artifacts", "a", "b");
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "artifacts"))).toBe(true);
      mkdirSync(deep, { recursive: true });
      chmodSync(deep, 0o777);
      setUninstallElevationProbeForTests(() => true);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(existsSync(join(dir, "config.json"))).toBe(true);
    } finally {
      chmodSync(deep, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  darwin("an elevated run refuses a directory whose ACL lets another account add or delete entries", () => {
    const { parent, dir } = ownedHome("ocx-removal-darwin-acl-");
    const nested = join(dir, "nested");
    try {
      expect(recordOwnedConfigPath(dir, join(nested, "owned.txt"))).toBe(true);
      mkdirSync(nested, { mode: 0o755 });
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      const acl = Bun.spawnSync(["/bin/chmod", "+a", "everyone allow add_file,add_subdirectory,delete_child", nested]);
      expect(acl.success).toBe(true);
      expect(uninstallPrivilegeRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
      // A deny-only entry, such as the one macOS puts on home folders, is not a grant.
      Bun.spawnSync(["/bin/chmod", "-a#", "0", nested]);
      expect(Bun.spawnSync(["/bin/chmod", "+a", "everyone deny delete", nested]).success).toBe(true);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
    } finally {
      Bun.spawnSync(["/bin/chmod", "-N", nested]);
      removeTreeWithRetry(parent);
    }
  });

  posix("a refused elevated run does not create the ownership lock", () => {
    const { parent, dir } = ownedHome("ocx-removal-no-lock-");
    try {
      unlinkSync(join(dir, CONFIG_OWNERSHIP_LOCK));
      chmodSync(dir, 0o777);
      setUninstallElevationProbeForTests(() => true);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(existsSync(join(dir, CONFIG_OWNERSHIP_LOCK))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("a recorded entry under a dangling directory link is reported, not dropped", () => {
    const { parent, dir } = ownedHome("ocx-removal-dangling-");
    const recorded = join(dir, "nested", "owned.txt");
    try {
      expect(recordOwnedConfigPath(dir, recorded)).toBe(true);
      symlinkSync(join(parent, "missing"), join(dir, "nested"), "dir");
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([recorded]);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  unprivilegedPosix("a recorded entry that cannot be looked up is reported, not dropped", () => {
    const { parent, dir } = ownedHome("ocx-removal-unreadable-");
    const nested = join(dir, "nested");
    const recorded = join(nested, "owned.txt");
    try {
      expect(recordOwnedConfigPath(dir, recorded)).toBe(true);
      mkdirSync(nested);
      writeFileSync(recorded, "owned");
      chmodSync(nested, 0o000);
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([recorded]);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      chmodSync(nested, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run still removes a home only its own account can change", () => {
    const { parent, dir } = ownedHome("ocx-removal-private-");
    try {
      chmodSync(parent, 0o700);
      chmodSync(dir, 0o700);
      expect(recordOwnedConfigPath(dir, join(dir, "artifacts"))).toBe(true);
      mkdirSync(join(dir, "artifacts", "deep"), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "artifacts", "deep", "image.bin"), "owned");
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
      expect(existsSync(dir)).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("a run that is not elevated does not check who else can write the home", () => {
    setUninstallElevationProbeForTests(() => false);
    setWindowsOwnerAclRunnerForTests(() => { throw new Error("no ACL read expected"); });
    expect(elevatedRemovalRefusal(tmpdir())).toBeNull();
  });

  test("a recorded path whose parent is stored in another case is removed on a case-insensitive volume", () => {
    const { parent, dir } = ownedHome("ocx-removal-case-");
    try {
      mkdirSync(join(dir, "Nested"));
      // A case-sensitive volume (most Linux runners) cannot show this; there is nothing to check.
      if (!existsSync(join(dir, "nested"))) return;
      if (process.platform === "win32") setUninstallElevationProbeForTests(() => false);
      const recorded = join(dir, "nested", "owned.txt");
      expect(recordOwnedConfigPath(dir, recorded)).toBe(true);
      writeFileSync(recorded, "owned");
      const result = removeOwnedConfigState(dir);
      // The unrecorded directory stays; the recorded file inside it goes.
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([join(dir, "Nested")]);
      expect(existsSync(join(dir, "Nested", "owned.txt"))).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("a recorded file link is unlinked itself and its target is kept", () => {
    const { parent, dir } = ownedHome("ocx-removal-file-link-");
    const target = join(parent, "target.txt");
    try {
      writeFileSync(target, "keep");
      expect(recordOwnedConfigPath(dir, join(dir, "linked.txt"))).toBe(true);
      symlinkSync(target, join(dir, "linked.txt"), "file");
      expect(removeOwnedConfigState(dir)).toEqual({ status: "removed", residualPaths: [] });
      expect(readFileSync(target, "utf8")).toBe("keep");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  posix("a directory replaced by a link after it is listed stops removal there", () => {
    const { parent, dir } = ownedHome("ocx-removal-swapped-");
    const artifacts = join(dir, "artifacts");
    const outside = join(parent, "outside");
    try {
      expect(recordOwnedConfigPath(dir, artifacts)).toBe(true);
      mkdirSync(join(artifacts, "sub"), { recursive: true });
      writeFileSync(join(artifacts, "sub", "image.bin"), "owned");
      mkdirSync(outside);
      writeFileSync(join(outside, "image.bin"), "keep");
      setOwnedDirectoryListedHookForTests(path => {
        // The hook sees the canonical spelling of the path (macOS reports /private/var for /var).
        if (!path.endsWith(join("artifacts", "sub"))) return;
        renameSync(path, join(parent, "moved"));
        symlinkSync(outside, path, "dir");
      });
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([artifacts]);
      expect(readFileSync(join(outside, "image.bin"), "utf8")).toBe("keep");
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("an elevated Windows run reads ancestors and removal directories with their ACL policies", () => {
    const { parent, dir } = ownedHome("ocx-removal-windows-acl-");
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    const seen: WindowsAclEntry[] = [];
    try {
      mkdirSync(join(dir, "nested"));
      expect(recordOwnedConfigPath(dir, join(dir, "artifacts"))).toBe(true);
      mkdirSync(join(dir, "artifacts", "deep"), { recursive: true });
      setUninstallElevationProbeForTests(() => true);
      setWindowsOwnerAclRunnerForTests(entries => {
        seen.push(...entries);
        return { success: false, timedOut: false, stdout: "" };
      });
      Object.defineProperty(process, "platform", { ...original, value: "win32" });
      expect(elevatedRemovalRefusal(dir)).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      Object.defineProperty(process, "platform", original);
      removeTreeWithRetry(parent);
    }
    const policies = new Map(seen.map(entry => [entry.path, entry.policy]));
    const policyFor = (suffix: string) => [...policies].find(([path]) => path.endsWith(suffix))?.[1];
    expect(policyFor(join("config", "nested"))).toBe("write-private");
    expect(policyFor(join("config", "artifacts", "deep"))).toBe("write-private");
    expect(policyFor("config")).toBe("write-private");
    expect([...policies.values()].filter(policy => policy === "trusted-ancestry").length).toBeGreaterThan(0);
    expect(seen.every(entry => entry.directory)).toBe(true);
  });

  posix("an elevated run refuses a spelling that passes through a link in a directory another account can write", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-removal-spelling-shared-"));
    const shared = join(parent, "shared");
    const dir = join(parent, "real", "config");
    try {
      mkdirSync(shared);
      mkdirSync(join(parent, "real"), { mode: 0o700 });
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      symlinkSync(join(parent, "real"), join(shared, "alias"), "dir");
      chmodSync(shared, 0o777);
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(dir)).toBeNull();
      expect(uninstallPrivilegeRefusal(join(shared, "alias", "config"))).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      chmodSync(shared, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run refuses a spelling whose link target passes through a directory another account can write", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-removal-spelling-hop-"));
    const shared = join(parent, "shared");
    const dir = join(parent, "real", "config");
    try {
      mkdirSync(shared);
      mkdirSync(join(parent, "real"), { mode: 0o700 });
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      // first -> shared/second -> real: neither the given path nor the canonical one names shared.
      symlinkSync(join(parent, "real"), join(shared, "second"), "dir");
      symlinkSync(join(shared, "second"), join(parent, "first"), "dir");
      chmodSync(shared, 0o777);
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(join(parent, "first", "config"))).toBe(ELEVATED_UNINSTALL_REFUSAL);
      chmodSync(shared, 0o700);
      expect(uninstallPrivilegeRefusal(join(parent, "first", "config"))).toBeNull();
    } finally {
      chmodSync(shared, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("a link in a sticky shared directory counts only when no other account owns it", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-removal-spelling-sticky-"));
    const sticky = join(parent, "sticky");
    const dir = join(parent, "real", "config");
    try {
      mkdirSync(sticky);
      mkdirSync(join(parent, "real"), { mode: 0o700 });
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      symlinkSync(join(parent, "real"), join(sticky, "alias"), "dir");
      chmodSync(sticky, 0o1777);
      setUninstallElevationProbeForTests(() => true);
      // This account owns the link, so the sticky bit keeps every other account from replacing it.
      expect(uninstallPrivilegeRefusal(join(sticky, "alias", "config"))).toBeNull();
    } finally {
      chmodSync(sticky, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated run with no config root yet checks the directory it would appear in", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-removal-missing-root-"));
    try {
      chmodSync(parent, 0o700);
      setUninstallElevationProbeForTests(() => true);
      expect(uninstallPrivilegeRefusal(join(parent, "config"))).toBeNull();
      chmodSync(parent, 0o1777);
      expect(uninstallPrivilegeRefusal(join(parent, "config"))).toBe(ELEVATED_UNINSTALL_REFUSAL);
    } finally {
      chmodSync(parent, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  posix("an elevated Windows run refuses a spelling with a link in it before reading any ACL", () => {
    const { parent, dir } = ownedHome("ocx-removal-windows-spelling-");
    let aclReads = 0;
    try {
      symlinkSync(parent, join(parent, "alias"), "dir");
      setUninstallElevationProbeForTests(() => true);
      setWindowsOwnerAclRunnerForTests(() => {
        aclReads += 1;
        return { success: false, timedOut: false, stdout: "" };
      });
      expect(withPlatform("win32", process.arch, () => elevatedRemovalRefusal(join(parent, "alias", "config")))).toBe(ELEVATED_UNINSTALL_REFUSAL);
      expect(aclReads).toBe(0);
      expect(existsSync(dir)).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  windows("the synchronous ACL reader passes a large batch with non-ASCII names over stdin", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-removal-acl-stdin-"));
    try {
      const entries = Array.from({ length: 24 }, (_, index) => {
        const path = join(parent, index === 7 ? "설정-ü-\u{1F600}" : `d${index}`);
        mkdirSync(path);
        return { path, directory: true };
      });
      const result = windowsOwnerAclDefaultRunnerForTests(entries, 60_000);
      expect(result.success).toBe(true);
      const lines = Buffer.from(result.stdout).toString("utf8").split(/\r?\n/);
      for (let index = 0; index < entries.length; index += 1) {
        expect(lines.some(line => line.startsWith(`E|${index}|`))).toBe(true);
      }
      expect(lines).toContain("END");
    } finally {
      removeTreeWithRetry(parent);
    }
  });
});
