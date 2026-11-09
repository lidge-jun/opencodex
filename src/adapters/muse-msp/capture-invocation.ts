import { fileURLToPath } from "node:url";
import { isStandaloneBinary } from "../../lib/standalone";

/** Launch the capture-only MCP child from source or the compiled CLI. */
export function museCaptureInvocation(standalone = isStandaloneBinary()): { executable: string; args: string[] } {
  return { executable: process.execPath, args: standalone ? ["__muse-mcp"] : [fileURLToPath(new URL("./capture-child.ts", import.meta.url))] };
}
