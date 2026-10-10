import { MessageBudget } from "../../src/messaging/budget";
import { capability, REMOTE_PROTOCOL } from "../../src/messaging/remote-contract";
import { handleEnrollmentControl } from "../../src/messaging/remote-enrollment";
import { remoteControl, peerEndpoint } from "../../src/messaging/remote-auth";
import { startRemoteOwner } from "../../src/messaging/remote-owner";
import { remotePortCandidate } from "../../src/messaging/remote-ports";
import { RemoteMessageStore } from "../../src/messaging/remote-store";
import { join } from "node:path";
import { localMessagingFixture, LOCAL_OTHER, LOCAL_TARGET, localFixtureThread, type LocalCall } from "./messaging-local";

/** Two isolated native Unix fixtures and private stores; no user's homes, SSH keys or agents. */
export function remoteMessagingPair(handler?: (call: LocalCall) => unknown | Promise<unknown>,
  senderHandler?: (call: LocalCall) => unknown | Promise<unknown>) {
  const a = localMessagingFixture(async call => await senderHandler?.(call) ?? (call.method === "thread/loaded/list"
    ? { data: [LOCAL_OTHER], nextCursor: null } : call.method === "thread/read" ? { thread: localFixtureThread(LOCAL_OTHER, "sender") } : undefined));
  const b = localMessagingFixture(handler);
  const aStore = new RemoteMessageStore(join(a.root, "ocx")), bStore = new RemoteMessageStore(join(b.root, "ocx"));
  const aState = aStore.enable(remotePortCandidate()), bState = bStore.enable(remotePortCandidate());
  const transaction = crypto.randomUUID(), incoming = capability();
  const reply = handleEnrollmentControl(bStore, { protocol: REMOTE_PROTOCOL, action: "enroll",
    params: { machine: aState.machine, transaction, returnCapability: incoming, port: aState.port } }) as { capability: string };
  aStore.mutate(state => { state.peers.push({ alias: "worker", machine: bState.machine, transaction, incoming,
    outgoing: reply.capability, port: bState.port, ssh: null, hostKey: null, fingerprint: null }); });
  return { a, b, aStore, bStore,
    async owners(destinationHome = b.codexHome) {
      const aOwner = await startRemoteOwner(aStore, a.codexHome, []), bOwner = await startRemoteOwner(bStore, destinationHome, []);
      const budget = new MessageBudget();
      try {
        // Offline lease fixture: TCP paths substitute for SSH forwarding; real SSH is a separate opt-in test.
        await remoteControl(aStore.requireEnabled(), peerEndpoint(aStore.peer("worker"), bOwner.port), "message/lease",
          { port: aOwner.port, generation: crypto.randomUUID() }, budget);
        await remoteControl(bStore.requireEnabled(), peerEndpoint(bStore.peer(aState.machine.id), aOwner.port), "message/lease",
          { port: bOwner.port, generation: crypto.randomUUID() }, budget);
      } catch (error) { await Promise.all([aOwner.close(), bOwner.close()]); throw error; }
      finally { budget.dispose(); }
      return { aOwner, bOwner, close: () => Promise.all([aOwner.close(), bOwner.close()]) };
    },
    close: () => Promise.all([a.close(), b.close()]), LOCAL_OTHER, LOCAL_TARGET,
  };
}
