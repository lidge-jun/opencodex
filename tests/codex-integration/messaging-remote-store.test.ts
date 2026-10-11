import { expect, test } from "bun:test";
import { chmodSync, existsSync, fsyncSync, fstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteMessageStore, parseRemoteState } from "../../src/messaging/remote-store";
import { readRemoteFile, removeRemoteFile, withRemoteLock, writeRemoteFile } from "../../src/messaging/remote-files";
import { remoteMessagingPair } from "../helpers/messaging-remote";

const unixTest = test.skipIf(process.platform === "win32");
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
