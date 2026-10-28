import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ownership from "../../src/cli/codex-launch-ownership";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("Codex launcher Darwin ACL mutation admission", () => {
  test("only a null descriptor with ENOENT means no extended ACL", () => {
    expect(ownership.darwinAclDescriptorIsAbsent(null, 2)).toBe(true);
    expect(ownership.darwinAclDescriptorIsAbsent(0, 2)).toBe(true);
    expect(ownership.darwinAclDescriptorIsAbsent(0n, 2)).toBe(true);
    for (const errno of [0, 5, 12, 13, 22, 45]) {
      expect(ownership.darwinAclDescriptorIsAbsent(null, errno)).toBe(false);
    }
    expect(ownership.darwinAclDescriptorIsAbsent(123, 2)).toBe(false);
  });
  test("empty ACLs are safe", () => {
    expect(ownership.darwinAclEntriesAreSafe([])).toBe(true);
  });
  test("deny-only ACLs are safe", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 2, perms: 0xffffffff }])).toBe(true);
  });
  test("read-only allow ACLs are safe", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 1, perms: (1 << 1) | (1 << 3) | (1 << 7) | (1 << 9) | (1 << 11) | (1 << 20) }])).toBe(true);
  });

  // Apple sys/acl.h: aliases ADD_FILE/ADD_SUBDIRECTORY share WRITE_DATA/APPEND_DATA bits.
  for (const [name, bit] of [
    ["WRITE_DATA / ADD_FILE", 2], ["DELETE", 4], ["APPEND_DATA / ADD_SUBDIRECTORY", 5],
    ["DELETE_CHILD", 6], ["WRITE_ATTRIBUTES", 8], ["WRITE_EXTATTRIBUTES", 10],
    ["WRITE_SECURITY", 12], ["CHANGE_OWNER", 13],
  ] as const) {
    test(`allow ${name} refuses`, () => {
      expect(ownership.darwinAclEntriesAreSafe([{ tag: 1, perms: 1 << bit }])).toBe(false);
    });
  }

  test("a deny entry cannot hide a subsequent mutating allow", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 2, perms: 1 << 2 }, { tag: 1, perms: 1 << 2 }])).toBe(false);
  });

  test("unknown tags and incomplete enumeration refuse", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 0, perms: 0 }])).toBe(false);
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 3, perms: 0 }])).toBe(false);
    expect(ownership.darwinAclEntriesAreSafe(null)).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("native protected symlinked user .codex admits", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-darwin-link-")));
    const home = join(root, "codex-home"), user = join(root, "user"), alias = join(user, ".codex");
    try {
      for (const directory of [root, home, user]) { mkdirSync(directory, { recursive: true }); chmodSync(directory, 0o700); }
      writeFileSync(join(home, "config.toml"), 'model = "fixture"\n', { mode: 0o600 });
      symlinkSync(home, alias, "dir");
      expect(ownership.codexLaunchHomeIsOwned(realpathSync(alias))).toBe(true);
      expect(ownership.codexLaunchProjectAliasIsOwned(alias)).toBe(true);
      expect(ownership.codexLaunchProjectAliasIsOwned(join(alias, "config.toml"))).toBe(true);
    } finally { removeTreeWithRetry(root); }
  });

  test.skipIf(process.platform !== "darwin")("native deny-delete ACL accepts; a later allow-write ACL refuses", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-darwin-acl-")));
    const home = join(root, "codex");
    try {
      mkdirSync(home); chmodSync(root, 0o700); chmodSync(home, 0o700);
      writeFileSync(join(home, "config.toml"), 'model = "fixture"\n', { mode: 0o600 });
      expect(ownership.codexLaunchHomeIsOwned(home)).toBe(true);
      expect(ownership.codexLaunchSystemNamespaceIsSafe(join(home, "missing-system"))).toBe(true);
      expect(ownership.codexLaunchProjectAliasIsOwned(join(home, "config.toml"))).toBe(true);
      const chmodAcl = (entry: string) => {
        const result = Bun.spawnSync(["/bin/chmod", "+a", entry, root], { stdout: "pipe", stderr: "pipe" });
        expect(result.success).toBe(true);
      };
      chmodAcl("everyone deny delete");
      expect(ownership.codexLaunchHomeIsOwned(home)).toBe(true);
      chmodAcl("everyone allow write");
      expect(ownership.codexLaunchHomeIsOwned(home)).toBe(false);
    } finally {
      const cleared = Bun.spawnSync(["/bin/chmod", "-N", root], { stdout: "pipe", stderr: "pipe" });
      expect(cleared.success).toBe(true);
      removeTreeWithRetry(root);
    }
  });
});
