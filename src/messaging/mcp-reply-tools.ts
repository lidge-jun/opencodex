import { z } from "zod";
import { MessageBudget } from "./budget";
import { isRecord, isThreadId } from "./types";
import { queueMcpRpc, type QueueMcpOptions } from "./mcp-queue-rpc";
import { decodeReplyCursor, encodeReplyCursor, replyInput, type ReplyInput } from "./mcp-reply-cursor";

type Entry = { turnId: string; item: Record<string, unknown> & { id: string; type: string } };
/** IDs are bounded opaque wire identifiers, not permission or filesystem paths. */
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);

/** Validate only the item envelope and fields used for correlation/projection; discard all other data. */
function entries(data: unknown, limit: number, turnId?: string): Entry[] {
  if (!Array.isArray(data) || data.length > limit) throw new Error("invalid page");
  const seen = new Set<string>();
  for (const row of data) {
    if (!isRecord(row) || !isThreadId(row.turnId) || (turnId && row.turnId !== turnId) || !isRecord(row.item)
      || !validId(row.item.id) || !validId(row.item.type) || seen.has(row.item.id)) throw new Error("invalid page");
    seen.add(row.item.id);
    if (row.item.type === "userMessage" && row.item.clientId != null && !validId(row.item.clientId)) throw new Error("invalid correlation");
    if (row.item.type === "agentMessage" && (typeof row.item.text !== "string"
      || (row.item.phase !== null && !["commentary", "partial_answer", "final_answer"].includes(row.item.phase as string)))) throw new Error("invalid message");
  }
  return data as Entry[];
}

/** A repeated or oversized continuation fails closed instead of restarting history or looping. */
function nextCursor(result: Record<string, unknown>, previous: string | null): string | null {
  const next = result.nextCursor;
  if (next !== null && (typeof next !== "string" || !next || next.length > 8192 || /[\x00-\x1f]/.test(next) || next === previous)) throw new Error("invalid cursor");
  return next as string | null;
}

/** Project only final agent text, with a shared 16 KiB UTF-8 text budget per returned page. */
function finalReplies(rows: Entry[]) {
  let remaining = 16 * 1024;
  return rows.filter(row => row.item.type === "agentMessage" && row.item.phase === "final_answer").map(row => {
    const bytes = Buffer.from(row.item.text as string);
    const text = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
    remaining -= Buffer.byteLength(text);
    return { itemId: row.item.id, text, phase: "final_answer" as const, truncated: Buffer.byteLength(text) < bytes.length };
  });
}

/** Read one bounded history page; matching proves shared turn membership, never exclusive reply ownership. */
export async function queueMcpReadReply(options: QueueMcpOptions, raw: ReplyInput, signal?: AbortSignal) {
  const unavailable = (code: string) => ({ available: false as const, error: { code } });
  if (!options.allowReplyRead) return unavailable("reply_read_disabled");
  const parsed = z.object(replyInput).strict().safeParse(raw);
  if (!parsed.success) return unavailable("reply_invalid_input");
  const input = parsed.data;
  let position;
  try { position = decodeReplyCursor(input); } catch { return unavailable("reply_invalid_cursor"); }
  const budget = new MessageBudget(20_000, signal);
  const read = async (method: "thread/items/list" | "thread/items/read" | "thread/turns/list", params: Record<string, unknown>) => {
    budget.throwIfEnded();
    const result = await queueMcpRpc(options, method, { threadId: input.threadId, ...params }, budget.signal);
    if (result.status !== "response") throw new Error("read unavailable");
    return result.result;
  };
  try {
    let turnId: string, userItemId: string;
    let replyCursor: string | null = null;
    if (position?.stage === "replies") {
      ({ turnId, userItemId } = position); replyCursor = position.nativeCursor;
      // Position data is forgeable: re-read the exact user item before exposing turn text.
      const validated = entries((await read("thread/items/read", { turnId, itemIds: [userItemId] })).data, 1, turnId);
      if (validated.length !== 1 || validated[0]!.item.id !== userItemId || validated[0]!.item.type !== "userMessage"
        || validated[0]!.item.clientId !== input.clientMessageId) return unavailable("reply_stale_match");
    } else {
      const cursor = position?.nativeCursor ?? null;
      const page = await read("thread/items/list", { cursor, limit: 50, sortDirection: "desc" });
      const rows = entries(page.data, 50), next = nextCursor(page, cursor);
      const matches = rows.filter(row => row.item.type === "userMessage" && row.item.clientId === input.clientMessageId);
      if (matches.length > 1) return { available: true as const, status: "ambiguous" as const, replies: [] };
      if (!matches.length) return { available: true as const, status: "not_observed" as const, reachedHistoryEnd: next === null,
        nextCursor: next ? encodeReplyCursor(input, { stage: "search", nativeCursor: next }) : null, replies: [] };
      ({ turnId } = matches[0]!); userItemId = matches[0]!.item.id;
    }
    const page = await read("thread/items/list", { turnId, cursor: replyCursor, limit: 50, sortDirection: "asc" });
    const rows = entries(page.data, 50, turnId), next = nextCursor(page, replyCursor);
    const turns = await read("thread/turns/list", { limit: 50, sortDirection: "desc", itemsView: "notLoaded" });
    if (!Array.isArray(turns.data) || turns.data.length > 50 || !turns.data.every(t => isRecord(t) && isThreadId(t.id)
      && ["completed", "failed", "interrupted", "inProgress"].includes(t.status as string))) return unavailable("reply_invalid_turns");
    const summaries = turns.data as Record<string, unknown>[];
    if (new Set(summaries.map(t => t.id)).size !== summaries.length) return unavailable("reply_invalid_turns");
    const turn = summaries.find(t => t.id === turnId);
    return { available: true as const, status: "observed" as const, association: "same_turn_not_exclusive" as const,
      threadId: input.threadId, clientMessageId: input.clientMessageId, turnId, userItemId, turnStatus: turn?.status ?? "unverified",
      replies: finalReplies(rows), nextCursor: next ? encodeReplyCursor(input, { stage: "replies", turnId, userItemId, nativeCursor: next }) : null,
      refreshCursor: encodeReplyCursor(input, { stage: "replies", turnId, userItemId, nativeCursor: null }) };
  } catch { return unavailable("reply_read_unavailable"); }
  finally { budget.dispose(); }
}
