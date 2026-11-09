import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { MuseMspError, type MuseMspConnection } from "./connection";
import type { MuseMspInbox } from "./inbox";
import type { MuseMspSession } from "./session";
import type { MuseApprovalCapture } from "./approval";
import type { MuseCaptureRendezvous } from "./capture-rendezvous";
import type { MuseResponsesHandoff } from "./responses-handoff";
import { museToolCallEvents } from "./events";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Usage already observed in this segment remains attributable on failure. */
export class MuseSegmentError extends MuseMspError {
  constructor(code: string, readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number }) {
    super(code);
  }
}

/**
 * Consume one Responses segment of an existing MSP turn. The session owner must
 * continue pumping server requests while this segment is parked and terminate the
 * host on errors. This does not create or register an adapter or authenticate HTTP.
 */
export class MuseTurnSegments {
  private readonly seenItems = new Set<string>();
  private readonly seenUsage = new Map<string, string>();
  private closed = false;
  private busy = false;
  constructor(private readonly deps: {
    session: MuseMspSession; turnId: string; inbox: MuseMspInbox; connection: Pick<MuseMspConnection, "respond">;
    capture: MuseApprovalCapture; handoff: MuseResponsesHandoff; rendezvous: MuseCaptureRendezvous;
  }) {}

  async next(parsed: OcxParsedRequest, options: { timeoutMs: number; requestSignal?: AbortSignal; sessionSignal?: AbortSignal; onText?: (text: string) => void }): Promise<AdapterEvent[]> {
    if (this.closed || this.busy) throw new MuseMspError("segment_unavailable");
    this.busy = true;
    let text = "";
    const openText = new Map<string, string>();
    const seenDeltas = new Map<string, string>();
    let inputTokens = 0, outputTokens = 0, usageObserved = false;
    const done = (): AdapterEvent => ({ type: "done", ...(usageObserved ? { usage: {
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    } } : {}) });
    const deadline = Date.now() + options.timeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new MuseMspError("timeout");
        const message = await this.deps.inbox.take(() => true, { timeoutMs: remaining, signal: options.requestSignal });
        if (message.method === "approval/requested" || message.method === "approval/request") {
          if (openText.size) throw new MuseMspError("incomplete_stream_item");
          const approval = this.deps.capture.capture(message);
          if (!approval) throw new MuseMspError("invalid_approval");
          if (approval.requestId !== undefined) await this.deps.connection.respond(approval.requestId, {});
          if (approval.duplicate) continue;
          const call = await this.deps.handoff.admit({ parsed, session: this.deps.session, turnId: this.deps.turnId,
            capture: this.deps.capture, approval, rendezvous: this.deps.rendezvous,
            timeoutMs: remaining, signal: options.sessionSignal, ...(text ? { preToolText: text } : {}) });
          return [...(text && !options.onText ? [{ type: "text_delta" as const, text, phase: "commentary" as const }] : []), ...museToolCallEvents(call), done()];
        }
        if (options.onText && message.method === "item/started") {
          const p = message.params;
          if (!record(p) || p.sessionId !== this.deps.session.sessionId || !record(p.item)) throw new MuseMspError("invalid_item");
          const item = p.item;
          if (item.kind === "agentMessage") {
            if (item.turnId !== this.deps.turnId || typeof item.itemId !== "string" || !item.itemId || openText.size > 0 || this.seenItems.has(item.itemId) ||
                (item.text !== undefined && item.text !== "")) throw new MuseMspError("invalid_stream_item");
            openText.set(item.itemId, "");
          }
          continue;
        }
        if (options.onText && message.method === "item/delta") {
          const p = message.params;
          if (!record(p) || p.sessionId !== this.deps.session.sessionId || typeof p.itemId !== "string") throw new MuseMspError("invalid_stream_item");
          if (!openText.has(p.itemId) || (p.field !== undefined && p.field !== "text")) continue;
          if (typeof p.delta !== "string" || typeof p.viewCursor !== "string" || !p.viewCursor) throw new MuseMspError("invalid_stream_item");
          const signature = JSON.stringify([p.itemId, p.delta]);
          const seen = seenDeltas.get(p.viewCursor);
          if (seen !== undefined) { if (seen !== signature) throw new MuseMspError("invalid_stream_item"); continue; }
          if (seenDeltas.size >= 4096) throw new MuseMspError("output_too_large");
          const previous = openText.get(p.itemId)!;
          if (Buffer.byteLength(text) + Buffer.byteLength(previous) + Buffer.byteLength(p.delta) > 4 * 1024 * 1024) throw new MuseMspError("output_too_large");
          seenDeltas.set(p.viewCursor, signature); openText.set(p.itemId, previous + p.delta);
          if (p.delta) options.onText(p.delta);
          continue;
        }
        if (message.method === "session/tokenUsage") {
          const params = message.params;
          if (!record(params) || params.sessionId !== this.deps.session.sessionId || params.turnId !== this.deps.turnId ||
              typeof params.viewCursor !== "string" || !params.viewCursor || !Number.isSafeInteger(params.promptTokens) ||
              !Number.isSafeInteger(params.totalTokens) || (params.promptTokens as number) < 0 ||
              (params.totalTokens as number) < (params.promptTokens as number)) throw new MuseMspError("invalid_usage");
          const signature = JSON.stringify([params.promptTokens, params.totalTokens]);
          const previous = this.seenUsage.get(params.viewCursor);
          if (previous !== undefined) {
            if (previous !== signature) throw new MuseMspError("invalid_usage");
            continue;
          }
          if (this.seenUsage.size >= 1024) throw new MuseMspError("invalid_usage");
          this.seenUsage.set(params.viewCursor, signature);
          inputTokens += params.promptTokens as number;
          outputTokens += (params.totalTokens as number) - (params.promptTokens as number);
          if (!Number.isSafeInteger(inputTokens + outputTokens)) throw new MuseMspError("invalid_usage");
          usageObserved = true;
          continue;
        }
        if (message.method === "item/completed") {
          const params = message.params;
          if (!record(params) || params.sessionId !== this.deps.session.sessionId || !record(params.item)) throw new MuseMspError("invalid_item");
          const item = params.item;
          if (item.turnId !== this.deps.turnId) throw new MuseMspError("invalid_item");
          if (item.kind !== "agentMessage") continue;
          if (typeof item.itemId !== "string" || !item.itemId || typeof item.text !== "string" || item.incomplete === true) throw new MuseMspError("invalid_item");
          if (this.seenItems.has(item.itemId)) continue;
          if (this.seenItems.size >= 256 || Buffer.byteLength(text) + Buffer.byteLength(item.text) > 4 * 1024 * 1024) throw new MuseMspError("output_too_large");
          if (options.onText) {
            const delivered = openText.get(item.itemId) ?? "";
            if (!item.text.startsWith(delivered)) throw new MuseMspError("stream_item_mismatch");
            const suffix = item.text.slice(delivered.length);
            if (suffix) options.onText(suffix);
            openText.delete(item.itemId);
          }
          this.seenItems.add(item.itemId); text += item.text;
          continue;
        }
        if (message.method === "turn/unqueued") {
          if (!record(message.params) || message.params.sessionId !== this.deps.session.sessionId || message.params.turnId !== this.deps.turnId) throw new MuseMspError("invalid_turn_terminal");
          throw new MuseMspError("turn_unqueued");
        }
        if (message.method === "turn/completed") {
          if (openText.size) throw new MuseMspError("incomplete_stream_item");
          this.deps.session.finishTurn(message);
          this.closed = true;
          if (!record(message.params) || message.params.terminal !== "completed") throw new MuseMspError("turn_failed");
          return [...(text && !options.onText ? [{ type: "text_delta" as const, text }] : []), done()];
        }
        // Notifications without a known payload are ignored; unknown server requests are unsafe.
        if ("id" in message) throw new MuseMspError("unsupported_server_request");
      }
    } catch (error) {
      this.closed = true;
      if (usageObserved) throw new MuseSegmentError(error instanceof MuseMspError ? error.code : "host_error",
        { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      throw error;
    }
    finally { this.busy = false; }
  }
}
