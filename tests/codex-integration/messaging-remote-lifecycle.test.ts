import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity, remoteError } from "../../src/messaging/remote-contract";
import { remoteControl, peerEndpoint } from "../../src/messaging/remote-auth";
import { remotePortCandidate } from "../../src/messaging/remote-ports";
import { runRemoteHelper, spawnRemoteHelper } from "../../src/messaging/remote-process";
import { resolveRemoteRoute, startRemoteOwner } from "../../src/messaging/remote-owner";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { parseRemoteMessageArgs } from "../../src/cli/message-remote-args";
import { repoPath } from "../helpers/repo-root";

test("every remote module remains inert on import", async () => {
  const modules = ["contract", "files", "store", "process", "auth", "rpc-admission", "bridge", "ports", "tunnels", "owner", "enrollment", "send"];
  const script = `const fail = () => { throw new Error("unexpected activation"); };
    globalThis.setTimeout = fail; globalThis.setInterval = fail; Bun.spawn = fail; Bun.serve = fail; Bun.listen = fail;
    globalThis.WebSocket = class { constructor() { fail(); } };
    for (const file of JSON.parse(process.argv[1])) await import(file);`;
  const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify(modules.map(name => repoPath(`src/messaging/remote-${name}.ts`)))], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(out).toBe(""); expect(err).toBe("");
  expect(readFileSync(repoPath("src/cli/message-command.ts"), "utf8")).toContain('if (remote) return (await import("./message-remote-command"))');
});

for (const rejectCleanup of [false, true]) {
  test.skipIf(process.platform === "win32")(`unpublished tunnels join both helpers on generation change (cleanup rejection=${rejectCleanup})`, async () => {
    const pair = remoteMessagingPair(), closes: (() => Promise<void>)[] = [], completed: number[] = [];
    pair.aStore.mutate(state => { Object.assign(state.peers[0]!, { ssh: "fixture", hostKey: "fixture ssh-ed25519 Zml4dHVyZQ==\n", fingerprint: "SHA256:fixture" }); });
    try {
      const result = startRemoteOwner(pair.aStore, pair.a.codexHome, ["worker"], undefined, {
        run: async () => JSON.stringify({ port: pair.bStore.requireEnabled().port }),
        spawn: (argv, capacity) => {
          const index = closes.length, free = capacity.reserve("helpers");
          const forward = argv.indexOf("-L");
          const listener = forward >= 0 ? Bun.listen({ hostname: "127.0.0.1", port: Number(argv[forward + 1]!.split(":")[1]), socket: { data(socket) { socket.end(); } } }) : undefined;
          let finish!: (code: number) => void, closing: Promise<void> | undefined;
          const exited = new Promise<number>(resolve => { finish = resolve; });
          const close = () => closing ??= (async () => {
            await Bun.sleep(index === 0 ? 10 : 80);
            listener?.stop(true); completed.push(index); free(); finish(0);
            if (rejectCleanup && index === 0) throw remoteError("cleanup_incomplete", "fixture cleanup incomplete");
          })();
          closes.push(close);
          if (index === 1) pair.aStore.mutate(state => { state.generation = crypto.randomUUID(); });
          return { pid: 0, exited, output: Promise.resolve(""), close };
        },
      });
      await expect(result).rejects.toThrow(rejectCleanup ? "fixture cleanup incomplete" : "configuration changed");
      expect(completed.sort()).toEqual([0, 1]);
    } finally { await Promise.allSettled(closes.map(close => close())); await pair.close(); }
  });
}

