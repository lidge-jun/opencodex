import { isAbsolute } from "node:path";
import type { QueueMcpOptions } from "../messaging/mcp-queue-rpc";

/** Validate all syntax before importing the MCP host or resolving any executable/home. */
export function parseQueueMcpArgs(argv: readonly string[]): QueueMcpOptions | null {
  if (argv.length !== 4) return null;
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1]!;
    if (!["--codex", "--codex-home"].includes(flag) || values[flag] !== undefined
      || !value || !isAbsolute(value) || /[\x00-\x1f]/.test(value)) return null;
    values[flag] = value;
  }
  return values["--codex"] && values["--codex-home"] ? { codex: values["--codex"], codexHome: values["--codex-home"] } : null;
}

export async function runMessageMcpCommand(argv: readonly string[]): Promise<number> {
  const options = parseQueueMcpArgs(argv);
  if (!options) {
    console.error("Usage: ocx message mcp --codex <absolute-cli-path> --codex-home <absolute-existing-home>");
    return 64;
  }
  if (process.platform === "win32") {
    console.error("Queue MCP currently supports macOS and Linux only.");
    return 1;
  }
  try { await (await import("../messaging/mcp-queue-server")).serveQueueMcp(options); return 0; }
  catch { console.error("Queue MCP could not serve the stdio connection."); return 1; }
}
