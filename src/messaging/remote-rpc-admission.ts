import { exactRecord, remoteError } from "./remote-contract";
import { isThreadId } from "./types";

/** Validate only the native operations this gateway implements; never pass arbitrary JSON-RPC through. */
export function admitRemoteRpc(method: string, value: unknown): Record<string, unknown> {
  if (method === "initialize") {
    const raw = exactRecord(value, ["clientInfo", "capabilities"]);
    const client = exactRecord(raw.clientInfo, ["name", "version"]);
    const caps = exactRecord(raw.capabilities, ["experimentalApi"]);
    if (client.name !== "opencodex_message" || client.version !== "1.0.0" || caps.experimentalApi !== true) throw new Error();
    return raw;
  }
  if (method === "initialized") return exactRecord(value, []);
  if (method === "thread/loaded/list") {
    const raw = exactRecord(value, value && typeof value === "object" && Object.hasOwn(value, "cursor") ? ["limit", "cursor"] : ["limit"]);
    if (raw.limit !== 50 || (raw.cursor !== undefined && (typeof raw.cursor !== "string" || !raw.cursor || raw.cursor.length > 4096))) throw new Error();
    return raw;
  }
  if (method === "thread/read") {
    const raw = exactRecord(value, ["threadId", "includeTurns"]);
    if (!isThreadId(raw.threadId) || raw.includeTurns !== false) throw new Error(); return raw;
  }
  if (method === "thread/queue/add") {
    const raw = exactRecord(value, ["threadId", "input", "clientUserMessageId"]);
    if (!isThreadId(raw.threadId) || !isThreadId(raw.clientUserMessageId) || !Array.isArray(raw.input) || raw.input.length !== 1) throw new Error();
    const input = exactRecord(raw.input[0], ["type", "text"]);
    if (input.type !== "text" || typeof input.text !== "string" || !input.text.trim()
      || input.text.includes("\0") || Buffer.byteLength(input.text) > 32 * 1024) throw new Error();
    return raw;
  }
  throw remoteError("remote_method_refused", "This RPC method is not admitted by the messaging gateway.");
}
