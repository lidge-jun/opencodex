import { z } from "zod";
import { isAbsolute } from "node:path";
import { MessageBudget } from "./budget";
import { isResumeProfile } from "./resume-permissions";
import { LocalMessageRpc } from "./rpc";
import { isThreadId, LocalMessagingError } from "./types";
import type { QueueMcpOptions } from "./mcp-queue-rpc";

export const resumeThreadInput = { threadId: z.string().refine(isThreadId, "Use an exact thread UUID") };

/** Explicit resume preflight connects only to an existing trusted local Unix server; it creates nothing. */
export async function queueMcpResume(options: QueueMcpOptions, raw: { threadId: string }, signal?: AbortSignal) {
  const failure = (code: string) => ({ status: "not_resumed" as const, executionVerified: false, error: { code } });
  if (!options.allowResume || !options.resumeSocket || !isResumeProfile(options.resumePermissions)) return failure("resume_disabled");
  const parsed = z.object(resumeThreadInput).strict().safeParse(raw);
  if (!parsed.success || !isAbsolute(options.codexHome) || !isAbsolute(options.resumeSocket)) return failure("resume_invalid_input");
  const budget = new MessageBudget(20_000, signal);
  let rpc: LocalMessageRpc | undefined;
  try {
    rpc = await LocalMessageRpc.connectForResume(`ws+unix://${options.resumeSocket}:/`, budget, options.codexHome);
    const threadId = parsed.data.threadId.toLowerCase();
    return { ...await rpc.resumeThread(threadId, options.resumePermissions), threadId, executionVerified: false };
  } catch (error) { return failure(error instanceof LocalMessagingError ? error.code : "resume_unavailable"); }
  finally { rpc?.close(); budget.dispose(); }
}
