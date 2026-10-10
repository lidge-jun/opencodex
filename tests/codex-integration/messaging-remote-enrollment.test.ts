import { expect, test } from "bun:test";
import { readRemoteFile, writeRemoteFile } from "../../src/messaging/remote-files";
import { MessageBudget } from "../../src/messaging/budget";
import { capability, RemoteCapacity, REMOTE_PROTOCOL } from "../../src/messaging/remote-contract";
import { enrollRemoteHost, handleEnrollmentControl, removeRemoteHost, type RemoteControlRunner } from "../../src/messaging/remote-enrollment";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { join } from "node:path";
import { abandonRemoteEnrollment, pendingRemoteEnrollment } from "../../src/messaging/remote-enrollment-recovery";
import { parseRemoteMessageArgs } from "../../src/cli/message-remote-args";
import { repoPath } from "../helpers/repo-root";

test.skipIf(process.platform === "win32")("CLI abandonment reports unconfirmed remote cleanup and never changes an enrolled peer", async () => {
  const pair = remoteMessagingPair(), state = pair.aStore.requireEnabled(), peer = pair.aStore.peer("worker");
  const transaction = crypto.randomUUID(), key = capability();
  writeRemoteFile(join(pair.aStore.directory, "enrollment.json"), JSON.stringify({ alias: "pending", ssh: "fixture",
    fingerprint: "SHA256:fixture", generation: state.generation, request: { protocol: REMOTE_PROTOCOL, action: "enroll",
      params: { machine: state.machine, transaction, returnCapability: key, port: state.port } } }));
  const script = `const { runMessageCommand } = await import(${JSON.stringify(repoPath("src/cli/message-command.ts"))});
    Bun.spawn = () => { throw new Error("unexpected SSH or helper"); };
    process.exitCode = await runMessageCommand(["hosts", "abandon", "--transaction", ${JSON.stringify(transaction)}, "--json"]);`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, OPENCODEX_HOME: join(pair.a.root, "ocx") }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(3); expect(err).toBe(""); expect(JSON.parse(out)).toMatchObject({ transaction, locallyAbandoned: true, remote: "unconfirmed" });
    expect(out).not.toContain(key); expect(pair.aStore.peer("worker")).toEqual(peer); expect(pendingRemoteEnrollment(pair.aStore)).toBeNull();
  } finally { await pair.close(); }
});

test.skipIf(process.platform === "win32")("malformed recovery metadata cannot authorize abandonment", async () => {
  const pair = remoteMessagingPair();
  const path = join(pair.aStore.directory, "enrollment.json"), text = JSON.stringify({ secret: capability() });
  try {
    writeRemoteFile(path, text);
    expect(() => pendingRemoteEnrollment(pair.aStore)).toThrow("cannot be safely interpreted");
    expect(() => abandonRemoteEnrollment(pair.aStore, crypto.randomUUID())).toThrow("cannot be safely interpreted");
    expect(readRemoteFile(path)).toBe(text);
  } finally { await pair.close(); }
});

test("pending enrollment abandonment requires one exact transaction UUID and no extra grammar", () => {
  const transaction = crypto.randomUUID();
  expect(parseRemoteMessageArgs(["hosts", "abandon", "--transaction", transaction, "--json"]))
    .toEqual({ action: "hosts-abandon", transaction, json: true });
  for (const argv of [["hosts", "abandon"], ["hosts", "abandon", "worker"],
    ["hosts", "abandon", "--transaction", "worker"], ["hosts", "abandon", "--transaction", transaction, "--ssh", "fixture"],
    ["hosts", "abandon", "--transaction", transaction, "--transaction", transaction]]) expect(parseRemoteMessageArgs(argv)).toBeNull();
});

