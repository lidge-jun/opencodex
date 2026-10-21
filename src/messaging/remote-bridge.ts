import type { ServerWebSocket } from "bun";
import { MessageBudget } from "./budget";
import { LocalMessageRpc } from "./rpc";
import { localDaemonEndpoint } from "./socket";
import { isRecord, isThreadId } from "./types";
import { capability, exactRecord, matchesProof, peerProof, RemoteCapacity, REMOTE_LIMITS,
  REMOTE_PROTOCOL, validCapability, type RemotePeer } from "./remote-contract";
import { admitRemoteRpc } from "./remote-rpc-admission";
import { receiveRemoteEnvelope } from "./remote-envelope";
import { RemoteReplyGrants } from "./remote-replies";
import type { RemoteMessageStore } from "./remote-store";

interface Connection {
  stage: "hello" | "proof" | "authorized";
  budget: MessageBudget;
  release: () => void;
  peer?: RemotePeer;
  key?: string;
  from?: string;
  transaction?: string;
  nonce?: string;
  serverNonce?: string;
  ws?: ServerWebSocket<Connection>;
  rpc?: LocalMessageRpc;
  pending: number;
  lastId: number;
  queue: boolean;
  initialized: boolean;
  initializing: boolean;
  closed: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  loadedIds: Set<string>;
}
export interface RemoteBridgeHooks {
  control(peer: RemotePeer | null, method: string, params: unknown, budget: MessageBudget): Promise<unknown>;
}
/** A foreground-owned loopback gateway authenticates before touching the existing native daemon. */
export function startRemoteBridge(store: RemoteMessageStore, codexHome: string, capacity: RemoteCapacity,
  signal: AbortSignal, hooks: RemoteBridgeHooks) {
  const initial = store.requireEnabled();
  const connections = new Set<Connection>();
  const tasks = new Set<Promise<void>>();
  const replies = new RemoteReplyGrants(store);
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  const validConnection = (data: Connection): boolean => {
    const state = store.requireEnabled();
    if (state.generation !== initial.generation) return false;
    if (!data.peer) return data.key === state.controlKey;
    return state.peers.some(peer => peer.machine.id === data.from
      && peer.transaction === data.transaction && peer.incoming === data.key);
  };
  const retire = (data: Connection) => {
    if (data.closed) return;
    data.closed = true;
    clearTimeout(data.authTimer);
    connections.delete(data);
    data.budget.dispose();
    data.rpc?.close();
    data.ws?.terminate();
    data.release();
  };
  const send = (data: Connection, value: unknown) => {
    const frame = JSON.stringify(value);
    const free = capacity.reserve("outputBytes", Buffer.byteLength(frame));
    try {
      if (!data.ws || data.ws.send(frame) <= 0) retire(data);
    } finally {
      free();
    }
  };
  const authenticate = (data: Connection, raw: unknown) => {
    const state = store.requireEnabled();
    if (state.generation !== initial.generation) throw new Error("Messaging owner generation changed.");
    if (data.stage === "hello") {
      const hello = exactRecord(raw, ["type", "protocol", "from", "to", "transaction", "nonce"]);
      if (hello.type !== "hello" || hello.protocol !== REMOTE_PROTOCOL || !isThreadId(hello.from)
        || hello.to !== state.machine.id || !isThreadId(hello.transaction) || !validCapability(hello.nonce)) {
        throw new Error("Invalid messaging authentication hello.");
      }
      const peer = state.peers.find(item => item.machine.id === hello.from && item.transaction === hello.transaction);
      const isLocalControl = hello.from === state.machine.id && hello.transaction === state.generation;
      const key = isLocalControl ? state.controlKey : peer?.incoming;
      if (!key) throw new Error("Messaging enrollment is unavailable.");
      Object.assign(data, { peer, key, from: hello.from, transaction: hello.transaction, nonce: hello.nonce, serverNonce: capability() });
      data.stage = "proof";
      send(data, { type: "challenge", nonce: data.serverNonce, proof: peerProof(key, "server", data.from!, state.machine.id,
        data.transaction!, data.nonce!, data.serverNonce!) });
    } else {
      const proof = exactRecord(raw, ["type", "proof"]);
      if (proof.type !== "authorize" || !validConnection(data) || !matchesProof(proof.proof,
        peerProof(data.key!, "client", data.from!, state.machine.id, data.transaction!, data.nonce!, data.serverNonce!))) {
        throw new Error("Messaging authentication proof was refused.");
      }
      // Unverified sockets never consume outgoing/control capacity. Promote only after proof verification.
      // Peer sockets share the connections outside the owner's reserved control/probe/renewal slots.
      const release = data.peer ? capacity.reservePeerConnection() : capacity.reserve("connections");
      data.release();
      data.release = release;
      data.stage = "authorized";
      clearTimeout(data.authTimer);
      send(data, { type: "authorized", protocol: REMOTE_PROTOCOL });
    }
  };
  const execute = async (data: Connection, frame: Record<string, unknown>) => {
    const id = frame.id;
    const method = frame.method as string;
    data.budget.throwIfEnded();
    if (!validConnection(data)) throw new Error("Messaging enrollment changed.");
    if (method.startsWith("message/")) {
      if (data.rpc || data.pending !== 1) throw new Error("Control and native RPC cannot share a connection.");
      const result = method === "message/reply-route" && !data.peer
        ? replies.control(frame.params)
        : await hooks.control(data.peer ?? null, method, frame.params, data.budget);
      if (!data.closed && validConnection(data)) send(data, { id, result });
      return;
    }
    const params = admitRemoteRpc(method, frame.params);
    let result: unknown;
    if (method === "initialize") {
      if (data.rpc || data.initializing || data.initialized) throw new Error("Messaging connection was already initialized.");
      data.initializing = true;
      data.rpc = await LocalMessageRpc.connect(localDaemonEndpoint(codexHome).url, data.budget);
      data.initializing = false;
      result = { userAgent: REMOTE_PROTOCOL };
    } else if (method === "initialized") {
      if (id !== undefined || !data.rpc || data.initialized) throw new Error("Invalid messaging initialization acknowledgement.");
      data.initialized = true;
      return;
    } else {
      if (!data.rpc || !data.initialized) throw new Error("Initialize the messaging connection before native RPC.");
      if (method === "thread/loaded/list") {
        const page = await data.rpc.loadedPage(params.cursor as string | undefined);
        const visible = page.data.filter(id => !data.peer || replies.visible(data.peer, id));
        for (const id of visible) data.loadedIds.add(id);
        if (data.loadedIds.size > 1000) throw new Error("Loaded session limit exceeded.");
        result = { ...page, data: visible };
      }
      else if (method === "thread/read") {
        if (!data.loadedIds.has(params.threadId as string)
          || (data.peer && !replies.visible(data.peer, params.threadId as string))) {
          throw new Error("Session is outside this peer's reply routes.");
        }
        const thread = await data.rpc.readThread(params.threadId as string);
        if (data.peer && !replies.visible(data.peer, thread.id)) throw new Error("Session permission changed during lookup.");
        result = { thread: { id: thread.id, name: thread.name, status: { type: thread.status } } };
      } else {
        if (data.queue || !data.peer) throw new Error("Only one peer message may be queued per connection.");
        data.queue = true;
        const envelope = receiveRemoteEnvelope((params.input as { text: string }[])[0]!.text,
          params.clientUserMessageId as string, data.peer);
        if (!data.loadedIds.has(params.threadId as string)) {
          send(data, { id, error: { code: -32000, message: "Recipient was not discovered loaded on this connection." } });
          return;
        }
        const fresh = await data.rpc.readThread(params.threadId as string);
        if (fresh.status === "notLoaded") {
          send(data, { id, error: { code: -32000, message: "Recipient unloaded before queue submission." } });
          return;
        }
        if (!validConnection(data)) throw new Error("Messaging enrollment changed before submission.");
        data.budget.throwIfEnded();
        const settleReply = replies.begin(data.peer, envelope.header, params.threadId as string);
        let submissionId: string | undefined;
        // An exception or uncertain receipt must spend the one-shot route, not authorize a replay.
        let submitted = true;
        let receipt;
        try {
          receipt = await data.rpc.queueMessage(params.threadId as string,
            envelope.text, params.clientUserMessageId as string, value => { submissionId = value; });
          submitted = receipt.status !== "not_sent";
        } finally {
          settleReply(submitted);
        }
        if (receipt.status === "unknown") {
          retire(data);
          return;
        }
        if (receipt.status === "not_sent") {
          send(data, { id, error: { code: receipt.error?.code === "unsupported_queue" ? -32601 : -32000,
            message: "Messaging queue request was rejected." } });
          return;
        }
        result = { queuedSubmission: { id: submissionId, input: params.input, clientUserMessageId: params.clientUserMessageId } };
      }
    }
    if (!data.closed && validConnection(data)) {
      send(data, { id, result });
    } else {
      retire(data);
    }
  };
  const server = Bun.serve<Connection>({ hostname: "127.0.0.1", port: initial.port, development: false,
    maxRequestBodySize: 4096, idleTimeout: 30,
    fetch(req, runtime) {
      try {
        const url = new URL(req.url);
        if (stopping || signal.aborted || !store.requireEnabled() || url.pathname !== "/message" || url.search
          || req.method !== "GET" || req.headers.has("origin") || req.headers.has("authorization")) return new Response(null, { status: 403 });
        const unauthenticated = [...connections].filter(data => data.stage !== "authorized");
        // Reclaim the oldest idle admission instead of letting four silent clients block all fresh proofs.
        if (unauthenticated.length >= REMOTE_LIMITS.unauthenticated) retire(unauthenticated[0]!);
        const release = () => {};
        const budget = new MessageBudget(30000, signal);
        const data: Connection = { stage: "hello", budget, release, pending: 0, lastId: 0, queue: false,
          initialized: false, initializing: false, closed: false, loadedIds: new Set() };
        connections.add(data);
        budget.signal.addEventListener("abort", () => retire(data), { once: true });
        data.authTimer = setTimeout(() => retire(data), REMOTE_LIMITS.authMs);
        if (runtime.upgrade(req, { data })) return;
        retire(data);
        return new Response(null, { status: 400 });
      } catch { return new Response(null, { status: 503 }); }
    },
    websocket: { maxPayloadLength: REMOTE_LIMITS.frameBytes, backpressureLimit: 1,
      closeOnBackpressureLimit: true,
      open(ws) { ws.data.ws = ws; },
      close(ws) { retire(ws.data); },
      message(ws, message) {
        const data = ws.data;
        try {
          if (stopping || data.closed || typeof message !== "string"
            || Buffer.byteLength(message) > (data.stage === "authorized" ? REMOTE_LIMITS.frameBytes : 4096)) {
            throw new Error("Messaging connection is closed or its frame is invalid.");
          }
          const raw: unknown = JSON.parse(message);
          if (data.stage !== "authorized") {
            authenticate(data, raw);
            return;
          }
          if (!isRecord(raw) || typeof raw.method !== "string" || Object.keys(raw).some(key => !["id", "method", "params"].includes(key))) {
            throw new Error("Invalid messaging RPC frame.");
          }
          if (raw.method !== "initialized") {
            if (!Number.isSafeInteger(raw.id) || Number(raw.id) <= data.lastId) throw new Error("Messaging RPC IDs must strictly increase.");
            data.lastId = Number(raw.id);
          } else if (raw.id !== undefined) throw new Error("The initialized notification must not have a request ID.");
          if (data.pending >= 4) throw new Error("Messaging RPC concurrency limit exceeded.");
          const free = capacity.reserve("requests");
          let freeBytes: () => void;
          try {
            freeBytes = capacity.reserve("outputBytes", Buffer.byteLength(message));
          } catch (error) {
            free();
            throw error;
          }
          data.pending++;
          const task = execute(data, raw).catch(() => retire(data)).finally(() => {
            data.pending--;
            free();
            freeBytes();
            tasks.delete(task);
          });
          tasks.add(task);
        } catch { retire(data); }
      },
    }, error() { return new Response(null, { status: 503 }); },
  });
  const close = (): Promise<void> => closePromise ??= (async () => {
    stopping = true;
    signal.removeEventListener("abort", abort);
    for (const data of [...connections]) retire(data);
    await server.stop(true);
    await Promise.allSettled([...tasks]);
  })();
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { port: server.port!, close };
}
