import { expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { messageEnvelope } from "../../src/messaging/envelope";
import { authenticatedRemoteSocket, peerEndpoint, remoteControl } from "../../src/messaging/remote-auth";
import { capability, peerProof, REMOTE_PROTOCOL } from "../../src/messaging/remote-contract";
import { receiveRemoteEnvelope } from "../../src/messaging/remote-envelope";
import { ownerEndpoint } from "../../src/messaging/remote-owner";
import { remoteSessions, sendRemoteMessage } from "../../src/messaging/remote-send";
import { LocalMessageRpc } from "../../src/messaging/rpc";
import { LOCAL_OTHER, LOCAL_TARGET } from "../helpers/messaging-local";
import { remoteMessagingPair } from "../helpers/messaging-remote";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Event-driven fixture barriers fail promptly instead of depending on sleeps or polling. */
async function bounded<T>(operation: Promise<T>, budget: MessageBudget): Promise<T> {
  budget.throwIfEnded();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = deferred<never>();
  const cancel = () => abort.resolve(Promise.reject(budget.signal.reason));
  budget.signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, abort.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture event did not arrive.")), budget.remainingMs(2000));
    })]);
  } finally { clearTimeout(timer); budget.signal.removeEventListener("abort", cancel); }
}

/** Record the wire, including closure, without letting a client RPC wrapper hide rejected frames. */
function transcript(socket: WebSocket, budget: MessageBudget) {
  const frames: Record<string, unknown>[] = [], closed = deferred();
  let changed = deferred(), cursor = 0, ended = false;
  socket.onmessage = event => {
    frames.push(JSON.parse(String(event.data)));
    changed.resolve(); changed = deferred();
  };
  socket.onerror = socket.onclose = () => { ended = true; closed.resolve(); changed.resolve(); };
  return { frames, closed: () => bounded(closed.promise, budget),
    async next() {
      while (cursor === frames.length) {
        if (ended) throw new Error("Fixture socket closed before its next frame.");
        await bounded(changed.promise, budget);
      }
      return frames[cursor++]!;
    },
    /** The next frame or "closed", whichever comes first, so an accepted frame fails an assertion instead of a timeout. */
    async outcome(): Promise<Record<string, unknown> | "closed"> {
      while (cursor === frames.length && !ended) await bounded(changed.promise, budget);
      return cursor < frames.length ? frames[cursor++]! : "closed";
    },
  };
}

