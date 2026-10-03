import { MessageBudget } from "./budget";
import { discoverLoaded, resolveLoaded } from "./discovery";
import { messageEnvelope, validateMessage, type MessageOptions } from "./envelope";
import { preflightNative, withNativeMessageHome, type MessageRunner, type NativeMessageRuntime } from "./native";
import { runMessageProcess } from "./process";
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

export function messageFailure(error: unknown) {
  return error instanceof LocalMessagingError ? { code: error.code, message: error.message }
    : { code: "messaging_failed", message: "Local messaging failed; private helper output is not included." };
}

export async function localSessions(home: string, budget: MessageBudget): Promise<LocalThread[]> {
  const rpc = await LocalMessageRpc.connect(localDaemonEndpoint(home).url, budget);
  try { return await discoverLoaded(rpc, budget); } finally { rpc.close(); }
}

/** Native submission is invoked once; after spawn, any incomplete result is unknown. */
export async function sendLocalMessage(options: MessageOptions & { thread?: string; name?: string; body: string },
  context: { home: string; senderId?: string; runtime(): NativeMessageRuntime }, budget: MessageBudget,
  run: MessageRunner = runMessageProcess): Promise<MessageReceipt> {
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
    const runtime = context.runtime();
    await withNativeMessageHome(runtime.path, async env => {
      await preflightNative(runtime, budget, env, run);
      // The preflight may take seconds. Recheck the exact resolved ID, never re-resolve a name.
      const fresh = await rpc!.readThread(target.id);
      if (fresh.status === "notLoaded") throw new LocalMessagingError("target_not_loaded", "The destination unloaded before submission.");
      budget.throwIfEnded();
      const argv = runtime.argv(["queue", "--thread", target.id, "--message", envelope.text, "--remote", endpoint.nativeUrl]);
      try {
        const result = await run(argv, budget, { env });
        receipt.status = result.exitCode === 0 ? "queued" : "unknown";
        if (receipt.status === "unknown") receipt.error = { code: "submission_unknown", message: "Native queue did not acknowledge success. Do not replay; recipient processing is unknown." };
      } catch (error) {
        const beforeSpawn = error instanceof LocalMessagingError && ["process_not_started", "cancelled", "operation_timeout"].includes(error.code);
        receipt.status = beforeSpawn ? "not_sent" : "unknown";
        receipt.error = beforeSpawn ? messageFailure(error)
          : { code: "submission_unknown", message: "Native queue submission may have occurred. Do not replay; recipient processing is unknown." };
      }
    });
  } catch (error) { receipt.error = messageFailure(error); }
  finally { rpc?.close(); }
  return receipt;
}
