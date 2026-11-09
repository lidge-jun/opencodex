import type { MuseCapturedCall } from "./capture-server";
import { MuseMspError } from "./connection";
import type { CodingAgentMcpTool } from "../coding-agent/mcp-server";

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error();
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > maxBytes) throw new Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error();
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function loadMuseCaptureCatalog(port: number, token: string, signal: AbortSignal): Promise<CodingAgentMcpTool[]> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(token)) throw new MuseMspError("invalid_capture_channel");
  try {
    const result = await boundedJson(await fetch(`http://127.0.0.1:${port}/catalog`, { redirect: "error", signal,
      headers: { authorization: `Bearer ${token}` } }), 2 * 1024 * 1024);
    if (!Array.isArray(result) || result.length > 128) throw new Error();
    return result as CodingAgentMcpTool[];
  } catch { throw new MuseMspError("capture_channel_failed"); }
}

/** Connect only to a caller-provided loopback port; never include the token in a URL. */
export async function sendMuseCapture(port: number, token: string, call: MuseCapturedCall, signal: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(token)) throw new MuseMspError("invalid_capture_channel");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/capture`, { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(call) });
    const result = await boundedJson(response, 6 * 1024 * 1024);
    if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string" ||
        Buffer.byteLength(result.output) > 4 * 1024 * 1024) throw new Error();
    return result.output;
  } catch { throw new MuseMspError("capture_channel_failed"); }
}
