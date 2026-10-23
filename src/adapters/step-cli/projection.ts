import type { OcxParsedRequest, OcxUsage } from "../../types";
import type { IncomingMeta } from "../base";
import { buildSystemPrompt } from "../coding-agent/protocol";
import { CODING_AGENT_TOOL_LIMITS } from "../coding-agent/tool-catalog";
import { STEP_CLI_CONTINUATION_KEY, STEP_CLI_TOOL_SERVER } from "./constants";
import type { StepConversationRef } from "./session-pool";

/**
 * Everything between "what the client sent" and "what the CLI is told".
 *
 * Kept apart from the transport on purpose: these are pure functions over a parsed request, so the
 * awkward parts of this route — a tool result carrying an image, a model id with a namespace, an
 * effort that has to become a token budget — can be read and tested without a session in the picture.
 */

/** `providerState` slot carrying the conversation handle between requests. */
export type StepProviderState = { [STEP_CLI_CONTINUATION_KEY]: { handle: string; sessionId: string } };

/**
 * How long a conversation's process survives without traffic.
 *
 * Long enough that a Codex thread's pauses between turns do not tear the conversation down, short
 * enough that an abandoned thread does not leave a StepCode process running.
 */

export function continuationFor(ref: StepConversationRef, sessionId: string | undefined): StepProviderState | undefined {
  if (!ref) return undefined;
  return { [STEP_CLI_CONTINUATION_KEY]: { handle: ref.handle, sessionId: sessionId ?? ref.sessionId } };
}

/** The newest tool result in the request, with the call it answers. */

/** A `data:` URL split into the base64 payload and media type StepCode's image block expects. */

/** A `data:` URL split into the base64 payload and media type StepCode's image block expects. */
export function parseInlineImageDataUrl(imageUrl: string): { data: string; mimeType: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(imageUrl);
  if (!match) return undefined;
  return { mimeType: match[1]!, data: match[2]! };
}

/**
 * Project a client tool result into the content blocks StepCode's SDK tool accepts.
 *
 * A tool result is not necessarily text. Codex's `view_image` returns an image part, and collapsing
 * that to an empty text block is the same misleading-empty-result failure the wrong-call path already
 * had: the model reports a tool that "returned nothing" instead of saying it could not read the image.
 * Inline `data:` images are forwarded; a remote URL cannot be, so it is replaced by a note the model can
 * act on rather than dropped in silence.
 */

/**
 * Project a client tool result into the content blocks StepCode's SDK tool accepts.
 *
 * A tool result is not necessarily text. Codex's `view_image` returns an image part, and collapsing
 * that to an empty text block is the same misleading-empty-result failure the wrong-call path already
 * had: the model reports a tool that "returned nothing" instead of saying it could not read the image.
 * Inline `data:` images are forwarded; a remote URL cannot be, so it is replaced by a note the model can
 * act on rather than dropped in silence.
 */
export function projectToolResultContent(
  raw: string | readonly unknown[],
): Array<Record<string, unknown>> {
  if (typeof raw === "string") return raw.length > 0 ? [{ type: "text", text: raw }] : [];
  const blocks: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const part of raw) {
    const block = asRecord(part);
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && typeof block.imageUrl === "string") {
      const inline = parseInlineImageDataUrl(block.imageUrl);
      if (inline) {
        blocks.push({ type: "image", data: inline.data, mimeType: inline.mimeType });
        continue;
      }
      notes.push(`an image at ${block.imageUrl} could not be inlined; fetch it yourself if you need it`);
      continue;
    }
    notes.push(`a ${typeof block.type === "string" ? block.type : "unknown"} result part was dropped`);
  }
  for (const note of notes) blocks.push({ type: "text", text: note });
  if (blocks.length === 0) {
    return [{ type: "text", text: "the tool returned no readable content" }];
  }
  return blocks;
}

export function latestToolResult(
  parsed: OcxParsedRequest,
): { content: readonly unknown[]; isError?: boolean; toolCallId: string } | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "toolResult") continue;
    return {
      content: projectToolResultContent(message.content),
      toolCallId: message.toolCallId,
      ...(message.isError ? { isError: true } : {}),
    };
  }
  return undefined;
}

