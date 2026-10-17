import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity } from "../../src/messaging/remote-contract";
import { enrollRemoteHost, handleEnrollmentControl, type RemoteControlRunner } from "../../src/messaging/remote-enrollment";
import { abandonRemoteEnrollment, pendingRemoteEnrollment } from "../../src/messaging/remote-enrollment-recovery";
import { readRemoteFile, writeRemoteFile } from "../../src/messaging/remote-files";
import { remoteMessagingPair } from "../helpers/messaging-remote";

for (const mode of ["success", "lost", "malformed", "cancelled"] as const) {
  test.skipIf(process.platform === "win32")(`enrollment ${mode} keeps recovery semantics and removes only attempt-owned scratch`, async () => {
    const pair = remoteMessagingPair(), controller = new AbortController(), budget = new MessageBudget(30000, controller.signal);
    const capacity = new RemoteCapacity(), paths: string[] = [];
    pair.aStore.mutate(state => { state.peers = []; });
    pair.bStore.mutate(state => { state.peers = []; });
    const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
      if (argv[0] === "ssh-keygen") return "256 SHA256:fixture fake (ED25519)\n";
      const path = argv.find(arg => arg.startsWith("UserKnownHostsFile="))!.slice(19);
      if (stdin === undefined) { writeRemoteFile(path, "fixture ssh-ed25519 Zml4dHVyZQ==\n"); return ""; }
      paths.push(path);
      expect(existsSync(join(pair.aStore.directory, "mutation.lock"))).toBe(false);
      expect(path).toContain(JSON.parse(stdin).params.transaction);
      expect(readRemoteFile(path)).toBe("fixture ssh-ed25519 Zml4dHVyZQ==\n");
      const reply = handleEnrollmentControl(pair.bStore, JSON.parse(stdin));
      if (mode === "lost") throw new Error("lost fixture response");
      if (mode === "cancelled") controller.abort();
      return mode === "malformed" ? "{" : JSON.stringify(reply);
    };
    try {
      const operation = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner);
      if (mode === "success") {
        expect(await operation).toMatchObject({ inbound: "responses-only", outbound: "messages", enrolled: true });
        expect(pair.aStore.peer("worker").allowInbound).toBe(false);
        expect(pair.bStore.peer(pair.aStore.requireEnabled().machine.id).allowInbound).toBe(true);
        expect(pendingRemoteEnrollment(pair.aStore)).toBeNull();
      } else {
        await expect(operation).rejects.toMatchObject({ code: "enrollment_unknown" });
        expect(pendingRemoteEnrollment(pair.aStore)).not.toBeNull();
      }
      expect(paths).toHaveLength(1);
      expect(readRemoteFile(paths[0]!)).toBeNull();
      expect(readdirSync(pair.aStore.directory).filter(name => name.startsWith("enrollment_known_hosts"))).toEqual([]);
    } finally { budget.dispose(); await pair.close(); }
  });
}

test.skipIf(process.platform === "win32")("enrollment scratch cleanup is not blocked by another mutation owner", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; });
  pair.bStore.mutate(state => { state.peers = []; });
  const lock = join(pair.aStore.directory, "mutation.lock");
  let scratch = "";
  const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
    if (argv[0] === "ssh-keygen") return "256 SHA256:fixture fake (ED25519)\n";
    const path = argv.find(arg => arg.startsWith("UserKnownHostsFile="))!.slice(19);
    if (stdin === undefined) { writeRemoteFile(path, "fixture ssh-ed25519 Zml4dHVyZQ==\n"); return ""; }
    scratch = path;
    const reply = handleEnrollmentControl(pair.bStore, JSON.parse(stdin));
    mkdirSync(lock, { mode: 0o700 });
    return JSON.stringify(reply);
  };
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner))
      .rejects.toMatchObject({ code: "enrollment_unknown" });
    expect(readRemoteFile(scratch)).toBeNull();
    expect(existsSync(lock)).toBe(true);
    expect(pendingRemoteEnrollment(pair.aStore)).not.toBeNull();
  } finally { if (existsSync(lock)) rmdirSync(lock); budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("unconfirmed scratch removal is an explicit unknown receipt, never silent success", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; });
  pair.bStore.mutate(state => { state.peers = []; });
  const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
    if (argv[0] === "ssh-keygen") return "256 SHA256:fixture fake (ED25519)\n";
    const path = argv.find(arg => arg.startsWith("UserKnownHostsFile="))!.slice(19);
    if (stdin === undefined) { writeRemoteFile(path, "fixture ssh-ed25519 Zml4dHVyZQ==\n"); return ""; }
    const reply = handleEnrollmentControl(pair.bStore, JSON.parse(stdin));
    unlinkSync(path); mkdirSync(path, { mode: 0o700 });
    return JSON.stringify(reply);
  };
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner))
      .rejects.toMatchObject({ code: "remote_storage_unknown" });
    expect(pair.aStore.peer("worker").allowInbound).toBe(false);
    expect(pendingRemoteEnrollment(pair.aStore)).toBeNull();
  } finally { budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("abandoned and overlapping enrollment attempts cannot overwrite or remove each other's pinned keys", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; });
  pair.bStore.mutate(state => { state.peers = []; });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paths: string[] = [], keys: string[] = [], firstKeyDuringSecond: (string | null)[] = [];
  let nextKey = "first";
  const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
    if (argv[0] === "ssh-keygen") return "256 SHA256:fixture fake (ED25519)\n";
    const path = argv.find(arg => arg.startsWith("UserKnownHostsFile="))!.slice(19);
    if (!stdin) { writeRemoteFile(path, `fixture ssh-ed25519 ${nextKey}\n`); return ""; }
    paths.push(path); keys.push(readRemoteFile(path)!);
    if (paths.length === 1) { entered(); await gate; }
    // Record observations here; asserting inside the runner would be converted to enrollment_unknown.
    else firstKeyDuringSecond.push(readRemoteFile(paths[0]!));
    return JSON.stringify(handleEnrollmentControl(pair.bStore, JSON.parse(stdin)));
  };
  const first = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner);
  // Own both promise outcomes before releasing either asynchronous attempt.
  const firstResult = first.then(() => null, error => error);
  try {
    await ready;
    abandonRemoteEnrollment(pair.aStore, pendingRemoteEnrollment(pair.aStore)!.transaction);
    nextKey = "second";
    const second = await enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner);
    expect(paths[1]).not.toBe(paths[0]);
    expect(firstKeyDuringSecond).toEqual([keys[0]!]);
    expect(second.enrolled).toBe(true);
    expect(readRemoteFile(paths[0]!)).toBe(keys[0]!);
    expect(readRemoteFile(paths[1]!)).toBeNull();
    release();
    expect(await firstResult).toMatchObject({ code: "enrollment_unknown" });
    expect(readRemoteFile(paths[0]!)).toBeNull();
    expect(pair.aStore.peer("worker").hostKey).toBe("fixture ssh-ed25519 second\n");
  } finally { release(); await Promise.allSettled([first]); budget.dispose(); await pair.close(); }
});