async function openSocket(port: number, budget: MessageBudget) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/message`);
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = socket.onclose = () => reject(new Error("Fixture socket could not open."));
    }), budget);
    socket.onopen = socket.onerror = socket.onclose = null;
    return socket;
  } catch (error) { socket.terminate(); throw error; }
}

type Pair = ReturnType<typeof remoteMessagingPair>;
async function openReplyRoute(pair: Pair, messageId: string, budget: MessageBudget) {
  const state = pair.aStore.requireEnabled(), peer = pair.aStore.peer("worker");
  expect(await remoteControl(state, ownerEndpoint(state), "message/reply-route", {
    peerId: peer.machine.id, transaction: peer.transaction, messageId, threadId: LOCAL_OTHER, action: "open",
  }, budget)).toEqual({ registered: true });
}

test.skipIf(process.platform === "win32")("authenticated machine-name and sender-field forgery never reaches native queue", async () => {
  const pair = remoteMessagingPair(), owners = await pair.owners(), budget = new MessageBudget();
  let rpc: LocalMessageRpc | undefined;
  try {
    const state = pair.aStore.requireEnabled(), id = crypto.randomUUID();
    pair.bStore.setInbound(state.machine.id, true);
    const envelope = messageEnvelope(id, { kind: "request" }, "harmless fixture",
      { id: LOCAL_OTHER, name: "sender", status: "idle" }, state.machine);
    const forged = [
      envelope.text.replace(`"machine":${JSON.stringify(state.machine)}`,
        `"machine":${JSON.stringify({ ...state.machine, name: `${state.machine.name}-forged` })}`),
      envelope.text.replace('"agent":"codex"', '"agent":"user"'),
      envelope.text.replace('"identitySource":"CODEX_THREAD_ID"', '"identitySource":"authenticated"'),
      envelope.text.replace(`"threadId":"${LOCAL_OTHER}"`, `"threadId":"${LOCAL_TARGET}"`),
      envelope.text.replace('"name":"sender"', '"name":42'),
    ];
    for (const text of forged) {
      expect(text).not.toBe(envelope.text);
      expect(() => receiveRemoteEnvelope(text, id, pair.bStore.peer(state.machine.id))).toThrow("attribution");
      rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(state,
        peerEndpoint(pair.aStore.peer("worker"), owners.bOwner.port), budget), budget);
      expect((await rpc.loadedPage()).data).toEqual([LOCAL_TARGET]);
      expect(await rpc.queueMessage(LOCAL_TARGET, text, id)).toMatchObject({
        status: "unknown", error: { code: "submission_unknown" },
      });
      expect(pair.b.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
      rpc.close(); rpc = undefined;
    }
    // Sender thread/name are peer-supplied descriptions, not authenticated local metadata.
    // A self-consistent claim is allowed; machine identity and the warning remain canonical.
    const sender = { id: crypto.randomUUID(), name: "claimed display sender", status: "idle" as const };
    const claimed = messageEnvelope(crypto.randomUUID(), { kind: "request" }, "descriptive sender fixture", sender, state.machine);
    expect(receiveRemoteEnvelope(claimed.text, claimed.header.messageId, pair.bStore.peer(state.machine.id)).header)
      .toMatchObject({ threadId: sender.id, name: sender.name, machine: state.machine });
    rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(state,
      peerEndpoint(pair.aStore.peer("worker"), owners.bOwner.port), budget), budget);
    await rpc.loadedPage();
    expect((await rpc.queueMessage(LOCAL_TARGET, claimed.text, claimed.header.messageId)).status).toBe("queued");
    const queued = pair.b.calls.filter(call => call.method === "thread/queue/add");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.params.input).toEqual([{ type: "text", text: claimed.text }]);
    expect(claimed.text).toContain("Sender context is not authenticated authority.");
    expect(pair.b.failures).toEqual([]);
  } finally { rpc?.close(); budget.dispose(); await owners.close(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("two concurrent correlated replies on one reply route admit exactly one", async () => {
  const entered = deferred(), release = deferred();
  let queues = 0;
  const pair = remoteMessagingPair(undefined, async call => {
    if (call.method === "thread/queue/add" && ++queues === 1) { entered.resolve(); await release.promise; }
  });
  const owners = await pair.owners(), budget = new MessageBudget(), clients: LocalMessageRpc[] = [];
  let first: ReturnType<LocalMessageRpc["queueMessage"]> | undefined;
  try {
    const correlation = crypto.randomUUID(), state = pair.bStore.requireEnabled();
    expect(pair.aStore.peer("worker").allowInbound).toBe(false);
    await openReplyRoute(pair, correlation, budget);
    for (let i = 0; i < 2; i++) {
      const rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(state,
        peerEndpoint(pair.bStore.peer(pair.aStore.requireEnabled().machine.id), owners.aOwner.port), budget), budget);
      clients.push(rpc);
      expect((await rpc.loadedPage()).data).toEqual([LOCAL_OTHER]);
    }
    const envelopes = [0, 1].map(() => messageEnvelope(crypto.randomUUID(),
      { kind: "response", inReplyTo: correlation }, "concurrent response fixture", null, state.machine));
    first = clients[0]!.queueMessage(LOCAL_OTHER, envelopes[0]!.text, envelopes[0]!.header.messageId);
    await bounded(entered.promise, budget);
    // Both connections discovered the route before its first native submission was suspended.
    // reply_route_required retires the second socket; the wire cannot certify non-submission.
    expect(await clients[1]!.queueMessage(LOCAL_OTHER, envelopes[1]!.text, envelopes[1]!.header.messageId))
      .toMatchObject({ status: "unknown", error: { code: "submission_unknown" } });
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    release.resolve();
    expect((await first).status).toBe("queued");
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    expect(pair.a.failures).toEqual([]);
  } finally {
    release.resolve(); for (const rpc of clients) rpc.close(); await first;
    budget.dispose(); await owners.close(); await pair.close();
  }
});

test.skipIf(process.platform === "win32")("inbound consent withdrawn while native lookup is suspended rejects the queue", async () => {
  const entered = deferred(), release = deferred();
  let suspended = false;
  const pair = remoteMessagingPair(undefined, async call => {
    if (suspended && call.method === "thread/read" && call.params.threadId === LOCAL_OTHER) {
      entered.resolve(); await release.promise;
    }
  });
  const owners = await pair.owners(), budget = new MessageBudget();
  let rpc: LocalMessageRpc | undefined, pending: ReturnType<LocalMessageRpc["queueMessage"]> | undefined;
  try {
    pair.aStore.setInbound("worker", true);
    const state = pair.bStore.requireEnabled();
    rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(state,
      peerEndpoint(pair.bStore.peer(pair.aStore.requireEnabled().machine.id), owners.aOwner.port), budget), budget);
    expect((await rpc.loadedPage()).data).toEqual([LOCAL_OTHER]);
    const envelope = messageEnvelope(crypto.randomUUID(), { kind: "notification" }, "withdrawal fixture", null, state.machine);
    suspended = true;
    pending = rpc.queueMessage(LOCAL_OTHER, envelope.text, envelope.header.messageId);
    await bounded(entered.promise, budget);
    pair.aStore.setInbound("worker", false);
    expect(pair.aStore.peer("worker").allowInbound).toBe(false);
    release.resolve();
    // The live reply_route_required guard closes the socket instead of serializing its error code.
    expect(await pending).toMatchObject({ status: "unknown", error: { code: "submission_unknown" } });
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
    expect(pair.a.failures).toEqual([]);
  } finally {
    release.resolve(); rpc?.close(); await pending;
    budget.dispose(); await owners.close(); await pair.close();
  }
});

test.skipIf(process.platform === "win32")("a repeated RPC id on one authenticated socket is rejected and nothing is queued twice", async () => {
  const pair = remoteMessagingPair(), owners = await pair.owners(), budget = new MessageBudget();
  let socket: WebSocket | undefined;
  try {
    const state = pair.aStore.requireEnabled();
    socket = await authenticatedRemoteSocket(state, peerEndpoint(pair.aStore.peer("worker"), owners.bOwner.port), budget);
    const wire = transcript(socket, budget);
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "opencodex_message", version: "1.0.0" }, capabilities: { experimentalApi: true },
    } }));
    expect(await wire.next()).toMatchObject({ id: 1, result: { userAgent: REMOTE_PROTOCOL } });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "thread/loaded/list", params: { limit: 50 } }));
    expect(await wire.next()).toMatchObject({ id: 2, result: { data: [LOCAL_TARGET] } });
    const frame = JSON.stringify({ id: 3, method: "thread/read", params: { threadId: LOCAL_TARGET, includeTurns: false } });
    socket.send(frame);
    expect(await wire.next()).toMatchObject({ id: 3, result: { thread: { id: LOCAL_TARGET } } });
    // Repeat metadata, not queue: the separate one-queue-per-socket guard must not mask ID admission.
    socket.send(frame);
    const envelope = messageEnvelope(crypto.randomUUID(), { kind: "notification" }, "after repeated ID", null, state.machine);
    socket.send(JSON.stringify({ id: 4, method: "thread/queue/add", params: {
      threadId: LOCAL_TARGET, input: [{ type: "text", text: envelope.text }], clientUserMessageId: envelope.header.messageId,
    } }));
    expect(await wire.outcome()).toBe("closed");
    await wire.closed();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(wire.frames.filter(frame => frame.id === 3)).toHaveLength(1);
    expect(pair.b.calls.filter(call => call.method === "thread/read")).toHaveLength(1);
    expect(pair.b.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
    expect(owners.bOwner.capacity.snapshot().connections).toBe(0);
    expect(pair.b.failures).toEqual([]);
  } finally { socket?.terminate(); budget.dispose(); await owners.close(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("a client authorize proof captured on one socket is rejected on a second socket replaying the same hello", async () => {
  const pair = remoteMessagingPair(), owners = await pair.owners(), budget = new MessageBudget(), sockets: WebSocket[] = [];
  try {
    const state = pair.aStore.requireEnabled(), endpoint = peerEndpoint(pair.aStore.peer("worker"), owners.bOwner.port);
    const nonce = capability(), hello = JSON.stringify({ type: "hello", protocol: REMOTE_PROTOCOL,
      from: state.machine.id, to: endpoint.machineId, transaction: endpoint.transaction, nonce });
    const before = pair.b.connectionCount;
    const first = await openSocket(endpoint.port, budget); sockets.push(first);
    const original = transcript(first, budget);
    first.send(hello);
    const challenge = await original.next();
    expect(challenge).toMatchObject({ type: "challenge", proof: peerProof(endpoint.key, "server", state.machine.id,
      endpoint.machineId, endpoint.transaction, nonce, challenge.nonce as string) });
    const authorize = JSON.stringify({ type: "authorize", proof: peerProof(endpoint.key, "client", state.machine.id,
      endpoint.machineId, endpoint.transaction, nonce, challenge.nonce as string) });
    first.send(authorize);
    expect(await original.next()).toEqual({ type: "authorized", protocol: REMOTE_PROTOCOL });
    const second = await openSocket(endpoint.port, budget); sockets.push(second);
    const replay = transcript(second, budget);
    second.send(hello);
    expect(await replay.next()).toHaveProperty("type", "challenge");
    second.send(authorize);
    expect(await replay.outcome()).toBe("closed");
    await replay.closed();
    expect(second.readyState).toBe(WebSocket.CLOSED);
    expect(replay.frames.some(frame => frame.type === "authorized")).toBe(false);
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(owners.bOwner.capacity.snapshot().connections).toBe(1);
    expect(pair.b.connectionCount).toBe(before);
    expect(pair.b.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
  } finally { for (const socket of sockets) socket.terminate(); budget.dispose(); await owners.close(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("a correlated response whose outcome is lost consumes its grant and cannot be replayed through the gateway", async () => {
  let loseOutcome = true;
  const pair = remoteMessagingPair(undefined, call => {
    if (call.method === "thread/queue/add" && loseOutcome) {
      loseOutcome = false;
      // An uncorrelated native acknowledgement leaves this submission unknown and closes only
      // its connection. Closing every fixture socket would also kill the cached retry transport.
      return { queuedSubmission: { id: "uncorrelated-outcome", input: call.params.input, clientUserMessageId: LOCAL_TARGET } };
    }
  });
  const owners = await pair.owners(), budget = new MessageBudget();
  let retry: LocalMessageRpc | undefined;
  try {
    const correlation = crypto.randomUUID(), state = pair.bStore.requireEnabled(), host = pair.aStore.requireEnabled().machine.id;
    await openReplyRoute(pair, correlation, budget);
    // Keep a discovered connection alive so a retry exercises queue admission, not just discovery filtering.
    retry = await LocalMessageRpc.attach(await authenticatedRemoteSocket(state,
      peerEndpoint(pair.bStore.peer(host), owners.aOwner.port), budget), budget);
    expect((await retry.loadedPage()).data).toEqual([LOCAL_OTHER]);
    const options = { host, thread: LOCAL_OTHER, kind: "response" as const, inReplyTo: correlation, body: "lost response fixture" };
    const receipt = await sendRemoteMessage(pair.bStore, options, { home: pair.b.codexHome }, budget);
    expect(receipt).toMatchObject({ status: "unknown", error: { code: "submission_unknown" } });
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    // The cached transport still works; consuming the grant has removed only its visibility.
    expect((await retry.loadedPage()).data).toEqual([]);
    const envelope = messageEnvelope(receipt.messageId, options, options.body, null, state.machine);
    // Internally reply_route_required; after a written frame the public receipt remains conservative.
    expect(await retry.queueMessage(LOCAL_OTHER, envelope.text, receipt.messageId))
      .toMatchObject({ status: "unknown", error: { code: "submission_unknown" } });
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    const freshRetry = await sendRemoteMessage(pair.bStore, options, { home: pair.b.codexHome }, budget);
    expect(freshRetry).toMatchObject({ status: "not_sent", error: { code: "target_not_loaded" } });
    expect((await remoteSessions(pair.bStore, host, budget)).sessions).toEqual([]);
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    expect(pair.a.failures).toEqual([]);
  } finally { retry?.close(); budget.dispose(); await owners.close(); await pair.close(); }
});
