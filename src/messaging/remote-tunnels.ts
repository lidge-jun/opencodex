import { join } from "node:path";
import { buildExecArgv, buildTunnelArgv, remoteOcxArgv } from "../link/ssh-argv";
import { MessageBudget } from "./budget";
import { exactRecord, RemoteCapacity, remoteError, validPort, type RemotePeer } from "./remote-contract";
import { withRemoteLock, writeRemoteFile } from "./remote-files";
import { reserveRemotePort, remotePortIsLoopback, type RemotePortAllocator, type RemotePortReservation } from "./remote-ports";
import { runRemoteHelper, spawnRemoteHelper, type RemoteHelper } from "./remote-process";
import type { RemoteMessageStore } from "./remote-store";

export interface RemoteTunnelPair {
  localPort: number; returnPort: number; readonly alive: boolean; readonly exited: Promise<unknown>;
  close(): Promise<void>;
}
export interface RemoteTunnelDeps {
  run?: typeof runRemoteHelper;
  spawn?: typeof spawnRemoteHelper;
  allocatePort?: RemotePortAllocator;
  inspect?: typeof remotePortIsLoopback;
}
/** Own one -L/-R pair with shared SSH policy and one setup deadline; never adopt/kill existing tunnels. */
export async function startRemoteTunnels(store: RemoteMessageStore, peer: RemotePeer, budget: MessageBudget,
  capacity: RemoteCapacity, ownerSignal: AbortSignal, deps: RemoteTunnelDeps = {}): Promise<RemoteTunnelPair> {
  if (!peer.ssh || !peer.hostKey) throw remoteError("return_route_only", "This peer has no initiating SSH enrollment; wait for its return route.");
  const knownHosts = join(store.directory, `${peer.machine.id}.known_hosts`);
  withRemoteLock(store.directory, () => writeRemoteFile(knownHosts, peer.hostKey!));
  return startRemoteForwardPair({ ssh: peer.ssh, knownHosts, peerPort: peer.port, ownerPort: store.requireEnabled().port },
    budget, capacity, ownerSignal, deps);
}

interface RemoteForwardOptions { ssh: string; knownHosts: string; peerPort: number; ownerPort: number }
const FORWARD_SETUP_ATTEMPTS = 3;

/** Transport-only setup: no messages or authenticated-ready state are published here. */
export async function startRemoteForwardPair(options: RemoteForwardOptions, budget: MessageBudget,
  capacity: RemoteCapacity, ownerSignal: AbortSignal, deps: RemoteTunnelDeps = {}): Promise<RemoteTunnelPair> {
  const localPorts = new Set<number>(), returnPorts = new Set<number>();
  for (let attempt = 0; attempt < FORWARD_SETUP_ATTEMPTS; attempt++) {
    budget.throwIfEnded();
    if (ownerSignal.aborted) throw remoteError("cancelled", "Messaging tunnel setup was cancelled.");
    const result = exactRecord(JSON.parse(await (deps.run ?? runRemoteHelper)(buildExecArgv({ alias: options.ssh,
      knownHostsFile: options.knownHosts, argv: remoteOcxArgv(["message", "_port"]) }), budget, capacity)), ["port"]);
    budget.throwIfEnded();
    if (!validPort(result.port)) throw remoteError("remote_incompatible", "Remote node did not offer an unprivileged return port.");
    if (returnPorts.has(result.port)) continue;
    returnPorts.add(result.port);
    const reservation = reserveRemotePort(deps.allocatePort, localPorts);
    localPorts.add(reservation.port);
    try { return await startAttempt(options, reservation, result.port, budget, capacity, ownerSignal, deps); }
    catch (error) { if ((error as { code?: string })?.code !== "forward_port_lost") throw error; }
  }
  throw remoteError("forward_port_lost", "Messaging SSH forward ports were lost during bounded setup.");
}

