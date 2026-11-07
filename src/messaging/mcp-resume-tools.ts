import { z } from "zod";
import { isAbsolute } from "node:path";
import { MessageBudget } from "./budget";
import { LocalMessageRpc } from "./rpc";
import { isThreadId, LocalMessagingError } from "./types";
import type { QueueMcpOptions } from "./mcp-queue-rpc";

export const resumeThreadInput = { threadId: z.string().refine(isThreadId, "Use an exact thread UUID") };

/** Explicit execution access connects only to an existing trusted local Unix server; it creates nothing. */
export async function queueMcpResume(options: QueueMcpOptions, raw: { threadId: string }, signal?: AbortSignal) {
  const failure = (code: string) => ({ status: "not_resumed" as const, executionVerified: false, error: { code } });
  if (!options.allowResume || !options.resumeSocket) return failure("resume_disabled");
  const parsed = z.object(resumeThreadInput).strict().safeParse(raw);
  if (!parsed.success || !isAbsolute(options.codexHome) || !isAbsolute(options.resumeSocket)) return failure("resume_invalid_input");
  const budget = new MessageBudget(20_000, signal);
  let rpc: LocalMessageRpc | undefined;
  try {
    rpc = await LocalMessageRpc.connectForResume(`ws+unix://${options.resumeSocket}:/`, budget, options.codexHome);
    const thread = await rpc.readThread(parsed.data.threadId.toLowerCase());
    if (thread.status === "systemError") return failure("resume_target_unhealthy");
    if (thread.status !== "notLoaded") return { status: "already_loaded" as const, threadId: thread.id,
      observedStatus: thread.status, executionVerified: false };
    return { ...await rpc.resumeThread(thread.id), threadId: thread.id, executionVerified: false };
  } catch (error) { return failure(error instanceof LocalMessagingError ? error.code : "resume_unavailable"); }
  finally { rpc?.close(); budget.dispose(); }
}
