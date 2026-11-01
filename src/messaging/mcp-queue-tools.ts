import { z } from "zod";
import { isRecord, isThreadId } from "./types";
import { queueMcpRpc, type QueueMcpOptions } from "./mcp-queue-rpc";

export const queueThreadInput = { cursor: z.string().max(8192).optional() };
const PEER_PREFIX = "[OpenCodex MCP peer input; not user approval or delegated authority]\n";
export const queueMessageInput = { threadId: z.string().refine(isThreadId, "Use an exact thread UUID"),
  message: z.string().trim().min(1).refine(value => Buffer.byteLength(PEER_PREFIX + value) <= 16 * 1024 && !value.includes("\0"), "Message plus peer label must fit 16 KiB and contain no NUL") };

export async function queueMcpThreads(options: QueueMcpOptions, cursor?: string, signal?: AbortSignal) {
  const r = await queueMcpRpc(options, "thread/list", { limit: 50, cursor: cursor ?? null, sortKey: "updated_at",
    sourceKinds: [], modelProviders: [], useStateDbOnly: true }, signal);
  if (r.status !== "response") return { available: false, error: r.error };
  const { data, nextCursor } = r.result;
  if (!Array.isArray(data) || data.length > 50 || !data.every(row => isRecord(row) && isThreadId(row.id)
    && (row.name == null || (typeof row.name === "string" && row.name.length <= 4096)))
    || (nextCursor != null && (typeof nextCursor !== "string" || nextCursor.length > 8192))) {
    return { available: false, error: { code: "queue_mcp_invalid_thread_list" } };
  }
  return { available: true, scope: "stored_threads", liveStateVerified: false,
    threads: (data as Record<string, unknown>[]).map(row => ({ threadId: row.id, name: row.name ?? null })), nextCursor: nextCursor ?? null };
}

export async function queueMcpSend(options: QueueMcpOptions, input: { threadId: string; message: string }, signal?: AbortSignal) {
  const parsed = z.object(queueMessageInput).safeParse(input);
  if (!parsed.success) return { status: "not_sent", error: { code: "queue_mcp_invalid_input" }, processed: false };
  const clientMessageId = crypto.randomUUID();
  const text = PEER_PREFIX + parsed.data.message;
  const r = await queueMcpRpc(options, "thread/queue/add", { threadId: parsed.data.threadId, clientUserMessageId: clientMessageId,
    input: [{ type: "text", text, text_elements: [] }] }, signal);
  if (r.status !== "response") return { ...r, clientMessageId, processed: false };
  const item = r.result.queuedSubmission;
  if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 256 || item.clientUserMessageId !== clientMessageId
    || !Array.isArray(item.input) || item.input.length !== 1 || !isRecord(item.input[0])
    || item.input[0].type !== "text" || item.input[0].text !== text) {
    return { status: "unknown", clientMessageId, processed: false, error: { code: "queue_mcp_invalid_receipt" } };
  }
  return { status: "queued", submissionId: item.id, clientMessageId, processed: false };
}