async function startAttempt(options: RemoteForwardOptions, reservation: RemotePortReservation, returnPort: number,
  budget: MessageBudget, capacity: RemoteCapacity, ownerSignal: AbortSignal, deps: RemoteTunnelDeps): Promise<RemoteTunnelPair> {
  const localPort = reservation.port, helpers: RemoteHelper[] = [], exits: Promise<void>[] = [];
  let lostPort = false;
  let awaitingReceipts = false;
  const setupFailure = (fallback: unknown) => {
    const failures = helpers.flatMap(helper => helper.setupFailure ? [helper.setupFailure] : []);
    return failures.find(error => (error as { code?: string }).code !== "forward_port_lost") ?? failures[0] ?? fallback;
  };
  let cancelReadiness!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { cancelReadiness = reject; });
  void cancelled.catch(() => {});
  let alive = true, closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    alive = false; ownerSignal.removeEventListener("abort", abort);
    const results = await Promise.allSettled(helpers.map(helper => helper.close()));
    await Promise.allSettled(helpers.map(helper => helper.output));
    reservation.release();
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  })();
  const abort = () => {
    cancelReadiness(remoteError("cancelled", "Messaging tunnel setup was cancelled."));
    void close().catch(() => {});
  };
  ownerSignal.addEventListener("abort", abort, { once: true });
  const cancelSetup = () => { cancelReadiness(budget.signal.reason); void close().catch(() => {}); };
  budget.signal.addEventListener("abort", cancelSetup, { once: true });
  try {
    budget.throwIfEnded(); if (ownerSignal.aborted) throw remoteError("cancelled", "Messaging tunnel setup was cancelled.");
    for (const [direction, bindPort, targetPort] of [["L", localPort, options.peerPort], ["R", returnPort, options.ownerPort]] as const) {
      budget.throwIfEnded();
      const argv = buildTunnelArgv({ alias: options.ssh, knownHostsFile: options.knownHosts, direction, bindPort, targetPort });
      if (direction === "L") reservation.handoff();
      const helper = (deps.spawn ?? spawnRemoteHelper)(argv, capacity, ownerSignal);
      helpers.push(helper);
      const exit = helper.exited.then(async code => {
        await close();
        await helper.output.catch(() => {});
        if (code !== 0 && helper.forwardFailed) lostPort = true;
      });
      exits.push(exit); void exit.catch(() => {});
    }
    // A competing loopback listener can exist before SSH even starts. Its socket is not a bind receipt.
    awaitingReceipts = true;
    await Promise.race([Promise.all(helpers.map(helper => helper.forwardReady)), cancelled]);
    awaitingReceipts = false;
    const checkAlive = async () => {
      if (alive) return;
      await Promise.all(exits);
      throw setupFailure(remoteError(lostPort ? "forward_port_lost" : "ssh_failed", "Messaging SSH forward setup failed."));
    };
    let ready = false;
    while (!ready) {
      budget.throwIfEnded();
      await checkAlive();
      ready = await (deps.inspect ?? remotePortIsLoopback)(localPort, budget, capacity);
      await checkAlive();
      if (!ready) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { budget.signal.removeEventListener("abort", cancel); resolve(); }, budget.remainingMs(100));
        const cancel = () => { clearTimeout(timer); budget.signal.removeEventListener("abort", cancel); reject(budget.signal.reason); };
        budget.signal.addEventListener("abort", cancel, { once: true });
        if (budget.signal.aborted) cancel();
      });
    }
    budget.throwIfEnded(); if (ownerSignal.aborted) throw remoteError("cancelled", "Messaging tunnel setup was cancelled.");
    const exited = Promise.race(helpers.map(helper => helper.exited));
    void exited.then(() => close()).catch(() => {});
    return { localPort, returnPort, get alive() { return alive; }, exited, close };
  } catch (error) {
    await close(); budget.throwIfEnded();
    if (ownerSignal.aborted) throw remoteError("cancelled", "Messaging tunnel setup was cancelled.");
    // Sibling shutdown can reject first; classify only after every helper's diagnostics and cleanup settle.
    throw awaitingReceipts ? setupFailure(error) : error;
  }
  finally { budget.signal.removeEventListener("abort", cancelSetup); }
}
