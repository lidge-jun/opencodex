import { join } from "node:path";
import { buildExecArgv, buildTunnelArgv, remoteOcxArgv } from "../link/ssh-argv";
import { MessageBudget } from "./budget";
import { exactRecord, RemoteCapacity, remoteError, validPort, type RemotePeer } from "./remote-contract";
import { withRemoteLock, writeRemoteFile } from "./remote-files";
import { remotePortCandidate, remotePortIsLoopback } from "./remote-ports";
import { runRemoteHelper, spawnRemoteHelper, type RemoteHelper } from "./remote-process";
import type { RemoteMessageStore } from "./remote-store";

export interface RemoteTunnelPair {
  localPort: number; returnPort: number; readonly alive: boolean; readonly exited: Promise<unknown>;
  close(): Promise<void>;
}
export interface RemoteTunnelDeps {
  run?: typeof runRemoteHelper;
  spawn?: typeof spawnRemoteHelper;
}
/** Own one -L/-R pair with shared SSH policy and one setup deadline; never adopt/kill existing tunnels. */
export async function startRemoteTunnels(store: RemoteMessageStore, peer: RemotePeer, budget: MessageBudget,
  capacity: RemoteCapacity, ownerSignal: AbortSignal, deps: RemoteTunnelDeps = {}): Promise<RemoteTunnelPair> {
  if (!peer.ssh || !peer.hostKey) throw remoteError("return_route_only", "This peer has no initiating SSH enrollment; wait for its return route.");
  const knownHosts = join(store.directory, `${peer.machine.id}.known_hosts`);
  withRemoteLock(store.directory, () => writeRemoteFile(knownHosts, peer.hostKey!));
  const result = exactRecord(JSON.parse(await (deps.run ?? runRemoteHelper)(buildExecArgv({ alias: peer.ssh,
    knownHostsFile: knownHosts, argv: remoteOcxArgv(["message", "_port"]) }), budget, capacity)), ["port"]);
  if (!validPort(result.port)) throw remoteError("remote_incompatible", "Remote node did not offer an unprivileged return port.");
  const localPort = remotePortCandidate(), returnPort = result.port, helpers: RemoteHelper[] = [];
  let alive = true, closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    alive = false; ownerSignal.removeEventListener("abort", abort);
    await Promise.all(helpers.map(helper => helper.close()));
  })();
  const abort = () => { void close().catch(() => {}); };
  ownerSignal.addEventListener("abort", abort, { once: true });
  const cancelSetup = () => { void close().catch(() => {}); };
  budget.signal.addEventListener("abort", cancelSetup, { once: true });
  try {
    budget.throwIfEnded(); if (ownerSignal.aborted) throw new Error();
    for (const [direction, bindPort, targetPort] of [["L", localPort, peer.port], ["R", returnPort, store.requireEnabled().port]] as const) {
      budget.throwIfEnded();
      const helper = (deps.spawn ?? spawnRemoteHelper)(buildTunnelArgv({ alias: peer.ssh, knownHostsFile: knownHosts,
        direction, bindPort, targetPort }), capacity, ownerSignal);
      helpers.push(helper);
      void helper.exited.then(() => close()).catch(() => {});
    }
    let ready = false;
    while (!ready) {
      budget.throwIfEnded();
      if (!alive) throw new Error();
      ready = await remotePortIsLoopback(localPort, budget, capacity);
      if (!ready) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { budget.signal.removeEventListener("abort", cancel); resolve(); }, budget.remainingMs(100));
        const cancel = () => { clearTimeout(timer); budget.signal.removeEventListener("abort", cancel); reject(budget.signal.reason); };
        budget.signal.addEventListener("abort", cancel, { once: true });
        if (budget.signal.aborted) cancel();
      });
    }
    const exited = Promise.race(helpers.map(helper => helper.exited));
    void exited.then(() => close()).catch(() => {});
    return { localPort, returnPort, get alive() { return alive; }, exited, close };
  } catch (error) { await close(); throw error; }
  finally { budget.signal.removeEventListener("abort", cancelSetup); }
}
