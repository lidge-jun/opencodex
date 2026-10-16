import { MessageBudget } from "./budget";
import { discoverLoaded, resolveLoaded } from "./discovery";
import { messageEnvelope, validateMessage, type MessageOptions } from "./envelope";
import { LocalMessageRpc } from "./rpc";
import { localDaemonEndpoint } from "./socket";
import { isThreadId, LocalMessagingError, type LocalThread } from "./types";

export interface MessageReceipt {
  schema: "ocx-message/1";
  messageId: string;
  kind: MessageOptions["kind"];
  inReplyTo: string | null;
  status: "not_sent" | "queued" | "unknown";
  sender: { threadId: string; name: string | null; identitySource: "CODEX_THREAD_ID" } | null;
  target: { threadId: string; name: string | null } | null;
  error?: { code: string; message: string };
}

/** Expose caller-safe messaging errors without serializing arbitrary daemon output. */
export function messageFailure(error: unknown) {
  return error instanceof LocalMessagingError ? { code: error.code, message: error.message }
    : { code: "messaging_failed", message: "Local messaging failed; private daemon output is not included." };
}

/** Return a complete loaded-session snapshot and close the command-owned RPC connection. */
export async function localSessions(home: string, budget: MessageBudget): Promise<LocalThread[]> {
  const rpc = await LocalMessageRpc.connect(localDaemonEndpoint(home).url, budget);
  try { return await discoverLoaded(rpc, budget); } finally { rpc.close(); }
}

/** Revalidate and submit once on the discovery connection; never reconnect, resume or replay. */
export async function sendLocalMessage(options: MessageOptions & { thread?: string; name?: string; body: string },
  context: { home: string; senderId?: string }, budget: MessageBudget): Promise<MessageReceipt> {
  const receipt: MessageReceipt = { schema: "ocx-message/1", messageId: crypto.randomUUID(), kind: options.kind,
    inReplyTo: options.inReplyTo ?? null, status: "not_sent", sender: null, target: null };
  let rpc: LocalMessageRpc | undefined;
  try {
    validateMessage(options, options.body);
    if (context.senderId !== undefined && !isThreadId(context.senderId)) {
      throw new LocalMessagingError("invalid_sender", "CODEX_THREAD_ID is not a UUID; sender identity cannot be inferred.");
    }
    const endpoint = localDaemonEndpoint(context.home);
    rpc = await LocalMessageRpc.connect(endpoint.url, budget);
    const threads = await discoverLoaded(rpc, budget);
    const target = resolveLoaded(threads, options);
    receipt.target = { threadId: target.id, name: target.name };
    const sender = context.senderId ? resolveLoaded(threads, { thread: context.senderId }) : null;
    receipt.sender = sender ? { threadId: sender.id, name: sender.name, identitySource: "CODEX_THREAD_ID" } : null;
    const envelope = messageEnvelope(receipt.messageId, options, options.body, sender);
    // Recheck the exact resolved ID, never re-resolve a name or reconnect by path.
    const fresh = await rpc.readThread(target.id);
    if (fresh.status === "notLoaded") throw new LocalMessagingError("target_not_loaded", "The destination unloaded before submission.");
    budget.throwIfEnded();
    Object.assign(receipt, await rpc.queueMessage(target.id, envelope.text, receipt.messageId));
  } catch (error) { receipt.error = messageFailure(error); }
  finally { rpc?.close(); }
  return receipt;
}
