import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, fsyncSync, fstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RemoteMessageStore, parseRemoteState } from "../../src/messaging/remote-store";
import { macAclOutputIsPrivate, readRemoteFile, removeRemoteFile, withRemoteLock, writeRemoteFile } from "../../src/messaging/remote-files";
import { LocalMessagingError } from "../../src/messaging/types";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { repoPath } from "../helpers/repo-root";

const unixTest = test.skipIf(process.platform === "win32");
test("macOS ACL inspection distinguishes plain metadata from access entries", () => {
  expect(macAclOutputIsPrivate("-rw-------  1 owner  staff  4 Oct 22 00:00 state.json\n")).toBe(true);
  expect(macAclOutputIsPrivate("-rw-------+ 1 owner  staff  4 Oct 22 00:00 state.json\n 0: everyone allow read\n")).toBe(false);
  expect(macAclOutputIsPrivate("")).toBe(false);
});
test.each(["acl", "error", "timeout"])("temporary ACL %s closes the descriptor and removes unpublished state", failure => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-acl-failure-"));
  try {
    // Keep built-in mocks and simulated macOS ownership out of every other test.
    // File creation, descriptor checks, close and unlink use the real host filesystem.
    const result = spawnSync(process.execPath, ["--eval", `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      import * as fs from "node:fs";
      import * as childProcess from "node:child_process";
      import * as path from "node:path";
      const native = { ...fs }, root = ${JSON.stringify(root)}, failure = ${JSON.stringify(failure)};
      const nativePath = { ...path }, { basename, join } = nativePath;
      const target = "/fixture/journal.json", published = join(root, "journal.json");
      native.writeFileSync(published, "old", { mode: 0o600 });
      let fd, temporary, probes = 0, writes = 0, syncs = 0, renames = 0;
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "getuid", { value: () => 1234 });
      mock.module("node:path", () => ({ ...nativePath, ...nativePath.posix }));
      mock.module("node:fs", () => ({ ...native,
        lstatSync(path) {
          if (path === "/fixture" || path === "/") return {
            uid: 1234, mode: 0o700,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          };
          return native.lstatSync(join(root, basename(path)));
        },
        realpathSync: () => "/",
        openSync(path, flags, mode) {
          temporary = join(root, basename(path));
          fd = native.openSync(temporary, flags, mode);
          return fd;
        },
        fstatSync(fd) { return Object.assign(native.fstatSync(fd), { uid: 1234, mode: 0o100600 }); },
        writeFileSync(...args) { writes++; return native.writeFileSync(...args); },
        renameSync() { renames++; throw new Error("unexpected publication"); },
        unlinkSync(path) { native.unlinkSync(join(root, basename(path))); },
      }));
      mock.module("node:child_process", () => ({ ...childProcess, spawnSync(command, args, options) {
        assert.equal(command, "/bin/ls");
        assert.deepEqual(args.slice(0, 1), ["-lde"]);
        assert.equal(options.timeout, 1000);
        if (!basename(args[1]).startsWith(".write-")) return {
          status: 0, stderr: "", stdout: "drwx------ 1 owner staff 0 Oct 22 00:00 fixture\\n",
        };
        probes++;
        assert.equal(native.fstatSync(fd).isFile(), true);
        assert.equal(native.existsSync(temporary), true);
        if (failure === "acl") return { status: 0, stderr: "",
          stdout: "-rw-------+ 1 owner staff 0 Oct 22 00:00 state\\n 0: everyone allow read\\n" };
        return { status: null, stderr: "", stdout: "",
          error: Object.assign(new Error("fixture ACL probe failure"), {
            code: failure === "timeout" ? "ETIMEDOUT" : "EIO",
          }) };
      } }));
      const { writeRemoteFile } = await import(${JSON.stringify(pathToFileURL(repoPath("src/messaging/remote-files.ts")).href)});
      const { LocalMessagingError } = await import(${JSON.stringify(pathToFileURL(repoPath("src/messaging/types.ts")).href)});
      try {
        let refusal;
        try { writeRemoteFile(target, "unpublished", () => { syncs++; }); }
        catch (error) { refusal = error; }
        if (!probes) throw refusal;
        assert.equal(probes, 1);
        assert.equal(writes, 0); assert.equal(syncs, 0); assert.equal(renames, 0);
        assert.throws(() => native.fstatSync(fd), { code: "EBADF" });
        assert.equal(native.existsSync(temporary), false);
        assert.equal(native.readFileSync(published, "utf8"), "old");
        assert.deepEqual(native.readdirSync(root), ["journal.json"]);
        assert.ok(refusal instanceof LocalMessagingError);
        assert.equal(refusal.code, "unsafe_remote_storage");
        assert.equal(refusal.message.includes("fixture ACL probe failure"), false);
        assert.equal(refusal.message.includes("everyone allow read"), false);
      } finally {
        // Even the deliberately red regression run must release its fixture descriptor.
        if (fd !== undefined) {
          try { native.closeSync(fd); }
          catch (error) { if (error?.code !== "EBADF") throw error; }
        }
      }
    `], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally { rmSync(root, { recursive: true }); }
});
test.each(["acl", "error", "timeout"])("post-rename ACL %s reports unknown publication without retry or rollback", failure => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-published-acl-"));
  try {
    // Only the destination probe after real replacement fails; earlier ACL checks pass.
    const result = spawnSync(process.execPath, ["--eval", `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      import * as fs from "node:fs";
      import * as childProcess from "node:child_process";
      import * as path from "node:path";
      const native = { ...fs }, root = ${JSON.stringify(root)}, failure = ${JSON.stringify(failure)};
      const nativePath = { ...path }, { basename, join } = nativePath;
      const target = "/fixture/journal.json", published = join(root, "journal.json");
      native.writeFileSync(published, "old", { mode: 0o600 });
      let renames = 0, writes = 0, syncs = 0, directoryOpens = 0, postRenameProbes = 0;
      const probes = [], descriptors = [];
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "getuid", { value: () => 1234 });
      mock.module("node:path", () => ({ ...nativePath, ...nativePath.posix }));
      mock.module("node:fs", () => ({ ...native,
        lstatSync(path) {
          if (path === "/fixture" || path === "/") return {
            uid: 1234, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false,
          };
          return native.lstatSync(join(root, basename(path)));
        },
        realpathSync: () => "/",
        openSync(path, flags, mode) {
          if (path === "/") { directoryOpens++; throw new Error("unexpected directory sync"); }
          const fd = native.openSync(join(root, basename(path)), flags, mode);
          descriptors.push(fd); return fd;
        },
        fstatSync(fd) { return Object.assign(native.fstatSync(fd), { uid: 1234, mode: 0o100600 }); },
        writeFileSync(...args) { writes++; return native.writeFileSync(...args); },
        renameSync(from, to) {
          assert.equal(native.readFileSync(published, "utf8"), "old");
          native.renameSync(join(root, basename(from)), join(root, basename(to))); renames++;
        },
        unlinkSync(path) { native.unlinkSync(join(root, basename(path))); },
      }));
      mock.module("node:child_process", () => ({ ...childProcess, spawnSync(command, args, options) {
        assert.equal(command, "/bin/ls"); assert.equal(options.timeout, 1000);
        probes.push(args[1]);
        if (args[1] !== target || !renames) return { status: 0, stderr: "",
          stdout: (args[1] === "/fixture" ? "drwx------" : "-rw-------") + " 1 owner staff 3 Oct 22 00:00 state\\n" };
        postRenameProbes++;
        assert.equal(native.readFileSync(published, "utf8"), "new");
        if (failure === "acl") return { status: 0, stderr: "",
          stdout: "-rw-------+ 1 owner staff 3 Oct 22 00:00 state\\n 0: everyone allow read\\n" };
        return { status: null, stderr: "", stdout: "", error: Object.assign(new Error("private ACL diagnostic"), {
          code: failure === "timeout" ? "ETIMEDOUT" : "EIO",
        }) };
      } }));
      const { writeRemoteFile } = await import(${JSON.stringify(pathToFileURL(repoPath("src/messaging/remote-files.ts")).href)});
      const { LocalMessagingError } = await import(${JSON.stringify(pathToFileURL(repoPath("src/messaging/types.ts")).href)});
      let thrown;
      try { writeRemoteFile(target, "new", fd => { syncs++; native.fsyncSync(fd); }); }
      catch (error) { thrown = error; }
      if (!postRenameProbes) throw thrown;
      assert.equal(postRenameProbes, 1);
      assert.equal(probes.length, 5);
      assert.deepEqual(probes.slice(0, 3), ["/fixture", "/fixture", target]);
      assert.equal(basename(probes[3]).startsWith(".write-"), true);
      assert.equal(probes[4], target);
      assert.equal(renames, 1); assert.equal(writes, 1); assert.equal(syncs, 1); assert.equal(directoryOpens, 0);
      assert.equal(native.readFileSync(published, "utf8"), "new");
      assert.deepEqual(native.readdirSync(root), ["journal.json"]);
      for (const fd of descriptors) assert.throws(() => native.fstatSync(fd), { code: "EBADF" });
      assert.ok(thrown instanceof LocalMessagingError);
      assert.equal(thrown.code, "remote_storage_unknown");
      assert.match(thrown.message, /replaced/);
      assert.match(thrown.message, /ACL.*could not be confirmed/);
      assert.match(thrown.message, /inspect.*before.*recovery/);
      assert.equal(thrown.message.includes("private ACL diagnostic"), false);
    `], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally { rmSync(root, { recursive: true }); }
});
const macTest = process.platform === "darwin" ? test : test.skip;
macTest("macOS extended ACLs are refused on messaging directories and files", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-acl-")), home = join(root, "ocx"), store = new RemoteMessageStore(home);
  try {
    mkdirSync(home, { mode: 0o755 }); const enabled = store.enable();
    for (const path of [store.directory, store.path]) {
      expect(store.read()).toEqual(enabled);
      const mode = statSync(path).mode;
      expect(mode & 0o077).toBe(0);
      const added = spawnSync("/bin/chmod", ["+a", "everyone allow read", path], { encoding: "utf8", timeout: 1_000 });
      expect(added.error).toBeUndefined(); expect(added.status).toBe(0);
      expect(statSync(path).mode).toBe(mode);
      let refusal: unknown;
      try { store.read(); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(LocalMessagingError);
      expect((refusal as LocalMessagingError).code).toBe("unsafe_remote_storage");
      const removed = spawnSync("/bin/chmod", ["-N", path], { encoding: "utf8", timeout: 1_000 });
      expect(removed.error).toBeUndefined(); expect(removed.status).toBe(0);
      expect(statSync(path).mode).toBe(mode);
      expect(store.read()).toEqual(enabled);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("publication syncs the file before rename and its directory afterwards, closing both descriptors", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-sync-")), path = join(root, "journal.json");
  const synced: { fd: number; directory: boolean }[] = [];
  try {
    writeRemoteFile(path, "durable", fd => {
      const directory = fstatSync(fd).isDirectory();
      expect(existsSync(path)).toBe(directory);
      synced.push({ fd, directory }); fsyncSync(fd);
    });
    expect(synced.map(item => item.directory)).toEqual([false, true]);
    expect(readRemoteFile(path)).toBe("durable");
    for (const item of synced) expect(() => fstatSync(item.fd)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("a failed directory sync reports uncertain durability without erasing the published journal", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-sync-fail-")), path = join(root, "journal.json");
  let directoryFd = -1;
  try {
    expect(() => writeRemoteFile(path, "retained", fd => {
      if (fstatSync(fd).isDirectory()) { directoryFd = fd; throw new Error("private sync diagnostic"); }
      fsyncSync(fd);
    })).toThrow("durability could not be confirmed");
    expect(readRemoteFile(path)).toBe("retained"); expect(() => fstatSync(directoryFd)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("file sync failure cannot publish a replacement or reach the directory sync", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-file-fail-")), path = join(root, "journal.json");
  let fileFd = -1;
  try {
    writeRemoteFile(path, "old");
    expect(() => writeRemoteFile(path, "new", fd => {
      fileFd = fd; expect(fstatSync(fd).isFile()).toBe(true); throw new Error("fixture file sync failed");
    })).toThrow("fixture file sync failed");
    expect(readRemoteFile(path)).toBe("old"); expect(() => fstatSync(fileFd)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("journal removal syncs its absence and reports a failed durability barrier", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-remove-sync-")), path = join(root, "journal.json");
  let directoryFd = -1;
  try {
    writeRemoteFile(path, "old");
    removeRemoteFile(path, undefined, fd => {
      directoryFd = fd; expect(fstatSync(fd).isDirectory()).toBe(true); expect(existsSync(path)).toBe(false); fsyncSync(fd);
    });
    expect(() => fstatSync(directoryFd)).toThrow();
    writeRemoteFile(path, "new");
    expect(() => removeRemoteFile(path, undefined, fd => {
      directoryFd = fd; throw new Error("private removal sync error");
    })).toThrow("durability could not be confirmed");
    expect(existsSync(path)).toBe(false); expect(() => fstatSync(directoryFd)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("enable preserves a trusted 0755 configuration home and creates private messaging state", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-home-")), home = join(root, "ocx"), store = new RemoteMessageStore(home);
  try {
    mkdirSync(home, { mode: 0o755 }); chmodSync(home, 0o755);
    const enabled = store.enable();
    expect(store.requireEnabled().machine).toEqual(enabled.machine);
    expect(statSync(home).mode & 0o777).toBe(0o755);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    chmodSync(store.directory, 0o755);
    expect(() => store.enable()).toThrow("private");
    expect(statSync(store.directory).mode & 0o777).toBe(0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("enable refuses writable configuration homes, writable ancestry and redirected homes", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-remote-unsafe-"));
  try {
    for (const mode of [0o775, 0o777]) {
      const home = join(root, `home-${mode}`), store = new RemoteMessageStore(home);
      mkdirSync(home, { mode }); chmodSync(home, mode);
      expect(() => store.enable()).toThrow("trusted");
      expect(existsSync(store.directory)).toBe(false); expect(statSync(home).mode & 0o777).toBe(mode);
    }
    const ancestor = join(root, "ancestor"), home = join(ancestor, "ocx"), store = new RemoteMessageStore(home);
    mkdirSync(ancestor, { mode: 0o775 }); chmodSync(ancestor, 0o775); mkdirSync(home, { mode: 0o755 });
    expect(() => store.enable()).toThrow("trusted"); expect(existsSync(store.directory)).toBe(false);
    const missing = new RemoteMessageStore(join(ancestor, "missing"));
    expect(() => missing.enable()).toThrow("trusted"); expect(existsSync(join(ancestor, "missing"))).toBe(false);
    const target = join(root, "target"), redirect = join(root, "redirect");
    mkdirSync(target, { mode: 0o700 }); symlinkSync(target, redirect);
    expect(() => new RemoteMessageStore(redirect).enable()).toThrow("trusted");
    expect(existsSync(join(target, "messaging-remote"))).toBe(false);
    if (process.getuid!() !== 0) {
      const linkedAncestor = join(root, "linked-ancestor"); symlinkSync(root, linkedAncestor);
      expect(() => new RemoteMessageStore(join(linkedAncestor, "target")).enable()).toThrow("trusted");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
unixTest("read/list creates no home, identity, token or listener; enable is explicit and identity stable", async () => {
  const pair = remoteMessagingPair();
  const absent = new RemoteMessageStore(join(pair.a.root, "absent"));
  try {
    expect(absent.read()).toBeNull(); expect(absent.publicState()).toEqual({ protocol: "ocx-message-remote/1", enabled: false, peers: [] });
    expect(existsSync(join(pair.a.root, "absent"))).toBe(false);
    const first = pair.aStore.requireEnabled(); pair.aStore.disable();
    const next = pair.aStore.enable(first.port);
    expect(next.machine).toEqual(first.machine); expect(next.generation).not.toBe(first.generation);
    const json = JSON.stringify(pair.aStore.publicState());
    for (const key of [first.controlKey, first.peers[0]!.incoming, first.peers[0]!.outgoing]) expect(json).not.toContain(key);
    expect(statSync(pair.aStore.path).mode & 0o777).toBe(0o600);
  } finally { await pair.close(); }
});
unixTest("store schema refuses unknown fields, duplicate peers and excess aggregate peer count", async () => {
  const pair = remoteMessagingPair();
  try {
    const state = pair.aStore.requireEnabled();
    for (const next of [{ ...state, unknown: true }, { ...state, peers: [state.peers[0], state.peers[0]] },
      { ...state, peers: Array(5).fill(state.peers[0]) }, { ...state, port: 80 }, { ...state, controlKey: "bad" }]) {
      expect(() => parseRemoteState(next)).toThrow();
    }
    expect(() => pair.aStore.peer("work")).toThrow("unique");
  } finally { await pair.close(); }
});
unixTest("writable homes, redirected records, oversized files and live/crashed mutation locks fail closed", async () => {
  const pair = remoteMessagingPair();
  try {
    const directory = pair.aStore.directory;
    chmodSync(directory, 0o770); expect(() => pair.aStore.read()).toThrow("private"); chmodSync(directory, 0o700);
    symlinkSync(pair.aStore.path, join(directory, "redirect")); expect(() => readRemoteFile(join(directory, "redirect"))).toThrow("safely");
    writeFileSync(join(directory, "huge"), "x".repeat(128 * 1024 + 1), { mode: 0o600 });
    expect(() => readRemoteFile(join(directory, "huge"))).toThrow("unsafe");
    withRemoteLock(directory, () => expect(() => pair.aStore.mutate(() => {})).toThrow("locked"));
    mkdirSync(join(directory, "mutation.lock"), { mode: 0o700 });
    expect(() => pair.aStore.mutate(() => {})).toThrow("locked"); expect(pair.aStore.read()).not.toBeNull();
  } finally { await pair.close(); }
});
