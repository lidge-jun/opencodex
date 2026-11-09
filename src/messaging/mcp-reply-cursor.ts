import { z } from "zod";
import { isThreadId } from "./types";

const id = z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/);
const thread = z.string().refine(isThreadId, "Use an exact UUID");
const nativeCursor = z.string().min(1).max(8192).regex(/^[^\x00-\x1f]+$/);
export const replyInput = { threadId: thread, clientMessageId: thread, cursor: z.string().max(16384).optional() };
const scope = { v: z.literal(1), threadId: thread, clientMessageId: thread };
const cursorSchema = z.discriminatedUnion("stage", [
  z.object({ ...scope, stage: z.literal("search"), nativeCursor }).strict(),
  z.object({ ...scope, stage: z.literal("replies"), turnId: thread, userItemId: id, nativeCursor: nativeCursor.nullable() }).strict(),
]);
export type ReplyCursor = z.infer<typeof cursorSchema>;
export type ReplyInput = { threadId: string; clientMessageId: string; cursor?: string };

/** Decode caller-owned position data, never authority; bind it to both requested identifiers. */
export function decodeReplyCursor(input: ReplyInput): ReplyCursor | null {
  if (input.cursor === undefined) return null;
  if (!input.cursor || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error("invalid cursor");
  const bytes = Buffer.from(input.cursor, "base64url");
  if (bytes.toString("base64url") !== input.cursor) throw new Error("invalid cursor");
  const cursor = cursorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (cursor.threadId !== input.threadId || cursor.clientMessageId !== input.clientMessageId) throw new Error("cursor scope mismatch");
  return cursor;
}

/** Continuations contain identifiers and bounded native cursors, never conversation text. */
export function encodeReplyCursor(input: ReplyInput, position: Omit<Extract<ReplyCursor, { stage: "search" }>, "v" | "threadId" | "clientMessageId">
  | Omit<Extract<ReplyCursor, { stage: "replies" }>, "v" | "threadId" | "clientMessageId">): string {
  const data = cursorSchema.parse({ v: 1, threadId: input.threadId, clientMessageId: input.clientMessageId, ...position });
  const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
  if (encoded.length > 16384) throw new Error("cursor limit");
  return encoded;
}
