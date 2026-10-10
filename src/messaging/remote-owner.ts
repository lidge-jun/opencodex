import { MessageBudget } from "./budget";
import { authenticatedRemoteSocket, peerEndpoint, remoteControl, type RemoteEndpoint } from "./remote-auth";
import { startRemoteBridge } from "./remote-bridge";
import { exactRecord, RemoteCapacity, REMOTE_LIMITS, remoteError, validPort, type RemotePeer, type RemoteState } from "./remote-contract";
import { remotePortIsLoopback } from "./remote-ports";
import { LocalMessageRpc } from "./rpc";
import type { RemoteMessageStore } from "./remote-store";
import { startRemoteTunnels, type RemoteTunnelPair, type RemoteTunnelDeps } from "./remote-tunnels";
import { isThreadId } from "./types";

interface Route { peer: RemotePeer; port: number; generation: string; expiry: number; ready: boolean; tunnels?: RemoteTunnelPair }
/** Local owner-control capability never leaves this configuration home or enters remote enrollment. */
export function ownerEndpoint(state: RemoteState): RemoteEndpoint {
  return { port: state.port, machineId: state.machine.id, transaction: state.generation, key: state.controlKey };
}
/** Discover a route from the live authenticated owner, never a cached loopback port or implicit startup. */
export async function resolveRemoteRoute(store: RemoteMessageStore, selector: string, budget: MessageBudget) {
  const state = store.requireEnabled(), peer = store.peer(selector);
  const result = exactRecord(await remoteControl(state, ownerEndpoint(state), "message/routes", {}, budget), ["routes"]);
  if (!Array.isArray(result.routes) || result.routes.length > REMOTE_LIMITS.peers) throw remoteError("invalid_remote_route", "Messaging owner returned invalid routes.");
  const matches = result.routes.filter(route => route && typeof route === "object" && route.machineId === peer.machine.id);
  if (matches.length !== 1) throw remoteError("route_unavailable", "No live messaging route exists for this enrolled peer; run the explicit foreground owner.");
  const route = exactRecord(matches[0], ["machineId", "transaction", "port", "kind"]);
  if (route.transaction !== peer.transaction || !validPort(route.port) || !["initiated", "leased"].includes(String(route.kind))) throw remoteError("invalid_remote_route", "Messaging route does not match the current enrollment.");
  return { state, peer, endpoint: peerEndpoint(peer, route.port) };
}