for (const [rejectCleanup, deliberateRemoval] of [[false, false], [true, false], [false, true]] as const) {
  test.skipIf(process.platform === "win32")(`retired published tunnels remain owned until both helpers close (cleanup rejection=${rejectCleanup}, peer removal=${deliberateRemoval})`, async () => {
    const pair = remoteMessagingPair(), closes: (() => Promise<void>)[] = [], exits: (() => void)[] = [], completed: number[] = [];
    const other = deliberateRemoval ? remoteMessagingPair() : undefined;
    pair.aStore.mutate(state => { Object.assign(state.peers[0]!, { ssh: "fixture", hostKey: "fixture ssh-ed25519 Zml4dHVyZQ==\n", fingerprint: "SHA256:fixture" }); });
    let releaseSibling!: () => void, siblingClosing!: () => void;
    const gate = new Promise<void>(resolve => { releaseSibling = resolve; });
    const started = new Promise<void>(resolve => { siblingClosing = resolve; });
    let owner: Awaited<ReturnType<typeof startRemoteOwner>> | undefined, receiver: typeof owner, otherOwner: typeof owner;
    const budget = new MessageBudget();
    try {
      receiver = await startRemoteOwner(pair.bStore, pair.b.codexHome, []);
      const receiverPort = receiver.port;
      owner = await startRemoteOwner(pair.aStore, pair.a.codexHome, ["worker"], undefined, {
        run: async () => JSON.stringify({ port: pair.aStore.requireEnabled().port }),
        spawn: (argv, capacity) => {
          const index = closes.length, free = capacity.reserve("helpers"), sockets = new Set<Socket>();
          const forward = argv.indexOf("-L");
          // Only the outbound path needs forwarding; the return path reaches this isolated owner's listener directly.
          const listener = forward < 0 ? undefined : createServer(incoming => {
            const outgoing = connect(receiverPort, "127.0.0.1");
            for (const socket of [incoming, outgoing]) {
              sockets.add(socket); socket.on("close", () => sockets.delete(socket));
              socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
            }
            incoming.pipe(outgoing).pipe(incoming);
          }).listen(Number(argv[forward + 1]!.split(":")[1]), "127.0.0.1");
          let finish!: (code: number) => void, closing: Promise<void> | undefined;
          const exited = new Promise<number>(resolve => { finish = resolve; });
          const close = () => closing ??= (async () => {
            if (index === 1) { siblingClosing(); await gate; }
            for (const socket of sockets) socket.destroy();
            if (listener) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
            completed.push(index); free(); finish(0);
            if (rejectCleanup && index === 1) throw remoteError("cleanup_incomplete", "fixture cleanup incomplete");
          })();
          closes.push(close); exits.push(() => finish(0));
          return { pid: 0, exited, output: Promise.resolve(""), close };
        },
      });
      await resolveRemoteRoute(pair.aStore, "worker", budget);
      await expect(remoteControl(pair.bStore.requireEnabled(),
        peerEndpoint(pair.bStore.peer(pair.aStore.requireEnabled().machine.id), owner.port), "message/lease",
        { port: receiverPort, generation: crypto.randomUUID() }, budget)).rejects.toThrow();
      if (other) {
        const transaction = crypto.randomUUID(), machine = other.bStore.requireEnabled().machine;
        const original = pair.aStore.peer("worker"), remote = pair.bStore.peer(pair.aStore.requireEnabled().machine.id);
        pair.aStore.mutate(state => { state.peers.push({ ...original, alias: "colleague", machine, transaction,
          port: other.bStore.requireEnabled().port, ssh: null, hostKey: null, fingerprint: null }); });
        other.bStore.mutate(state => { state.peers = [{ ...remote, transaction }]; });
        otherOwner = await startRemoteOwner(other.bStore, other.b.codexHome, []);
        await remoteControl(other.bStore.requireEnabled(), peerEndpoint(other.bStore.peer(remote.machine.id), owner.port),
          "message/lease", { port: otherOwner.port, generation: crypto.randomUUID() }, budget);
        pair.aStore.mutate(state => { state.peers = state.peers.filter(peer => peer.alias !== "worker"); });
      } else exits[0]!();
      await started;
      await expect(resolveRemoteRoute(pair.aStore, "worker", budget)).rejects.toThrow();
      // The unexpected exit itself must retire the owner, without an explicit caller close.
      const settled = owner.finished.then(() => "closed", () => "rejected");
      expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending");
      expect(completed).not.toContain(1);
      releaseSibling();
      if (other) {
        await closes[1]!();
        const route = await resolveRemoteRoute(pair.aStore, "colleague", budget);
        expect(route.endpoint.port).toBe(otherOwner!.port);
        expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending");
        await owner.close();
      }
      if (rejectCleanup) {
        await expect(owner.finished).rejects.toThrow("cleanup did not complete cleanly");
        await expect(owner.close()).rejects.toThrow("cleanup did not complete cleanly");
      } else { await owner.finished; await owner.close(); }
      expect(owner.close()).toBe(owner.close());
      expect(completed.sort()).toEqual([0, 1]);
      expect(owner.capacity.snapshot().helpers).toBe(0);
    } finally {
      releaseSibling(); budget.dispose();
      await Promise.allSettled([owner?.close(), receiver?.close(), otherOwner?.close(), ...closes.map(close => close())]);
      await Promise.all([pair.close(), other?.close()]);
    }
  }, 15000);
}

