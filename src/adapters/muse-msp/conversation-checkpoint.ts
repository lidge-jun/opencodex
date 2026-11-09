import type { OcxParsedRequest } from "../../types";
import { MuseMspError } from "./connection";
import { museConversationDigest } from "./history";
import { museContinuationOwner } from "./owner";

/** The client supplied different history; an old retained session must not be reused. */
export class MuseConversationHistoryChanged extends MuseMspError {
  constructor() { super("unavailable_conversation"); }
}

/**
 * Experimental checkpoint for a completed response, derived from a trusted
 * rendering of its exact client-visible history. No process or route is opened.
 */
export class MuseConversationCheckpoint {
  private readonly owner: string;
  private readonly digest: string;
  private consumed = false;
  private committing = false;
  constructor(completed: OcxParsedRequest) {
    const owner = museContinuationOwner(completed), last = completed.context.messages.at(-1);
    if (!owner || !last || last.role !== "assistant" || !last.content.length ||
        last.content.some(part => part.type !== "text") || (last.phase !== undefined && last.phase !== "final_answer")) {
      throw new MuseMspError("invalid_conversation_checkpoint");
    }
    this.owner = owner;
    this.digest = museConversationDigest(completed.context, completed.options);
  }

  /** Validate the entire previous history before returning the next plain-text user message. */
  next(parsed: OcxParsedRequest, beforeCommit?: (userText: string) => void): string {
    const messages = parsed.context.messages, last = messages.at(-1);
    if (this.consumed || this.committing || museContinuationOwner(parsed) !== this.owner || !last || last.role !== "user" || typeof last.content !== "string" || !last.content ||
        Buffer.byteLength(last.content) > 4 * 1024 * 1024) {
      throw new MuseMspError("unavailable_conversation");
    }
    if (museConversationDigest({ ...parsed.context, messages: messages.slice(0, -1) }, parsed.options) !== this.digest)
      throw new MuseConversationHistoryChanged();
    const userText = last.content;
    this.committing = true;
    try { beforeCommit?.(userText); } finally { this.committing = false; }
    this.consumed = true;
    return userText;
  }
}
