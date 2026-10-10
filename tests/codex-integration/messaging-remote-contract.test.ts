import { expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { authenticatedRemoteSocket, peerEndpoint } from "../../src/messaging/remote-auth";
import { startRemoteBridge } from "../../src/messaging/remote-bridge";
import { admitRemoteRpc } from "../../src/messaging/remote-rpc-admission";
import { capability, matchesProof, peerProof, RemoteCapacity, REMOTE_LIMITS } from "../../src/messaging/remote-contract";
import { LocalMessageRpc } from "../../src/messaging/rpc";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { LOCAL_TARGET } from "../helpers/messaging-local";

test("proofs bind direction, both machines, transaction and both fresh nonces", () => {
  const key = capability(), client = capability(), server = capability(), txn = crypto.randomUUID();
  const args = [key, "server", "a", "b", txn, client, server] as const;
  const proof = peerProof(...args);
  expect(matchesProof(proof, proof)).toBe(true); expect(matchesProof("bad", proof)).toBe(false);
  for (const next of [peerProof(key, "client", "a", "b", txn, client, server),
    peerProof(key, "server", "b", "a", txn, client, server), peerProof(key, "server", "a", "b", crypto.randomUUID(), client, server),
    peerProof(key, "server", "a", "b", txn, capability(), server)]) expect(matchesProof(next, proof)).toBe(false);
});

test("aggregate capacity is fixed across peers; refused reservations allocate nothing and release is idempotent", () => {
  for (const kind of ["connections", "requests", "helpers", "outputBytes"] as const) {
    const capacity = new RemoteCapacity(), free = capacity.reserve(kind, REMOTE_LIMITS[kind]);
    expect(() => capacity.reserve(kind)).toThrow("aggregate"); expect(capacity.snapshot()[kind]).toBe(REMOTE_LIMITS[kind]);
    free(); free(); expect(capacity.snapshot()[kind]).toBe(0);
  }
});

for (const method of ["thread/start", "thread/resume", "turn/start", "turn/steer", "config/write", "thread/list", "approval/respond"]) {
  test(`gateway does not admit ${method}`, () => expect(() => admitRemoteRpc(method, {})).toThrow());
}
test("native admission refuses history, unknown flags, rich inputs and duplicate semantics", () => {
  for (const [method, params] of [["thread/read", { threadId: LOCAL_TARGET, includeTurns: true }],
    ["thread/read", { threadId: LOCAL_TARGET, includeTurns: false, cwd: "/private" }],
    ["thread/queue/add", { threadId: LOCAL_TARGET, input: [{ type: "image", imageUrl: "private" }], clientUserMessageId: LOCAL_TARGET }],
    ["initialize", { clientInfo: { name: "opencodex_message", version: "1.0.0" }, capabilities: { experimentalApi: true, approvals: true } }]]) {
    expect(() => admitRemoteRpc(String(method), params)).toThrow();
  }
});

test.skipIf(process.platform === "win32")("mutual authentication precedes Unix attachment and projects only bounded metadata", async () => {
  const pair = remoteMessagingPair(), controller = new AbortController(), capacity = new RemoteCapacity();
  const bridge = startRemoteBridge(pair.bStore, pair.b.codexHome, capacity, controller.signal, { async control() { throw new Error(); } });
  const budget = new MessageBudget();
  try {
    const state = pair.aStore.requireEnabled(), endpoint = peerEndpoint(pair.aStore.peer("worker"), bridge.port);
    for (const invalid of [{ ...endpoint, key: capability() }, { ...endpoint, machineId: crypto.randomUUID() },
      { ...endpoint, transaction: crypto.randomUUID() }]) {
      await expect(authenticatedRemoteSocket(state, invalid, budget)).rejects.toThrow("authentication");
    }
    expect(pair.b.calls).toHaveLength(0);
    const rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(state, endpoint, budget), budget);
    try { await rpc.loadedPage(); expect(await rpc.readThread(LOCAL_TARGET)).toEqual({ id: LOCAL_TARGET, name: "recipient", status: "idle" }); }
    finally { rpc.close(); }
    expect(pair.b.calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/loaded/list", "thread/read"]);
    expect(pair.b.failures).toEqual([]);
  } finally { budget.dispose(); await bridge.close(); await pair.close(); }
  expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
});

test.skipIf(process.platform === "win32")("a replacement listener receives no client proof, bearer or message without server identity proof", async () => {
  const pair = remoteMessagingPair(), frames: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, runtime) { if (runtime.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, message) { frames.push(String(message)); ws.send(JSON.stringify({ type: "challenge", nonce: capability(), proof: capability() })); } } });
  const budget = new MessageBudget();
  try {
    await expect(authenticatedRemoteSocket(pair.aStore.requireEnabled(), peerEndpoint(pair.aStore.peer("worker"), server.port!), budget)).rejects.toThrow("authentication");
    expect(frames).toHaveLength(1); expect(JSON.parse(frames[0]!).type).toBe("hello");
    expect(frames[0]).not.toContain(pair.aStore.peer("worker").outgoing); expect(pair.b.calls).toHaveLength(0);
  } finally { budget.dispose(); await server.stop(true); await pair.close(); }
});

test.skipIf(process.platform === "win32")("upgrade admission and aggregate exhaustion attach no native socket; revocation retires an authenticated connection", async () => {
  const pair = remoteMessagingPair(), controller = new AbortController(), capacity = new RemoteCapacity();
  const bridge = startRemoteBridge(pair.bStore, pair.b.codexHome, capacity, controller.signal, { async control() { throw new Error(); } });
  const budget = new MessageBudget();
  try {
    const url = `http://127.0.0.1:${bridge.port}/message`;
    for (const headers of [{ origin: "https://fixture.invalid" }, { authorization: "Bearer synthetic" }]) {
      expect((await fetch(url, { headers })).status).toBe(403);
    }
    expect((await fetch(`${url}?token=synthetic`)).status).toBe(403);
    const release = capacity.reserve("connections", REMOTE_LIMITS.connections);
    try { expect((await fetch(url)).status).toBe(503); } finally { release(); }
    expect(pair.b.calls).toHaveLength(0);
    const socket = await authenticatedRemoteSocket(pair.aStore.requireEnabled(), peerEndpoint(pair.aStore.peer("worker"), bridge.port), budget);
    const closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    pair.bStore.mutate(state => { state.peers = []; });
    socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await closed;
    expect(pair.b.calls).toHaveLength(0);
  } finally { budget.dispose(); await bridge.close(); await pair.close(); }
  expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
});