test("transaction-qualified removal rejects malformed and duplicate guards while preserving ordinary syntax", () => {
  const transaction = crypto.randomUUID();
  expect(parseRemoteMessageArgs(["hosts", "remove", "worker", "--json"]))
    .toEqual({ action: "hosts-remove", host: "worker", json: true });
  expect(parseRemoteMessageArgs(["hosts", "remove", "worker", "--transaction", transaction, "--json"]))
    .toEqual({ action: "hosts-remove", host: "worker", transaction, json: true });
  for (const argv of [["hosts", "remove", "worker", "--transaction"],
    ["hosts", "remove", "worker", "--transaction", "worker"],
    ["hosts", "remove", "worker", "--transaction", transaction, "--transaction", transaction]]) {
    expect(parseRemoteMessageArgs(argv)).toBeNull();
  }
});

for (const receiptSource of ["remove", "abandon"] as const) {
  test.skipIf(process.platform === "win32")(`old ${receiptSource} cleanup receipt cannot revoke a replacement enrollment or journal`, async () => {
    const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
    pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
    const ssh = fakeSsh(pair, receiptSource === "abandon");
    const add = () => enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner);
    let runners = 0;
    const cleanup: RemoteControlRunner = async (_argv, _budget, _capacity, stdin) => {
      runners++; return JSON.stringify(handleEnrollmentControl(pair.aStore, JSON.parse(stdin!)));
    };
    try {
      let receipt: { remoteCleanupCommand?: string }, oldTransaction: string;
      if (receiptSource === "abandon") {
        await expect(add()).rejects.toThrow("retained");
        oldTransaction = pendingRemoteEnrollment(pair.aStore)!.transaction;
        receipt = abandonRemoteEnrollment(pair.aStore, oldTransaction);
      } else {
        await add(); oldTransaction = pair.aStore.peer("worker").transaction;
        receipt = await removeRemoteHost(pair.aStore, "worker", budget, capacity, async () => { throw new Error("lost"); });
      }
      const machineId = pair.aStore.requireEnabled().machine.id;
      handleEnrollmentControl(pair.bStore, { protocol: REMOTE_PROTOCOL, action: "remove", params: { machineId, transaction: oldTransaction } });
      await add();
      const replacement = pair.bStore.peer(machineId);
      expect(replacement.transaction).not.toBe(oldTransaction);
      pair.bStore.mutate(state => { Object.assign(state.peers[0]!, { ssh: "fixture", hostKey: "fixture ssh-ed25519 Zml4dHVyZQ==\n", fingerprint: "SHA256:fixture" }); });
      const state = pair.bStore.requireEnabled(), journalPath = join(pair.bStore.directory, "enrollment.json");
      writeRemoteFile(journalPath, JSON.stringify({ alias: "pending", ssh: "fixture", fingerprint: "SHA256:fixture",
        generation: state.generation, request: { protocol: REMOTE_PROTOCOL, action: "enroll", params: {
          machine: state.machine, transaction: replacement.transaction, returnCapability: capability(), port: state.port } } }));
      const beforeA = readRemoteFile(pair.aStore.path), beforeB = readRemoteFile(pair.bStore.path), journal = readRemoteFile(journalPath);
      const parsed = parseRemoteMessageArgs(receipt.remoteCleanupCommand!.split(" ").slice(2));
      expect(parsed).toEqual({ action: "hosts-remove", host: machineId, transaction: oldTransaction, json: true });
      if (parsed?.action !== "hosts-remove") throw new Error("fixture cleanup command did not parse");
      for (const guard of [parsed.transaction, "malformed"]) {
        await expect(removeRemoteHost(pair.bStore, parsed.host, budget, capacity, cleanup, undefined, guard))
          .rejects.toMatchObject({ code: "enrollment_conflict" });
        expect(readRemoteFile(pair.aStore.path)).toBe(beforeA); expect(readRemoteFile(pair.bStore.path)).toBe(beforeB);
        expect(readRemoteFile(journalPath)).toBe(journal); expect(runners).toBe(0);
      }
      const removed = await removeRemoteHost(pair.bStore, machineId, budget, capacity, cleanup, undefined, replacement.transaction);
      expect(removed.remote).toBe("removed"); expect(runners).toBe(1);
      expect(pair.aStore.requireEnabled().peers).toHaveLength(0); expect(pair.bStore.requireEnabled().peers).toHaveLength(0);
      expect(readRemoteFile(journalPath)).toBeNull();
    } finally { budget.dispose(); await pair.close(); }
  });
}

