import { anthropicErrorBody } from "../claude/outbound";
import { redactSecretString } from "../lib/redact";
import { sseFieldValue } from "../lib/sse-decoder";
import { TRANSLATOR_MAX_SSE_EVENT_BYTES, type TranslatorBudget } from "../lib/translator-budget";
import { UNDECLARED_TOOL_CALL_ERROR_CODE, undeclaredToolCallMessage } from "./responses-undeclared-tool-guard";
import { createSseBlockBuffer, sseDataPayload } from "./sse-payload-rewrite";

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);
const NO_DECLARED_TOOLS: ReadonlySet<string> = new Set();

/** Inline system-message definitions extend an otherwise empty native catalog. */
export function nativeMessagesInlineToolNames(body: Rec): ReadonlySet<string> {
  const definitions = new Set<string>();
  const active = new Set<string>();
  if (!Array.isArray(body.messages)) return active;
  for (const message of body.messages) {
    if (!isRec(message) || message.role !== "system" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRec(block) || !isRec(block.tool)) continue;
      const tool = block.tool;
      if (block.type === "tool_addition" && tool.type === "tool_definition" && isRec(tool.definition)
        && typeof tool.definition.name === "string" && tool.definition.name.length > 0) {
        definitions.add(tool.definition.name);
        active.add(tool.definition.name);
      } else if (tool.type === "tool_reference" && typeof tool.name === "string") {
        if (block.type === "tool_addition" && definitions.has(tool.name)) active.add(tool.name);
        // Like native admission, only a permanent removal withdraws a declaration.
        if (block.type === "tool_removal" && (message.clear_at === undefined || message.clear_at === "never")) active.delete(tool.name);
      }
    }
  }
  return active;
}

/** Inspect only native message content; opaque extension fields do not carry client calls. */
export function nativeMessagesClientToolName(value: unknown, declared: ReadonlySet<string> = NO_DECLARED_TOOLS): string | undefined {
  if (!isRec(value)) return undefined;
  const content = Array.isArray(value.content) ? value.content : [];
  const block = content.find(item => isRec(item) && item.type === "tool_use"
    && (typeof item.name !== "string" || !declared.has(item.name)));
  if (isRec(block)) return typeof block.name === "string" ? block.name : "<unnamed>";
  return undefined;
}

/** Used only when the current native request explicitly declares no client tools. */
export function guardNativeMessagesEmptyToolCatalog(
  source: ReadableStream<Uint8Array>,
  budget: TranslatorBudget,
  onRefusal: (message: string) => void,
  declared: ReadonlySet<string> = NO_DECLARED_TOOLS,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const scope = { kind: "live_transient" as const };
  const buffer = createSseBlockBuffer(budget, bytes => {
    if (bytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) throw new Error("upstream SSE event exceeded the safe limit");
  });
  // Hosted tools share input_json_delta with client tools, but cannot grant client authority.
  const permittedInputBlocks = new Set<number>();
  let queuedBytes = 0;
  let settled = false;
  const releaseQueued = () => {
    budget.releaseRetained(queuedBytes, scope);
    queuedBytes = 0;
  };
  const clear = () => {
    buffer.clear();
    budget.releaseRetained(permittedInputBlocks.size * 32, scope);
    permittedInputBlocks.clear();
  };
  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    const bytes = Buffer.byteLength(text);
    const reservation = budget.reserveTransient(bytes, scope);
    try {
      controller.enqueue(encoder.encode(text));
      reservation.commitRetained();
      queuedBytes += bytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  const cancelReader = (reason?: unknown) => {
    void reader.cancel(reason).catch(() => {});
  };
  const process = (controller: ReadableStreamDefaultController<Uint8Array>, block: string, delimiter: string) => {
    const payload = sseDataPayload(block);
    let data: unknown;
    let terminal = false;
    try { data = payload === null ? undefined : JSON.parse(payload); } catch {
      // The buffered Messages collector concatenates data lines without separators. Inspect
      // that representation too, so an invalid SSE split cannot become a valid folded tool call.
      try { data = payload === null ? undefined : JSON.parse(payload.replace(/\n/g, "")); } catch { /* preserve opaque frames */ }
    }
    if (isRec(data)) {
      const eventName = block.split(/\r\n|\r|\n/).map(line => sseFieldValue(line, "event"))
        .filter(value => value !== null).at(-1)?.trim();
      // Stream clients use the payload type; the buffered collector uses the event field.
      const isEvent = (type: string) => data.type === type || eventName === type;
      terminal = isEvent("message_stop") || isEvent("error");
      let name = isEvent("message_start") ? nativeMessagesClientToolName(data.message, declared) : undefined;
      if (isEvent("content_block_start") && isRec(data.content_block) && data.content_block.type === "tool_use"
        && (typeof data.content_block.name !== "string" || !declared.has(data.content_block.name))) {
        name ??= typeof data.content_block.name === "string" ? data.content_block.name : "<unnamed>";
      }
      const index = typeof data.index === "number" && Number.isSafeInteger(data.index) ? data.index : undefined;
      if (isEvent("content_block_delta") && isRec(data.delta) && data.delta.type === "input_json_delta"
        && (index === undefined || !permittedInputBlocks.has(index))) name ??= "<unnamed>";
      if (name !== undefined) {
        clear();
        const message = redactSecretString(undeclaredToolCallMessage(name));
        onRefusal(message);
        enqueue(controller, `event: error\ndata: ${JSON.stringify(anthropicErrorBody(502, message, "api_error", UNDECLARED_TOOL_CALL_ERROR_CODE))}\n\n`);
        settled = true;
        cancelReader(new Error(message));
        controller.close();
        return;
      }
      if (isEvent("content_block_start") && index !== undefined && isRec(data.content_block)) {
        if (permittedInputBlocks.delete(index)) budget.releaseRetained(32, scope);
        if (data.content_block.type === "server_tool_use" || data.content_block.type === "mcp_tool_use"
          || data.content_block.type === "tool_use" && typeof data.content_block.name === "string" && declared.has(data.content_block.name)) {
          budget.chargeRetained(32, scope);
          permittedInputBlocks.add(index);
        }
      } else if (isEvent("content_block_stop") && index !== undefined && permittedInputBlocks.delete(index)) {
        budget.releaseRetained(32, scope);
      }
    }
    enqueue(controller, block + delimiter);
    if (terminal) {
      settled = true;
      clear();
      cancelReader();
      controller.close();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      releaseQueued();
      if (settled) return;
      try {
        for (;;) {
          const block = buffer.next();
          if (block) {
            buffer.compact();
            process(controller, block.block, block.delimiter);
            return;
          }
          const { done, value } = await reader.read();
          if (settled) return;
          if (!done) {
            buffer.append(decoder.decode(value, { stream: true }));
            continue;
          }
          buffer.append(decoder.decode());
          const tail = buffer.tail();
          if (tail) process(controller, tail, "");
          if (!settled) {
            settled = true;
            clear();
            controller.close();
          }
          return;
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        clear();
        cancelReader(error);
        controller.error(error);
      } finally {
        if (settled) releaseQueued();
      }
    },
    cancel(reason) {
      settled = true;
      clear();
      releaseQueued();
      return reader.cancel(reason);
    },
  });
}