test.skipIf(process.platform === "win32")("an immediate restart replaces only a stale return path and rejects old-generation renewals", async () => {
  const pair = remoteMessagingPair(), generation = crypto.randomUUID(), nextGeneration = crypto.randomUUID();
  let source: Awaited<ReturnType<typeof startRemoteOwner>> | undefined, receiver: typeof source;
  const sockets = new Set<Socket>();
  const alternative = createServer(incoming => {
    const outgoing = connect(source!.port, "127.0.0.1");
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  const budget = new MessageBudget();
  const lease = (port: number, generation: string) => remoteControl(pair.aStore.requireEnabled(),
    peerEndpoint(pair.aStore.peer("worker"), receiver!.port), "message/lease", { port, generation }, budget);
  try {
    source = await startRemoteOwner(pair.aStore, pair.a.codexHome, []);
    receiver = await startRemoteOwner(pair.bStore, pair.b.codexHome, []);
    await lease(source.port, generation);
    await expect(lease(source.port, nextGeneration)).rejects.toThrow();
    const alternativePort = remotePortCandidate();
    await new Promise<void>(resolve => alternative.listen(alternativePort, "127.0.0.1", resolve));
    // A second proven port cannot replace an unexpired generation while its original path authenticates.
    await expect(lease(alternativePort, nextGeneration)).rejects.toThrow();
    const oldPort = source.port;
    await source.close();
    pair.aStore.mutate(state => { state.port = remotePortCandidate(); });
    source = await startRemoteOwner(pair.aStore, pair.a.codexHome, []);
    expect(source.port).not.toBe(oldPort);
    expect(await lease(source.port, nextGeneration)).toEqual({ leased: true, generation: nextGeneration });
    for (let attempt = 0; attempt < 2; attempt++) await expect(lease(source.port, generation)).rejects.toThrow();
    await expect(lease(oldPort, generation)).rejects.toThrow();
    const route = await resolveRemoteRoute(pair.bStore, pair.aStore.requireEnabled().machine.id, budget);
    expect(route.endpoint.port).toBe(source.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (alternative.listening) await new Promise<void>(resolve => alternative.close(() => resolve()));
    budget.dispose(); await Promise.allSettled([source?.close(), receiver?.close()]); await pair.close();
  }
});

test("remote parser rejects ambiguous/malformed usage without runtime allocation", () => {
  for (const args of [["enable", "--port", "80"], ["serve", "--host", "a", "--host", "a"],
    ["hosts", "add", "bad alias", "--ssh", "fixture", "--fingerprint", "SHA256:fixture"],
    ["hosts", "probe", "--ssh", "-option"], ["send", "--host", "worker", "--stdin"],
    ["sessions", "--host", "worker", "--host", "other"], ["status", "--token", "secret"]]) expect(parseRemoteMessageArgs(args)).toBeNull();
  expect(parseRemoteMessageArgs(["sessions", "--host", "worker", "--json"])?.action).toBe("remote-operation");
  expect(parseRemoteMessageArgs(["serve", "--host", "a", "--host", "b"])?.action).toBe("serve");
  expect(parseRemoteMessageArgs(["sessions", "--json"])).toBeNull();
});

test.skipIf(process.platform === "win32")("helper cancellation joins TERM/KILL cleanup, releases aggregate reservations and never prints stderr", async () => {
  const controller = new AbortController(), budget = new MessageBudget(1000, controller.signal), capacity = new RemoteCapacity();
  const result = runRemoteHelper([process.execPath, "-e", 'process.on("SIGTERM", () => {}); console.error("private fixture diagnostic"); setInterval(() => {}, 1000)'], budget, capacity);
  const settled = result.catch(error => error);
  await Bun.sleep(50); controller.abort();
  const error = await settled; expect(error.message).not.toContain("private");
  expect(error.code).toBe("cancelled"); expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
  budget.dispose();
});

test.skipIf(process.platform === "win32")("idempotent close shares one cleanup flight and bounded capture refuses overflow", async () => {
  const capacity = new RemoteCapacity();
  const helper = spawnRemoteHelper([process.execPath, "-e", 'setInterval(() => {}, 1000)'], capacity);
  expect(helper.close()).toBe(helper.close()); await helper.close();
  const budget = new MessageBudget();
  try { await expect(runRemoteHelper([process.execPath, "-e", 'console.log("x".repeat(65537))'], budget, capacity)).rejects.toThrow("safely"); }
  finally { budget.dispose(); }
  expect(capacity.snapshot().helpers).toBe(0); expect(capacity.snapshot().outputBytes).toBe(0);
});
