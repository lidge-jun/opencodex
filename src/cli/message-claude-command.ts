import { isAbsolute } from "node:path";
import { discoverClaudeSessions } from "../messaging/claude-discovery";
import { LocalMessagingError } from "../messaging/types";

export async function runMessageClaudeCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  let claude: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--json" && !json) json = true;
    else if (flag === "--claude" && claude === undefined) claude = argv[++index];
    else { claude = undefined; break; }
  }
  if (!claude || !isAbsolute(claude) || /[\x00-\x1f]/.test(claude)) {
    console.error("Usage: ocx message claude-sessions --claude <absolute-cli-path> [--json]");
    return 64;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new LocalMessagingError("unsupported_platform", "Claude Code session discovery currently supports macOS and Linux only.");
    }
    const sessions = await discoverClaudeSessions(claude, env, controller.signal);
    if (json) console.log(JSON.stringify({ schema: "ocx-claude-sessions/1", sessions }));
    else for (const session of sessions) console.log(`${session.id}\t${session.kind}\t${session.status}`);
    return 0;
  } catch (cause) {
    const error = cause instanceof LocalMessagingError ? { code: cause.code, message: cause.message }
      : { code: "claude_directory_unavailable", message: "Local Claude Code session discovery failed." };
    if (json) console.log(JSON.stringify({ schema: "ocx-message-error/1", error }));
    else console.error(error.message);
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
