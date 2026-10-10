import { expect, test } from "bun:test";
import { readRemoteFile, writeRemoteFile } from "../../src/messaging/remote-files";
import { MessageBudget } from "../../src/messaging/budget";
import { capability, RemoteCapacity, REMOTE_PROTOCOL } from "../../src/messaging/remote-contract";
import { enrollRemoteHost, handleEnrollmentControl, removeRemoteHost, type RemoteControlRunner } from "../../src/messaging/remote-enrollment";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { join } from "node:path";

function fakeSsh(pair: ReturnType<typeof remoteMessagingPair>, loseFirst = false) {
  let controls = 0;
  const requests: unknown[] = [];
  const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
    if (argv[0] === "ssh-keygen") return "256 SHA256:fixture fake (ED25519)\n";
    const known = argv.find(arg => arg.startsWith("UserKnownHostsFile="))?.slice("UserKnownHostsFile=".length);
    if (argv.at(-1) === "true") { writeRemoteFile(known!, "fixture ssh-ed25519 Zml4dHVyZQ==\n"); return ""; }
    if (!stdin) throw new Error("fixture missing private stdin");
    const request = JSON.parse(stdin); requests.push(request); controls++;
    const reply = handleEnrollmentControl(pair.bStore, request);
    if (loseFirst && controls === 1) throw new Error("lost control receipt");
    return JSON.stringify(reply);
  };
  return { runner, requests, get controls() { return controls; } };
}

test.skipIf(process.platform === "win32")("enrollment is receiver-issued, explicit, idempotent by transaction and never overwrites a peer", async () => {
  const pair = remoteMessagingPair(), state = pair.aStore.requireEnabled(), transaction = crypto.randomUUID(), key = capability();
  const request = { protocol: REMOTE_PROTOCOL, action: "enroll", params: { machine: state.machine, transaction, returnCapability: key, port: state.port } };
  try {
    expect(() => handleEnrollmentControl(pair.bStore, request)).toThrow("replaced");
    pair.bStore.mutate(current => { current.peers = []; });
    const first = handleEnrollmentControl(pair.bStore, request), again = handleEnrollmentControl(pair.bStore, request);
    expect(again).toEqual(first); expect(pair.bStore.requireEnabled().peers).toHaveLength(1);
    expect(() => handleEnrollmentControl(pair.bStore, { ...request, params: { ...request.params, returnCapability: capability() } })).toThrow("replaced");
    pair.bStore.disable(); expect(() => handleEnrollmentControl(pair.bStore, request)).toThrow("enable");
  } finally { await pair.close(); }
});

test.skipIf(process.platform === "win32")("lost enrollment reply retains transaction; repeating the exact command reconciles rather than replaces credentials", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  const ssh = fakeSsh(pair, true);
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner)).rejects.toThrow("retained");
    const pending = readRemoteFile(join(pair.aStore.directory, "enrollment.json")); expect(pending).not.toBeNull();
    const remoteKey = pair.bStore.requireEnabled().peers[0]!.incoming;
    const receipt = await enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner);
    expect(receipt.enrolled).toBe(true); expect(ssh.requests[1]).toEqual(ssh.requests[0]);
    expect(pair.aStore.peer("worker").outgoing).toBe(remoteKey);
    expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain(remoteKey);
    expect(pair.bStore.requireEnabled().peers).toHaveLength(1);
  } finally { budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("unconfirmed fingerprint sends no capabilities; local removal never restores authority after lost remote cleanup", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity(), ssh = fakeSsh(pair);
  try {
    await expect(enrollRemoteHost(pair.aStore, "new", "fixture", "SHA256:other", budget, capacity, ssh.runner)).rejects.toThrow("confirmed");
    expect(ssh.controls).toBe(0);
    pair.aStore.mutate(state => { Object.assign(state.peers[0]!, { ssh: "fixture", hostKey: "fixture ssh-ed25519 Zml4dHVyZQ==\n", fingerprint: "SHA256:fixture" }); });
    const receipt = await removeRemoteHost(pair.aStore, "worker", budget, capacity, async () => { throw new Error("lost"); });
    expect(receipt.locallyRemoved).toBe(true); expect(receipt.remote).toBe("unconfirmed");
    expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    expect(receipt.remoteCleanupCommand).toBe(`ocx message hosts remove ${pair.aStore.requireEnabled().machine.id} --json`);
  } finally { budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("post-commit cancellation preserves reconciliation and a full local registry sends no enrollment", async () => {
  const pair = remoteMessagingPair(), controller = new AbortController(), budget = new MessageBudget(30000, controller.signal);
  const capacity = new RemoteCapacity(), ssh = fakeSsh(pair);
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  const runner: RemoteControlRunner = async (...args) => {
    const result = await ssh.runner(...args);
    if (args[3]) controller.abort();
    return result;
  };
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner)).rejects.toThrow("completion is uncertain");
    expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).not.toBeNull();
    expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    const fresh = new MessageBudget();
    try { await enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", fresh, capacity, ssh.runner); }
    finally { fresh.dispose(); }
    expect(ssh.requests[1]).toEqual(ssh.requests[0]);
    pair.aStore.mutate(state => {
      const peer = state.peers[0]!;
      for (let i = 0; i < 3; i++) state.peers.push({ ...peer, alias: `extra-${i}`, machine: { id: crypto.randomUUID(), name: "fixture" }, transaction: crypto.randomUUID() });
    });
    const full = new MessageBudget(), controls = ssh.controls;
    try { await expect(enrollRemoteHost(pair.aStore, "extra", "fixture", "SHA256:fixture", full, capacity, ssh.runner)).rejects.toThrow("Remove"); }
    finally { full.dispose(); }
    expect(ssh.controls).toBe(controls);
    expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBeNull();
  } finally { budget.dispose(); await pair.close(); }
});
