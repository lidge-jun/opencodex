import { expect, test } from "bun:test";
import { MessageBudget } from "../../src/messaging/budget";
import { sendRemoteMessage, remoteSessions } from "../../src/messaging/remote-send";
import { LocalFixtureRpcError, LOCAL_OTHER, LOCAL_TARGET, NO_REPLY } from "../helpers/messaging-local";
import { remoteMessagingPair } from "../helpers/messaging-remote";

test.skipIf(process.platform === "win32")("remote discovery/queue share one proven destination connection and generate a machine-aware reply route", async () => {
  const pair = remoteMessagingPair(), owners = await pair.owners(), budget = new MessageBudget();
  try {
    const snapshot = await remoteSessions(pair.aStore, "worker", budget);
    expect(snapshot.sessions).toEqual([{ id: LOCAL_TARGET, name: "recipient", status: "idle" }]);
    const before = pair.b.connectionCount;
    const receipt = await sendRemoteMessage(pair.aStore, { host: "worker", name: "recipient", body: "private fixture body", kind: "request" },
      { home: pair.a.codexHome, senderId: LOCAL_OTHER }, budget);
    expect(receipt.status).toBe("queued"); expect(pair.b.connectionCount - before).toBe(1);
    const calls = pair.b.calls.filter(call => call.method === "thread/queue/add"); expect(calls).toHaveLength(1);
    const text = (calls[0]!.params.input as { text: string }[])[0]!.text;
    const header = JSON.parse(text.slice("[opencodex-message ".length, text.indexOf("]\n")));
    expect(header.reply.host).toBe(pair.aStore.requireEnabled().machine.id);
    expect(header.reply.thread).toBe(LOCAL_OTHER); expect(header.name).toBe("sender");
    expect(header.replyCommand).toContain(`--host ${header.reply.host} --thread ${LOCAL_OTHER}`);
    expect(JSON.stringify(receipt)).not.toContain("private fixture body"); expect(pair.b.failures).toEqual([]);
    // A return-only node can respond without SSH credentials or a reverse enrollment.
    const reply = await sendRemoteMessage(pair.bStore, { host: header.reply.host, thread: LOCAL_OTHER,
      kind: "response", inReplyTo: receipt.messageId, body: "response fixture" }, { home: pair.b.codexHome }, budget);
    expect(reply.status).toBe("queued"); expect(pair.bStore.peer(header.reply.host).ssh).toBeNull();
  } finally { budget.dispose(); await owners.close(); await pair.close(); }
  expect(owners.aOwner.capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
});

for (const mode of ["rejected", "unsupported", "lost", "malformed", "unloaded"] as const) {
  test.skipIf(process.platform === "win32")(`remote ${mode} preserves precise receipt and never replays`, async () => {
    let reads = 0;
    const pair = remoteMessagingPair(call => {
      if (call.method === "thread/read" && mode === "unloaded" && ++reads === 2) return {
        thread: { id: LOCAL_TARGET, name: "recipient", status: { type: "notLoaded" } },
      };
      if (call.method !== "thread/queue/add") return;
      if (mode === "rejected") return new LocalFixtureRpcError(-32000, "private native text");
      if (mode === "unsupported") return new LocalFixtureRpcError(-32601, "private native text");
      if (mode === "malformed") return { queuedSubmission: { id: "submission", input: call.params.input, clientUserMessageId: LOCAL_OTHER } };
      pair.b.closeConnections(); return NO_REPLY;
    });
    const owners = await pair.owners(), budget = new MessageBudget();
    try {
      const receipt = await sendRemoteMessage(pair.aStore, { host: "worker", thread: LOCAL_TARGET, kind: "notification", body: "private body" }, { home: pair.a.codexHome }, budget);
      expect(receipt.status).toBe(mode === "lost" || mode === "malformed" ? "unknown" : "not_sent");
      expect(JSON.stringify(receipt)).not.toContain("private");
      expect(pair.b.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(mode === "unloaded" ? 0 : 1);
      if (mode === "unsupported") expect(receipt.error?.code).toBe("unsupported_queue");
    } finally { budget.dispose(); await owners.close(); await pair.close(); }
  });
}

test.skipIf(process.platform === "win32")("revoked peers and missing owners cannot submit, enable/start is never inferred", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget();
  try {
    let receipt = await sendRemoteMessage(pair.aStore, { host: "worker", thread: LOCAL_TARGET, kind: "notification", body: "fixture" }, { home: pair.a.codexHome }, budget);
    expect(receipt.status).toBe("not_sent"); expect(pair.b.calls).toHaveLength(0);
    const owners = await pair.owners();
    try {
      pair.bStore.mutate(state => { state.peers = []; });
      receipt = await sendRemoteMessage(pair.aStore, { host: "worker", thread: LOCAL_TARGET, kind: "notification", body: "fixture" }, { home: pair.a.codexHome }, budget);
      expect(receipt.status).toBe("not_sent"); expect(pair.b.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
    } finally { await owners.close(); }
  } finally { budget.dispose(); await pair.close(); }
});
