import { isResumeProfile } from "../messaging/resume-permissions";
import { isAbsolute } from "node:path";
import type { QueueMcpOptions } from "../messaging/mcp-queue-rpc";

/** Validate all syntax before importing the MCP host or resolving any executable/home. */
export function parseQueueMcpArgs(argv: readonly string[]): QueueMcpOptions | null {
  const reads = argv.filter(arg => arg === "--allow-reply-read").length;
  const resume = argv.filter(arg => arg === "--allow-resume").length;
  if (reads > 1 || resume > 1) return null;
  const paths = argv.filter(arg => !["--allow-reply-read", "--allow-resume"].includes(arg));
  if (paths.length !== (resume ? 8 : 4)) return null;
  const values: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 2) {
    const flag = paths[i]!, value = paths[i + 1]!;
    if (!["--codex", "--codex-home", ...(resume ? ["--resume-socket", "--resume-permissions"] : [])].includes(flag) || values[flag] !== undefined
      || !value || (flag === "--resume-permissions" ? !isResumeProfile(value) : !isAbsolute(value)) || /[\x00-\x1f]/.test(value)) return null;
    values[flag] = value;
  }
  return values["--codex"] && values["--codex-home"] && (!resume || (values["--resume-socket"] && values["--resume-permissions"]))
    ? { codex: values["--codex"], codexHome: values["--codex-home"], ...(reads ? { allowReplyRead: true } : {}),
      ...(resume ? { allowResume: true, resumeSocket: values["--resume-socket"], resumePermissions: values["--resume-permissions"] } : {}) } : null;
}

export async function runMessageMcpCommand(argv: readonly string[]): Promise<number> {
  const options = parseQueueMcpArgs(argv);
  if (!options) {
    console.error("Usage: ocx message mcp --codex <absolute-cli-path> --codex-home <absolute-existing-home> [--allow-reply-read] [--allow-resume --resume-socket <absolute-existing-unix-socket> --resume-permissions <profile-id>]");
    return 64;
  }
  if (process.platform === "win32") {
    console.error("Queue MCP currently supports macOS and Linux only.");
    return 1;
  }
  try { await (await import("../messaging/mcp-queue-server")).serveQueueMcp(options); return 0; }
  catch { console.error("Queue MCP could not serve the stdio connection."); return 1; }
}