/** Explicit foreground lifetime: one listener, aggregate reservations and bounded owned tunnel teardown. */
export async function startRemoteOwner(store: RemoteMessageStore, home: string, selectors: readonly string[], parent?: AbortSignal,
  tunnelDeps: RemoteTunnelDeps = {}) {
  const state = store.requireEnabled(), generation = crypto.randomUUID(), controller = new AbortController();
  const capacity = new RemoteCapacity(), routes = new Map<string, Route>(), operations = new Set<Promise<unknown>>();
  let finish!: () => void, finishError!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { finish = resolve; finishError = reject; });
  void finished.catch(() => {});
  let stopping = false, closing: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const check = () => {
    const current = store.requireEnabled();
    if (stopping || current.generation !== state.generation) throw remoteError("owner_retired", "Messaging owner configuration changed; restart this foreground owner explicitly.");
    return current;
  };
  const probe = async (peer: RemotePeer, port: number, budget: MessageBudget) => {
    const release = capacity.reserve("connections"); let rpc: LocalMessageRpc | undefined;
    try { rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(check(), peerEndpoint(peer, port), budget), budget); }
    finally { rpc?.close(); release(); }
  };
  const bridge = startRemoteBridge(store, home, capacity, controller.signal, {
    async control(peer, method, params, budget) {
      check();
      if (method === "message/routes" && !peer) {
        exactRecord(params, []);
        const current = check();
        return { routes: [...routes.values()].filter(route => route.ready && current.peers.some(p => p.transaction === route.peer.transaction)
          && (route.tunnels ? route.tunnels.alive : route.expiry > performance.now())).map(route => ({
          machineId: route.peer.machine.id, transaction: route.peer.transaction, port: route.port, kind: route.tunnels ? "initiated" : "leased" })) };
      }
      if (method !== "message/lease" || !peer) throw new Error();
      const lease = exactRecord(params, ["port", "generation"]);
      if (!validPort(lease.port) || !isThreadId(lease.generation)) throw new Error();
      if (!await remotePortIsLoopback(lease.port, budget, capacity)) throw new Error();
      await probe(peer, lease.port, budget);
      check(); budget.throwIfEnded();
      const existing = routes.get(peer.machine.id);
      if (existing?.tunnels || (existing && existing.generation !== lease.generation && existing.expiry > performance.now())) throw new Error();
      routes.set(peer.machine.id, { peer, port: lease.port, generation: lease.generation, ready: true, expiry: performance.now() + REMOTE_LIMITS.leaseMs });
      return { leased: true, generation: lease.generation };
    },
  });
  const register = async (route: Route, budget: MessageBudget) => {
    const free = capacity.reserve("connections");
    try {
      const result = exactRecord(await remoteControl(check(), peerEndpoint(route.peer, route.port), "message/lease",
        { port: route.tunnels!.returnPort, generation }, budget), ["leased", "generation"]);
      if (result.leased !== true || result.generation !== generation || !route.tunnels!.alive) throw new Error();
    } finally { free(); }
  };
  const close = (): Promise<void> => closing ??= (async () => {
    stopping = true; clearInterval(timer); parent?.removeEventListener("abort", abort); controller.abort();
    const results = await Promise.allSettled([bridge.close(), ...[...routes.values()].map(route => route.tunnels?.close()), ...operations]);
    routes.clear();
    if (results.some(result => result.status === "rejected")) {
      const error = remoteError("cleanup_incomplete", "Messaging owner cleanup did not complete cleanly.");
      finishError(error); throw error;
    }
    finish();
  })();
  const abort = () => { void close().catch(() => {}); };
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const setup = new MessageBudget(30000, controller.signal);
  try {
    const unique = new Set(selectors.map(selector => store.peer(selector).machine.id));
    if (unique.size !== selectors.length) throw remoteError("duplicate_peer", "Do not initiate the same peer more than once.");
    for (const selector of selectors) {
      check(); const peer = store.peer(selector);
      const tunnels = await startRemoteTunnels(store, peer, setup, capacity, controller.signal, tunnelDeps);
      check(); setup.throwIfEnded();
      const route: Route = { peer, port: tunnels.localPort, generation, expiry: Infinity, ready: false, tunnels };
      routes.set(peer.machine.id, route);
      // The data connection proves both the peer and native initialization before ready publication.
      await probe(peer, route.port, setup); await register(route, setup);
      check(); setup.throwIfEnded(); route.ready = true;
      void tunnels.exited.then(() => { routes.delete(peer.machine.id); });
    }
  } catch (error) { await close(); throw error; }
  finally { setup.dispose(); }
  if (stopping) { await close(); throw remoteError("owner_retired", "Messaging owner stopped during setup."); }
  let refreshing = false;
  timer = setInterval(() => {
    if (refreshing || stopping) return;
    refreshing = true;
    const task = (async () => {
      const budget = new MessageBudget(10000, controller.signal);
      try {
        check();
        for (const route of [...routes.values()]) {
          if (!store.read()?.peers.some(peer => peer.transaction === route.peer.transaction)) {
            routes.delete(route.peer.machine.id); await route.tunnels?.close();
          } else if (route.tunnels) await register(route, budget);
          else if (route.expiry <= performance.now()) routes.delete(route.peer.machine.id);
        }
      } catch { abort(); }
      finally { budget.dispose(); refreshing = false; }
    })();
    operations.add(task);
    void task.finally(() => operations.delete(task));
  }, 10000);
  return { port: bridge.port, capacity, close, finished };
}