test.skipIf(process.platform === "win32")("receiver capacity is a correlated refusal, retains recoverable intent and preserves idempotent enrollment", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; });
  pair.bStore.mutate(state => {
    while (state.peers.length < 4) state.peers.push({ ...state.peers[0]!, alias: `peer-${state.peers.length}`,
      machine: { id: crypto.randomUUID(), name: "fixture" }, transaction: crypto.randomUUID(), incoming: capability(), outgoing: capability() });
  });
  const ssh = fakeSsh(pair);
  // Ensure the initial peer is not the enrollment's candidate, otherwise its identity correctly conflicts.
  pair.bStore.mutate(state => { state.peers[0]!.machine.id = crypto.randomUUID(); state.peers[0]!.alias = "existing"; });
  const full = readRemoteFile(pair.bStore.path);
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner))
      .rejects.toMatchObject({ code: "peer_capacity" });
    expect(readRemoteFile(pair.bStore.path)).toBe(full); expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    const pending = pendingRemoteEnrollment(pair.aStore)!;
    expect(pending).toEqual({ alias: "worker", transaction: (ssh.requests[0] as { params: { transaction: string } }).params.transaction, stale: false });
    const rejected = handleEnrollmentControl(pair.bStore, ssh.requests[0]) as Record<string, unknown>;
    expect(rejected).toEqual({ protocol: REMOTE_PROTOCOL, transaction: pending.transaction, rejected: "peer_capacity" });
    pair.bStore.mutate(state => { state.peers.pop(); });
    await enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner);
    expect(handleEnrollmentControl(pair.bStore, ssh.requests[0])).toHaveProperty("capability");
    expect(pair.bStore.requireEnabled().peers).toHaveLength(4); expect(pendingRemoteEnrollment(pair.aStore)).toBeNull();
  } finally { budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("explicit abandon works across disabled and stale generations without replay or peer mutation", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity(), ssh = fakeSsh(pair, true);
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner)).rejects.toThrow("retained");
    const pending = pendingRemoteEnrollment(pair.aStore)!;
    expect(() => abandonRemoteEnrollment(pair.aStore, crypto.randomUUID())).toThrow("changed");
    expect(pendingRemoteEnrollment(pair.aStore)).toEqual(pending);
    pair.aStore.disable(); expect(pendingRemoteEnrollment(pair.aStore)?.stale).toBe(true);
    const receipt = abandonRemoteEnrollment(pair.aStore, pending.transaction);
    expect(receipt.remote).toBe("unconfirmed"); expect(receipt.locallyAbandoned).toBe(true);
    expect(receipt.remoteCleanupCommand).toBe(`ocx message hosts remove ${pair.aStore.read()!.machine.id} --transaction ${pending.transaction} --json`);
    expect(pendingRemoteEnrollment(pair.aStore)).toBeNull(); expect(ssh.controls).toBe(1);
    expect(pair.bStore.requireEnabled().peers).toHaveLength(1);
    const port = pair.aStore.read()!.port; pair.aStore.enable(port);
    expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    // The next command is permitted to create a new transaction, not replay the abandoned one.
    pair.bStore.mutate(state => { state.peers = []; });
    await enrollRemoteHost(pair.aStore, "another", "fixture", "SHA256:fixture", budget, capacity, ssh.runner);
    expect((ssh.requests[1] as { params: { transaction: string } }).params.transaction).not.toBe(pending.transaction);
  } finally { budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("abandoned in-flight enrollment cannot republish or erase a replacement journal", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity(), ssh = fakeSsh(pair);
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  const first = pausedControl(ssh.runner), one = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, first.runner);
  void one.catch(() => {}); await first.ready;
  const pending = pendingRemoteEnrollment(pair.aStore)!;
  try {
    abandonRemoteEnrollment(pair.aStore, pending.transaction);
    // Remote cleanup is explicit and separate from local abandonment.
    pair.bStore.mutate(state => { state.peers = []; });
    const second = pausedControl(ssh.runner, true), two = enrollRemoteHost(pair.aStore, "replacement", "fixture", "SHA256:fixture", budget, capacity, second.runner);
    void two.catch(() => {}); await second.ready;
    try {
      const replacement = readRemoteFile(join(pair.aStore.directory, "enrollment.json"));
      expect(() => abandonRemoteEnrollment(pair.aStore, pending.transaction)).toThrow("changed");
      first.release(); await expect(one).rejects.toThrow("completion is uncertain");
      expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBe(replacement);
      second.release(); await expect(two).rejects.toThrow("retained");
      expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    } finally { second.release(); await two.catch(() => {}); }
  } finally { first.release(); await one.catch(() => {}); budget.dispose(); await pair.close(); }
});

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

