import { MessageBudget } from "../messaging/budget";
import { readMessageInput } from "../messaging/input";
import { localSessions, messageFailure, sendLocalMessage } from "../messaging/send";
import { parseMessageArgs } from "./message-args";
import { terminalSafeText } from "./runtime-api";

export async function runMessageCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseMessageArgs(argv);
  if (!args) {
    console.error("Usage: ocx message sessions [--json] | send (--thread <uuid> | --name <exact-name>) --stdin [--kind request|response|notification] [--in-reply-to <uuid>] [--json]");
    return 64;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const budget = new MessageBudget(30_000, controller.signal);
  try {
    // Keep home/runtime selection on this command path and after syntax validation.
    const { messageCodexHome, messageCodexRuntime } = await import("./message-runtime");
    const home = messageCodexHome(env);
    if (args.action === "sessions") {
      const sessions = await localSessions(home, budget);
      if (args.json) console.log(JSON.stringify({ schema: "ocx-message-sessions/1", sessions }));
      else for (const session of sessions) console.log(terminalSafeText(`${session.id}\t${session.status}\t${session.name ?? "(unnamed)"}`));
      return 0;
    }
    const body = await readMessageInput(Bun.stdin.stream(), budget);
    const receipt = await sendLocalMessage({ ...args, body },
      { home, senderId: env.CODEX_THREAD_ID, runtime: () => messageCodexRuntime(env) }, budget);
    if (args.json) console.log(JSON.stringify(receipt));
    else console.log(terminalSafeText(`${receipt.status}: ${receipt.messageId}${receipt.error ? ` — ${receipt.error.message}` : " (submitted, not proof of processing)"}`));
    return receipt.status === "queued" ? 0 : receipt.status === "unknown" ? 3 : 1;
  } catch (error) {
    const failure = { schema: "ocx-message-error/1", ...(args.action === "send" ? { status: "not_sent" } : {}), error: messageFailure(error) };
    if (args.json) console.log(JSON.stringify(failure));
    else console.error(failure.error.message);
    return 1;
  } finally {
    budget.dispose();
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
