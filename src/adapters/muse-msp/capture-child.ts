import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMuseCaptureServer } from "./capture-server";
import { loadMuseCaptureCatalog, sendMuseCapture } from "./capture-channel-client";

/** Stdio MCP child; configuration is inherited, never placed in argv or output. */
export async function runMuseCaptureChild(env: NodeJS.ProcessEnv): Promise<void> {
  const port = Number(env.OCX_MUSE_CAPTURE_PORT), token = env.OCX_MUSE_CAPTURE_TOKEN ?? "";
  const catalog = await loadMuseCaptureCatalog(port, token, AbortSignal.timeout(10_000));
  const server = createMuseCaptureServer(catalog, (call, signal) => sendMuseCapture(port, token, call, signal));
  process.stdin.on("end", () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  // Do not print configuration, input or exception details on child failure.
  runMuseCaptureChild(process.env).catch(() => { process.exitCode = 1; });
}