function pausedControl(runner: RemoteControlRunner, loseReply = false) {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const paused: RemoteControlRunner = async (...args) => {
    const result = await runner(...args);
    if (args[3]) { entered(); await gate; if (loseReply) throw new Error("lost fixture reply"); }
    return result;
  };
  return { ready, release, runner: paused };
}

test.skipIf(process.platform === "win32")("SSH control removal revokes a pending enrollment before either overlapping completion publishes", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  const ssh = fakeSsh(pair), first = pausedControl(ssh.runner), second = pausedControl(ssh.runner);
  const one = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, first.runner);
  void one.catch(() => {}); await first.ready;
  const two = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, second.runner);
  void two.catch(() => {}); await second.ready;
  try {
    const pending = JSON.parse(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))!);
    handleEnrollmentControl(pair.aStore, { protocol: REMOTE_PROTOCOL, action: "remove",
      params: { machineId: pair.bStore.requireEnabled().machine.id, transaction: pending.request.params.transaction } });
    expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBeNull();
    first.release(); second.release();
    await expect(one).rejects.toThrow("completion is uncertain");
    await expect(two).rejects.toThrow("completion is uncertain");
    expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
  } finally { first.release(); second.release(); await Promise.allSettled([one, two]); budget.dispose(); await pair.close(); }
});

for (const removal of ["local", "control"] as const) {
  test.skipIf(process.platform === "win32")(`failed ${removal} journal invalidation cannot publish peer absence and remains explicitly retryable`, async () => {
    const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
    pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
    const ssh = fakeSsh(pair), paused = pausedControl(ssh.runner);
    const first = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner);
    await first;
    const peer = pair.aStore.peer("worker");
    const journal = { alias: "worker", ssh: "fixture", fingerprint: "SHA256:fixture", generation: pair.aStore.requireEnabled().generation,
      request: ssh.requests[0] };
    // Model successful enrollment publication with its recovery journal left behind.
    writeRemoteFile(join(pair.aStore.directory, "enrollment.json"), JSON.stringify(journal));
    const delayed = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, paused.runner);
    void delayed.catch(() => {}); await paused.ready;
    const request = { protocol: REMOTE_PROTOCOL, action: "remove", params: { machineId: peer.machine.id, transaction: peer.transaction } };
    const deny = () => { throw new Error("fixture journal unlink denied"); };
    try {
      if (removal === "local") await expect(removeRemoteHost(pair.aStore, "worker", budget, capacity, async () => { throw new Error("lost"); }, deny)).rejects.toThrow("unlink denied");
      else expect(() => handleEnrollmentControl(pair.aStore, request, deny)).toThrow("unlink denied");
      expect(pair.aStore.peer("worker").transaction).toBe(peer.transaction);
      expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).not.toBeNull();
      if (removal === "local") await removeRemoteHost(pair.aStore, "worker", budget, capacity, async () => { throw new Error("lost"); });
      else handleEnrollmentControl(pair.aStore, request);
      expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBeNull();
      paused.release(); await expect(delayed).rejects.toThrow("completion is uncertain");
      expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    } finally { paused.release(); await delayed.catch(() => {}); budget.dispose(); await pair.close(); }
  });
}

