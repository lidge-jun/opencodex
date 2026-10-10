import { MessageBudget } from "./budget";
import { authenticatedRemoteSocket } from "./remote-auth";
import { discoverLoaded, resolveLoaded } from "./discovery";
import { messageEnvelope, validateMessage, type MessageOptions } from "./envelope";
import { resolveRemoteRoute } from "./remote-owner";
import { LocalMessageRpc } from "./rpc";
import { localDaemonEndpoint } from "./socket";
import { messageFailure, type MessageReceipt } from "./send";
import type { RemoteMessageStore } from "./remote-store";
import { isThreadId, LocalMessagingError } from "./types";

/** Remote discovery is explicit and loaded-only; it uses a live owner route and one proven connection. */
export async function remoteSessions(store: RemoteMessageStore, host: string, budget: MessageBudget) {
  const route = await resolveRemoteRoute(store, host, budget);
  store.requireCurrentPeer(route.state, route.peer);
  const rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(route.state, route.endpoint, budget), budget);
  try {
    const sessions = await discoverLoaded(rpc, budget);
    store.requireCurrentPeer(route.state, route.peer);
    return { machine: route.peer.machine, sessions };
  }
  finally { rpc.close(); }
}
/** Attribute locally, discover/revalidate/queue remotely on one socket, and never replay an unknown result. */
export async function sendRemoteMessage(store: RemoteMessageStore,
  options: MessageOptions & { host: string; thread?: string; name?: string; body: string },
  context: { home: string; senderId?: string }, budget: MessageBudget) {
  const receipt: MessageReceipt & { machine?: { id: string; name: string }; targetMachine?: { id: string; name: string } } = {
    schema: "ocx-message/1", messageId: crypto.randomUUID(), kind: options.kind, inReplyTo: options.inReplyTo ?? null,
    status: "not_sent", sender: null, target: null,
  };
  let rpc: LocalMessageRpc | undefined;
  try {
    validateMessage(options, options.body);
    if (context.senderId !== undefined && !isThreadId(context.senderId)) throw new LocalMessagingError("invalid_sender", "CODEX_THREAD_ID must be a UUID, not a claimed peer identity.");
    const route = await resolveRemoteRoute(store, options.host, budget);
    receipt.machine = route.state.machine; receipt.targetMachine = route.peer.machine;
    let sender = null;
    if (context.senderId) {
      const local = await LocalMessageRpc.connect(localDaemonEndpoint(context.home).url, budget);
      try { sender = resolveLoaded(await discoverLoaded(local, budget), { thread: context.senderId }); }
      finally { local.close(); }
    }
    receipt.sender = sender ? { threadId: sender.id, name: sender.name, identitySource: "CODEX_THREAD_ID" } : null;
    store.requireCurrentPeer(route.state, route.peer);
    rpc = await LocalMessageRpc.attach(await authenticatedRemoteSocket(route.state, route.endpoint, budget), budget);
    const target = resolveLoaded(await discoverLoaded(rpc, budget), options);
    receipt.target = { threadId: target.id, name: target.name };
    const envelope = messageEnvelope(receipt.messageId, options, options.body, sender, route.state.machine);
    const fresh = await rpc.readThread(target.id);
    if (fresh.status === "notLoaded") throw new LocalMessagingError("target_not_loaded", "The destination unloaded before remote submission.");
    budget.throwIfEnded();
    store.requireCurrentPeer(route.state, route.peer);
    Object.assign(receipt, await rpc.queueMessage(target.id, envelope.text, receipt.messageId));
  } catch (error) { receipt.error = messageFailure(error); }
  finally { rpc?.close(); }
  return receipt;
}
