import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { acquireCodexCliApplyLease } from "../../src/codex/cli-update-lease";
import { assertTrustedCodexCliAncestry, createCodexCliApplyStaging,
  observeCodexCliMutationPaths } from "../../src/codex/cli-update-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Model POSIX ownership on hosts where tests cannot chown (including Windows).
// Directory identities, lock creation and rename operations remain real.
test.each(["foreign-owner", "group-write", "other-write", "foreign-sticky"])(
  "lease refuses a %s ancestor before its rename barrier can be crossed", scenario => {
    const root = createCodexCliTestRoot("ocx-trusted-path-");
    const parent = join(root, "parent"), prefix = join(parent, "prefix");
    fs.mkdirSync(prefix, { recursive: true });
    const original = fs.lstatSync, uid = process.geteuid?.() ?? 1234;
    const getuid = Object.getOwnPropertyDescriptor(process, "geteuid");
    Object.defineProperty(process, "geteuid", { configurable: true, value: () => uid });
    const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
      const value = original(path);
      if (!value.isDirectory()) return value;
      const unsafe = path === parent;
      return Object.assign(value, { uid: unsafe && scenario.includes("foreign") ? uid + 1 : uid,
        mode: 0o40755 | (unsafe ? scenario === "group-write" ? 0o020 : scenario === "other-write" ? 0o002
          : scenario === "foreign-sticky" ? 0o1002 : 0 : 0) });
    }) as typeof fs.lstatSync);
    let lease: ReturnType<typeof acquireCodexCliApplyLease> | undefined;
    let crossed = false;
    try {
      lease = acquireCodexCliApplyLease(prefix);
      if (lease.kind === "acquired") {
        // A barrier representing the next npm path resolution. The untrusted
        // parent can replace its child without changing that child's mode.
        fs.renameSync(prefix, join(parent, "displaced"));
        fs.mkdirSync(prefix); crossed = true;
      }
      expect(lease.kind).toBe("prefix_unsupported");
      expect(crossed).toBe(false);
      expect(fs.existsSync(join(prefix, ".ocx-codex-cli-apply.lock"))).toBe(false);
    } finally {
      if (crossed) { fs.rmdirSync(prefix); fs.renameSync(join(parent, "displaced"), prefix); }
      if (lease?.kind === "acquired") lease.release();
      stat.mockRestore();
      if (getuid) Object.defineProperty(process, "geteuid", getuid); else Reflect.deleteProperty(process, "geteuid");
      removeTreeWithRetry(root);
    }
  },
);

test.each(["root-sticky", "root-nonsticky", "user-sticky", "foreign-owner", "nested-write"])(
  "mutation and staging paths enforce the %s policy", scenario => {
    const root = createCodexCliTestRoot("ocx-path-policy-");
    const parent = join(root, "parent"), prefix = join(parent, "prefix");
    const nested = join(prefix, "lib/node_modules/@openai"); fs.mkdirSync(nested, { recursive: true });
    const lstat = fs.lstatSync;
    const originalUid = Object.getOwnPropertyDescriptor(process, "geteuid");
    Object.defineProperty(process, "geteuid", { configurable: true, value: () => 1234 });
    const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
      const value = lstat(path);
      if (!value.isDirectory()) return value;
      const shared = path === parent;
      return Object.assign(value, {
        uid: shared ? scenario.startsWith("root-") ? 0 : scenario === "foreign-owner" ? 4321 : 1234 : 1234,
        mode: 0o40700 | (shared && scenario !== "nested-write" ? 0o077 : 0)
          | (shared && scenario.endsWith("sticky") && scenario !== "root-nonsticky" ? 0o1000 : 0)
          | (path === nested && scenario === "nested-write" ? 0o020 : 0),
      });
    }) as typeof fs.lstatSync);
    try {
      if (scenario === "root-sticky") {
        expect(() => assertTrustedCodexCliAncestry(prefix)).not.toThrow();
        expect(observeCodexCliMutationPaths(prefix).has(nested)).toBe(true);
        const stage = createCodexCliApplyStaging(parent);
        expect(dirname(stage)).toBe(parent);
        expect(lstat(stage).isDirectory()).toBe(true);
      } else if (scenario === "nested-write") {
        expect(() => assertTrustedCodexCliAncestry(prefix)).not.toThrow();
        expect(() => observeCodexCliMutationPaths(prefix)).toThrow("untrusted_posix_path");
      } else {
        expect(() => observeCodexCliMutationPaths(prefix)).toThrow("untrusted_posix_path");
        const before = fs.readdirSync(parent);
        expect(() => createCodexCliApplyStaging(parent)).toThrow("untrusted_posix_path");
        expect(fs.readdirSync(parent)).toEqual(before);
      }
    } finally {
      stat.mockRestore();
      if (originalUid) Object.defineProperty(process, "geteuid", originalUid); else Reflect.deleteProperty(process, "geteuid");
      removeTreeWithRetry(root);
    }
  },
);