export function toUsage(usage: Record<string, unknown>): OcxUsage | undefined {
  const input = typeof usage.input === "number" ? usage.input : undefined;
  const output = typeof usage.output === "number" ? usage.output : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(typeof usage.cacheRead === "number" ? { cachedInputTokens: usage.cacheRead } : {}),
  };
}

/**
 * StepCode model ids carry no provider prefix; the CLI owns its own default provider.
 */

/**
 * StepCode model ids carry no provider prefix; the CLI owns its own default provider.
 */
export function stepModelId(modelId: string): string {
  return modelId.startsWith(`${STEP_CLI_TOOL_SERVER}/`)
    ? modelId.slice(STEP_CLI_TOOL_SERVER.length + 1)
    : modelId;
}

/**
 * StepCode's per-query thinking control is a token budget, so an effort has to be converted.
 *
 * The mapping is deliberately lossy and the registry only advertises the three rungs Step actually
 * serves, so a client never believes it chose a depth it did not.
 */

/**
 * StepCode's per-query thinking control is a token budget, so an effort has to be converted.
 *
 * The mapping is deliberately lossy and the registry only advertises the three rungs Step actually
 * serves, so a client never believes it chose a depth it did not.
 */
export function stepThinkingTokens(parsed: OcxParsedRequest): number | undefined {
  const effort = parsed.options.reasoning;
  if (typeof effort !== "string" || effort === "none") return undefined;
  const table: Record<string, number> = {
    minimal: 1_024,
    low: 4_096,
    medium: 16_384,
    high: 32_768,
    xhigh: 65_536,
    max: 65_536,
  };
  return table[effort] ?? table.high!;
}

/**
 * Fold the caller's instructions into the one user message this hop can carry.
 *
 * StepCode cannot replace its session system prompt, so its own coding instructions stay in front of
 * the model's answers. Prepending the client's own instructions keeps the turn answerable under the
 * contract the client believes it set.
 */

/**
 * Fold the caller's instructions into the one user message this hop can carry.
 *
 * StepCode cannot replace its session system prompt, so its own coding instructions stay in front of
 * the model's answers. Prepending the client's own instructions keeps the turn answerable under the
 * contract the client believes it set.
 */
export function composePrompt(parsed: OcxParsedRequest, userText: string): string {
  const system = buildSystemPrompt(parsed);
  return system ? `${system}\n\n${userText}` : userText;
}

/** Resolves when the client aborts, so a turn in flight does not outlive its request. */
export function abortSignal(incoming: IncomingMeta): Promise<void> {
  const signal = incoming.abortSignal;
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Translate a transport failure into the actionable error an operator can act on. */

/**
 * The text StepCode should be asked for on this turn.
 *
 * Only the final user message crosses `query.input`; earlier turns live in the process' session,
 * because the wire reduces every message to text and images.
 */
export function pendingUserText(parsed: OcxParsedRequest): string | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "user") continue;
    if (!Array.isArray(message.content)) {
      return typeof message.content === "string" && message.content.length > 0
        ? message.content
        : undefined;
    }
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => (part as { text: string }).text)
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * Refuse image input the way the Qoder and Claude Code rows do.
 *
 * `query.input` does carry an image block to the model, but this route publishes text-only models,
 * and an image the harness silently drops produces a confident answer to the wrong question. An
 * operator with the vision sidecar on the request path still gets pictures captioned into text.
 */
export function hasImageInput(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === "image"),
  );
}

/**
 * Identify the conversation this request belongs to.
 *
 * StepCode keeps a conversation only inside one process, so every request of a Codex thread has to
 * land on the same session. The thread identity is what Codex already sends on EVERY request —
 * `thread-id`, then the session-affinity headers — which is the resolution `devin`, `zed`, `cursor`
 * and `google` use, and it works on the first request of a conversation. `previous_response_id` and
 * the proxy's continuation store are only fallbacks: depending on persisted provider state would mean
 * a conversation silently restarting whenever that store misses an entry.
 */