for (const revoke of ["local", "control"] as const) {
  test.skipIf(process.platform === "win32")(`delayed enrollment cannot restore ${revoke} revocation or a retained recovery journal`, async () => {
    const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
    pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
    const ssh = fakeSsh(pair), first = pausedControl(ssh.runner), second = pausedControl(ssh.runner);
    const add = (runner: RemoteControlRunner) => enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, runner);
    const one = add(first.runner); await first.ready;
    const saved = readRemoteFile(join(pair.aStore.directory, "enrollment.json"))!;
    const two = add(second.runner); void two.catch(() => {}); await second.ready;
    try {
      first.release(); await one;
      // Simulate publication succeeding with journal cleanup left to recovery.
      writeRemoteFile(join(pair.aStore.directory, "enrollment.json"), saved);
      const peer = pair.aStore.peer("worker");
      if (revoke === "local") await removeRemoteHost(pair.aStore, "worker", budget, capacity, async () => { throw new Error("lost"); });
      else handleEnrollmentControl(pair.aStore, { protocol: REMOTE_PROTOCOL, action: "remove",
        params: { machineId: peer.machine.id, transaction: peer.transaction } });
      expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBeNull();
      second.release(); await expect(two).rejects.toThrow("completion is uncertain");
      expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    } finally { first.release(); second.release(); await Promise.allSettled([one, two]); budget.dispose(); await pair.close(); }
  });
}

test.skipIf(process.platform === "win32")("old enrollment completion cannot delete a newer lost-reply recovery transaction", async () => {
  const pair = remoteMessagingPair(), third = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  third.bStore.mutate(state => { state.peers = []; });
  const ssh = fakeSsh(pair), first = pausedControl(ssh.runner), second = pausedControl(ssh.runner);
  const one = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, first.runner);
  await first.ready;
  const two = enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, second.runner);
  await second.ready; first.release(); await one;
  const otherSsh = fakeSsh(third), other = pausedControl(otherSsh.runner, true);
  const next = enrollRemoteHost(pair.aStore, "third", "fixture", "SHA256:fixture", budget, capacity, other.runner);
  void next.catch(() => {}); await other.ready;
  try {
    const pending = readRemoteFile(join(pair.aStore.directory, "enrollment.json"));
    second.release(); await two;
    expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBe(pending);
    other.release(); await expect(next).rejects.toThrow("retained");
    await enrollRemoteHost(pair.aStore, "third", "fixture", "SHA256:fixture", budget, capacity, otherSsh.runner);
    expect(otherSsh.requests[1]).toEqual(otherSsh.requests[0]);
    expect(pair.aStore.requireEnabled().peers).toHaveLength(2);
  } finally { first.release(); second.release(); other.release(); await Promise.allSettled([one, two, next]); budget.dispose(); await Promise.all([pair.close(), third.close()]); }
});

test.skipIf(process.platform === "win32")("disable and re-enable cannot adopt an earlier generation's pending enrollment", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  const ssh = fakeSsh(pair, true);
  try {
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner)).rejects.toThrow("retained");
    const port = pair.aStore.requireEnabled().port; pair.aStore.disable(); pair.aStore.enable(port);
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", "SHA256:fixture", budget, capacity, ssh.runner)).rejects.toThrow("reconcile it explicitly");
    expect(ssh.controls).toBe(1); expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
  } finally { budget.dispose(); await pair.close(); }
});

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
    const transaction = pair.aStore.peer("worker").transaction;
    const receipt = await removeRemoteHost(pair.aStore, "worker", budget, capacity, async () => { throw new Error("lost"); });
    expect(receipt.locallyRemoved).toBe(true); expect(receipt.remote).toBe("unconfirmed");
    expect(pair.aStore.requireEnabled().peers).toHaveLength(0);
    expect(receipt.remoteCleanupCommand).toBe(`ocx message hosts remove ${pair.aStore.requireEnabled().machine.id} --transaction ${transaction} --json`);
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
