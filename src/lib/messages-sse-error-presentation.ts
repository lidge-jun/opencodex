import { markProxyError, UNDECLARED_TOOL_CALL_MESSAGE } from "./client-error-body";
import { messagesOverflowPresentation, messagesSseErrorOverflowPresentation, ownedAnthropicErrorPayload } from "./messages-error-body";
import { sseFieldValue } from "./sse-decoder";

export const MESSAGES_SSE_ERROR_HOLD_BYTES = 1024 * 1024;
export type MessagesSseLocalOrigin = "guard" | "eof" | "stop-error" | "stall" | "cap" | "read";
type Rec = Record<string, unknown>;
const record = (value: unknown): Rec => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const encoder = new TextEncoder();
const overLimit = markProxyError({ message: "The provider stream reported an error." });
export function messagesSseErrorPayload(data: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { parsed = undefined; }
  const body = record(parsed), nested = body.error;
  // A null, scalar or array error member carries no fields; read the top-level ones, as the buffered paths do.
  const error = nested !== null && typeof nested === "object" && !Array.isArray(nested) ? nested as Rec : body;
  return JSON.stringify(ownedAnthropicErrorPayload({ status: 502,
    type: typeof error.type === "string" ? error.type : "api_error",
    code: typeof error.code === "string" ? error.code : undefined,
    evidence: { status: 502, type: typeof error.type === "string" ? error.type : undefined,
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : undefined },
    overflow: messagesSseErrorOverflowPresentation(data, parsed),
  }));
}
export function messagesSseOversizePayload(): string {
  return JSON.stringify(ownedAnthropicErrorPayload({ status: 502, type: "api_error", evidence: { status: 502 }, localError: overLimit }));
}
const localMessages: Readonly<Record<MessagesSseLocalOrigin, string>> = {
  guard: UNDECLARED_TOOL_CALL_MESSAGE,
  eof: "anthropic passthrough upstream stream ended before message_stop",
  "stop-error": 'upstream ended the turn with stop_reason "error"',
  stall: "anthropic passthrough body stalled: no upstream bytes arrived before the configured timeout",
  cap: "anthropic passthrough body exceeded the safe limit",
  read: "anthropic passthrough upstream stream failed",
};
export function messagesSseLocalFrame(origin: MessagesSseLocalOrigin, originalMessage: string): Uint8Array {
  const local = markProxyError({ message: localMessages[origin] }, origin === "stall" ? "body_stall" : origin === "cap" ? "body_overflow" : undefined);
  const payload = ownedAnthropicErrorPayload({ status: 502, type: origin === "stall" ? "timeout_error" : "api_error",
    code: origin === "guard" ? "undeclared_tool_call" : undefined, evidence: { status: 502 },
    overflow: messagesOverflowPresentation(originalMessage), localError: local });
  return encoder.encode(`${origin === "guard" ? "" : "\n\n"}event: error\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** The echo flag comes from the original field order, never the parsed payload. */
export function messagesSseEchoRenamedError(frame: string): boolean {
  const lines = frame.split(/\r\n|\r|\n/).filter(line => line !== "" && !line.startsWith(":"));
  return sseFieldValue(lines[0] ?? "", "event") === "error"
    && lines.map(line => sseFieldValue(line, "event")).filter(value => value !== null).at(-1) === "error";
}
export type MessagesSseFrameOrigin = { echoRenamedError: true } | { client: Uint8Array };
/** One request's complete-frame handoffs. Input bytes alone can never create an origin. */
export class MessagesSseFrameContext {
  private readonly frames = new WeakMap<Uint8Array, MessagesSseFrameOrigin>();
  register(bytes: Uint8Array, origin: MessagesSseFrameOrigin): Uint8Array { this.frames.set(bytes, origin); return bytes; }
  take(bytes: Uint8Array): MessagesSseFrameOrigin | undefined {
    const origin = this.frames.get(bytes); this.frames.delete(bytes); return origin;
  }
}
export interface MessagesSseFrameHooks {
  input(bytes: Uint8Array, empty: boolean, tailLineFeed?: boolean, continuation?: boolean): void;
  output(original: string, bytes: Uint8Array): void;
  dispose(): void;
}
/** Only a dedicated, complete producer frame may traverse a buffering stage. */
export function messagesSseFrameHooks(context: MessagesSseFrameContext): MessagesSseFrameHooks {
  let pending: { digest: string; origin: MessagesSseFrameOrigin; repair?: boolean } | undefined;
  const digest = (value: string | Uint8Array, prefix = "") => new Bun.CryptoHasher("sha256").update(prefix).update(value).digest("hex");
  const broken = () => new Error("The proxy could not reach or read the provider.");
  return {
    input(bytes, empty, tailLineFeed = false, continuation = false) {
      const origin = context.take(bytes);
      if (!origin) return;
      if (pending) throw broken();
      if ("client" in origin && bytes[0] === 10 && bytes[1] === 10) {
        const prefix = tailLineFeed || empty && continuation ? "\n" : "";
        pending = { digest: digest(bytes.subarray(2), prefix),
          origin: { client: encoder.encode(prefix + new TextDecoder().decode(origin.client.subarray(2))) },
          repair: !(empty && continuation) };
      } else {
        if (!empty) throw broken();
        pending = { digest: digest(bytes), origin };
      }
    },
    output(original, bytes) {
      if (!pending) return;
      if (pending.repair) { pending.repair = false; return; }
      if (digest(original) !== pending.digest) { pending = undefined; throw broken(); }
      context.register(bytes, pending.origin); pending = undefined;
    },
    dispose() { pending = undefined; },
  };
}
