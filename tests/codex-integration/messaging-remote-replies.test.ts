import { expect, test } from "bun:test";
import { messageEnvelope } from "../../src/messaging/envelope";
import { RemoteReplyGrants, REPLY_GRANT_LIMIT, REPLY_GRANT_MS } from "../../src/messaging/remote-replies";
import { parseRemoteState } from "../../src/messaging/remote-store";
import { LOCAL_OTHER, LOCAL_TARGET } from "../helpers/messaging-local";
import { remoteMessagingPair } from "../helpers/messaging-remote";

test.skipIf(process.platform === "win32")("reply grants bind peer, generation, local target, kind and correlation before await", async () => {
  const pair = remoteMessagingPair();
  let now = 0;
  const grants = new RemoteReplyGrants(pair.aStore, () => now), peer = pair.aStore.peer("worker"), id = crypto.randomUUID();
  const registration = { peerId: peer.machine.id, transaction: peer.transaction, messageId: id, threadId: LOCAL_OTHER, action: "open" };
  const response = messageEnvelope(crypto.randomUUID(), { kind: "response", inReplyTo: id }, "fixture", null, peer.machine).header;
  try {
    grants.control(registration);
    expect(grants.visible(peer, LOCAL_OTHER)).toBe(true);
    for (const [origin, header, target] of [[{ ...peer, transaction: crypto.randomUUID() }, response, LOCAL_OTHER],
      [peer, response, LOCAL_TARGET], [peer, { ...response, inReplyTo: crypto.randomUUID() }, LOCAL_OTHER],
      [peer, { ...response, kind: "request" as const }, LOCAL_OTHER]] as const) {
      expect(() => grants.begin(origin, header, target)).toThrow();
    }
    const settle = grants.begin(peer, response, LOCAL_OTHER);
    expect(() => grants.begin(peer, response, LOCAL_OTHER)).toThrow("correlated response");
    settle(false); // Native rejection restores eligibility; it is not a permission to resend automatically.
    expect(grants.visible(peer, LOCAL_OTHER)).toBe(true);
    grants.begin(peer, response, LOCAL_OTHER)(true); // Queued OR unknown consumes it.
    expect(() => grants.begin(peer, response, LOCAL_OTHER)).toThrow("correlated response");
    grants.control({ ...registration, messageId: crypto.randomUUID() });
    now = REPLY_GRANT_MS;
    expect(grants.visible(peer, LOCAL_OTHER)).toBe(false);
    grants.control({ ...registration, messageId: crypto.randomUUID() });
    pair.aStore.mutate(state => { state.peers[0]!.transaction = crypto.randomUUID(); });
    expect(grants.visible(peer, LOCAL_OTHER)).toBe(false);
    expect(new RemoteReplyGrants(pair.aStore).visible(pair.aStore.peer("worker"), LOCAL_OTHER)).toBe(false);
  } finally { await pair.close(); }
});

test.skipIf(process.platform === "win32")("legacy missing inbound policy is response-only; invalid consent is never coerced", async () => {
  const pair = remoteMessagingPair();
  try {
    const raw = pair.bStore.requireEnabled();
    delete raw.peers[0]!.allowInbound;
    expect(parseRemoteState(raw).peers[0]?.allowInbound).toBeUndefined();
    pair.bStore.mutate(state => { delete state.peers[0]!.allowInbound; });
    expect(new RemoteReplyGrants(pair.bStore).visible(pair.bStore.peer(raw.peers[0]!.machine.id), LOCAL_TARGET)).toBe(false);
    for (const bad of [null, "true", 1]) {
      expect(() => parseRemoteState({ ...raw, peers: [{ ...raw.peers[0], allowInbound: bad }] })).toThrow();
    }
  } finally { await pair.close(); }
});

test.skipIf(process.platform === "win32")("broad consent consumes matching grants without spending unrelated targets' routes", async () => {
  const pair = remoteMessagingPair(), grants = new RemoteReplyGrants(pair.aStore), peer = pair.aStore.peer("worker");
  try {
    for (const submitted of [false, true]) {
      const id = crypto.randomUUID();
      const response = messageEnvelope(crypto.randomUUID(), { kind: "response", inReplyTo: id }, "fixture", null, peer.machine).header;
      grants.control({ peerId: peer.machine.id, transaction: peer.transaction, messageId: id, threadId: LOCAL_OTHER, action: "open" });
      pair.aStore.setInbound("worker", true);
      grants.begin(peer, response, LOCAL_TARGET)(true); // Broad unrelated traffic must not spend the original route.
      pair.aStore.setInbound("worker", false);
      expect(grants.visible(peer, LOCAL_OTHER)).toBe(true);
      pair.aStore.setInbound("worker", true);
      const settle = grants.begin(peer, response, LOCAL_OTHER);
      expect(() => grants.begin(peer, response, LOCAL_OTHER)).toThrow("already in flight");
      settle(submitted);
      pair.aStore.setInbound("worker", false);
      if (submitted) expect(() => grants.begin(peer, response, LOCAL_OTHER)).toThrow("correlated response");
      else grants.begin(peer, response, LOCAL_OTHER)(true);
      expect(grants.visible(peer, LOCAL_OTHER)).toBe(false);
    }
  } finally { await pair.close(); }
});

test.skipIf(process.platform === "win32")("reply routes have fixed capacity and definite non-submission can forget its exact grant", async () => {
  const pair = remoteMessagingPair(), grants = new RemoteReplyGrants(pair.aStore), peer = pair.aStore.peer("worker");
  const request = { peerId: peer.machine.id, transaction: peer.transaction, messageId: crypto.randomUUID(), threadId: LOCAL_OTHER, action: "open" };
  try {
    grants.control(request);
    expect(() => grants.control(request)).toThrow("capacity");
    expect(() => grants.control({ ...request, threadId: LOCAL_TARGET, action: "forget" })).toThrow("not removable");
    grants.control({ ...request, action: "forget" });
    expect(grants.visible(peer, LOCAL_OTHER)).toBe(false);
    for (let i = 0; i < REPLY_GRANT_LIMIT; i++) grants.control({ ...request, messageId: crypto.randomUUID() });
    expect(() => grants.control({ ...request, messageId: crypto.randomUUID() })).toThrow("capacity");
  } finally { await pair.close(); }
});
